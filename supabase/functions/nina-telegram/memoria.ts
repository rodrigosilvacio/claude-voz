// Memória da Nina: histórico, memórias estruturadas e busca semântica.
import { segredo, supabase } from "./config.ts";
import type { Extracao, Turno } from "./cerebro.ts";

const MODELO_EMBEDDING = "text-embedding-3-small";
// Mensagens recentes que entram inteiras no contexto (o resto vive nas memórias).
const HISTORICO_LIMITE = 40;

export interface Memoria {
  id: number;
  tipo: string;
  conteudo: string;
  prazo: string | null;
  criado_em: string;
}

export async function embedding(texto: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${segredo("OPENAI_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO_EMBEDDING, input: texto.slice(0, 20_000) }),
  });
  if (!res.ok) throw new Error(`Embedding falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { data } = await res.json() as { data: { embedding: number[] }[] };
  return data[0].embedding;
}

export async function salvarMensagem(
  papel: "user" | "assistant",
  conteudo: string,
  origem: "texto" | "voz" | "comando",
  extra: { telegram_message_id?: number; latencias?: unknown; uso?: unknown } = {},
): Promise<number> {
  const { data, error } = await supabase
    .from("nina_mensagens")
    .insert({ papel, conteudo, origem, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Últimas mensagens, e o id da mais antiga delas: trechos anteriores a ele
// só entram no contexto pela busca no histórico.
export async function historico(): Promise<{ turnos: Turno[]; menorId: number }> {
  const { data, error } = await supabase
    .from("nina_mensagens")
    .select("id, papel, conteudo")
    .neq("origem", "comando")
    .order("id", { ascending: false })
    .limit(HISTORICO_LIMITE);
  if (error) throw error;
  const linhas = (data ?? []).reverse() as { id: number; papel: "user" | "assistant"; conteudo: string }[];
  // A API exige começar por uma fala do usuário.
  while (linhas.length && linhas[0].papel !== "user") linhas.shift();
  return {
    turnos: linhas.map((m) => ({ role: m.papel, content: m.conteudo })),
    menorId: linhas[0]?.id ?? Number.MAX_SAFE_INTEGER,
  };
}

export interface Trecho {
  texto: string;
  criado_em: string;
}

const dataSP = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "long" });

export function formatarTrecho(t: Trecho): string {
  return `Conversa de ${dataSP(t.criado_em)}:\n${t.texto}`;
}

// Camada 1: trechos antigos parecidos com a mensagem atual.
export async function trechosRelevantes(vetor: number[] | null, antesDe: number): Promise<Trecho[]> {
  if (!vetor) return [];
  const { data, error } = await supabase.rpc("nina_buscar_trocas", {
    p_embedding: JSON.stringify(vetor),
    p_antes_de_mensagem: antesDe,
    p_limite: 4,
  });
  if (error) throw error;
  // Corte mais alto que o das memórias: um trecho inteiro fora de assunto
  // atrapalha mais que uma frase solta.
  return (data ?? []).filter((t: { similaridade: number }) => t.similaridade > 0.35);
}

// Camada 2: pesquisa pedida pela Nina via ferramenta.
export async function pesquisarHistorico(
  filtros: { consulta?: string; de?: string; ate?: string; termo_exato?: string },
): Promise<string> {
  const vetor = filtros.consulta ? await embedding(filtros.consulta) : null;
  // Datas chegam como AAAA-MM-DD no fuso de São Paulo; "ate" é inclusivo.
  const inicio = (d?: string) => (d ? `${d}T00:00:00-03:00` : null);
  const fimInclusivo = (d?: string) => {
    if (!d) return null;
    const dia = new Date(`${d}T00:00:00-03:00`);
    dia.setUTCDate(dia.getUTCDate() + 1);
    return dia.toISOString();
  };
  const { data, error } = await supabase.rpc("nina_pesquisar_historico", {
    p_embedding: vetor ? JSON.stringify(vetor) : null,
    p_de: inicio(filtros.de),
    p_ate: fimInclusivo(filtros.ate),
    p_termo: filtros.termo_exato?.trim() || null,
    p_limite: 8,
  });
  if (error) throw error;
  if (!data?.length) return "Nada encontrado no histórico com esses filtros.";
  return (data as Trecho[]).map(formatarTrecho).join("\n\n---\n\n");
}

const textoTroca = (fala: string, resposta: string) => `Rodrigo: ${fala}\nNina: ${resposta}`;

export async function indexarTroca(
  mensagemUserId: number,
  mensagemNinaId: number,
  fala: string,
  resposta: string,
  criadoEm: string,
): Promise<void> {
  const texto = textoTroca(fala, resposta);
  let vetor: number[] | null = null;
  try {
    vetor = await embedding(texto);
  } catch (e) {
    console.error("troca salva sem embedding:", e);
  }
  const { error } = await supabase.from("nina_trocas").upsert({
    mensagem_user_id: mensagemUserId,
    mensagem_nina_id: mensagemNinaId,
    texto,
    embedding: vetor ? JSON.stringify(vetor) : null,
    criado_em: criadoEm,
  }, { onConflict: "mensagem_user_id" });
  if (error) console.error("erro ao indexar troca:", error);
}

// Indexa o que foi conversado antes do histórico pesquisável existir.
export async function indexarPendentes(): Promise<number> {
  let total = 0;
  // Limite de rodadas: se uma troca falhar sempre, ela volta como pendente e
  // o laço não pode girar para sempre.
  for (let rodada = 0; rodada < 40; rodada++) {
    const { data, error } = await supabase.rpc("nina_trocas_pendentes", { p_limite: 50 });
    if (error) throw error;
    if (!data?.length) return total;
    for (const p of data as {
      mensagem_user_id: number;
      mensagem_nina_id: number;
      fala: string;
      resposta: string;
      criado_em: string;
    }[]) {
      await indexarTroca(p.mensagem_user_id, p.mensagem_nina_id, p.fala, p.resposta, p.criado_em);
      total++;
    }
  }
  return total;
}

export async function memoriasAtivas(tipos: string[], limite = 30): Promise<Memoria[]> {
  const { data, error } = await supabase
    .from("nina_memorias")
    .select("id, tipo, conteudo, prazo, criado_em")
    .eq("status", "ativa")
    .in("tipo", tipos)
    .order("atualizado_em", { ascending: false })
    .limit(limite);
  if (error) throw error;
  return data ?? [];
}

export async function memoriasRelevantes(vetor: number[] | null, limite = 12): Promise<Memoria[]> {
  if (!vetor) return [];
  const { data, error } = await supabase.rpc("nina_buscar_memorias", {
    p_embedding: JSON.stringify(vetor),
    p_limite: limite,
  });
  if (error) throw error;
  // Abaixo disso a "memória relevante" costuma ser ruído.
  return (data ?? []).filter((m: { similaridade: number }) => m.similaridade > 0.25);
}

export function formatar(m: Memoria): string {
  const data = new Date(m.criado_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return `${m.conteudo} (registrado em ${data}${m.prazo ? `, prazo ${m.prazo}` : ""})`;
}

export async function aplicarExtracao(ex: Extracao, origemId: number): Promise<void> {
  const agora = new Date().toISOString();
  for (const nova of ex.novas) {
    let vetor: number[] | null = null;
    try {
      vetor = await embedding(nova.conteudo);
    } catch (e) {
      console.error("memória salva sem embedding:", e);
    }
    const { error } = await supabase.from("nina_memorias").insert({
      tipo: nova.tipo,
      conteudo: nova.conteudo,
      prazo: nova.prazo,
      embedding: vetor ? JSON.stringify(vetor) : null,
      origem_mensagem_id: origemId,
    });
    if (error) console.error("erro ao salvar memória:", error);
  }
  for (const at of ex.atualizadas) {
    let vetor: number[] | null = null;
    try {
      vetor = await embedding(at.conteudo);
    } catch (e) {
      console.error("memória atualizada sem embedding:", e);
    }
    const { error } = await supabase
      .from("nina_memorias")
      .update({ conteudo: at.conteudo, atualizado_em: agora, ...(vetor ? { embedding: JSON.stringify(vetor) } : {}) })
      .eq("id", at.id);
    if (error) console.error("erro ao atualizar memória:", error);
  }
  if (ex.resolvidas.length) {
    const { error } = await supabase
      .from("nina_memorias")
      .update({ status: "resolvida", atualizado_em: agora })
      .in("id", ex.resolvidas);
    if (error) console.error("erro ao resolver memórias:", error);
  }
}
