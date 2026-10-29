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

export async function historico(): Promise<Turno[]> {
  const { data, error } = await supabase
    .from("nina_mensagens")
    .select("papel, conteudo")
    .neq("origem", "comando")
    .order("id", { ascending: false })
    .limit(HISTORICO_LIMITE);
  if (error) throw error;
  const turnos = (data ?? []).reverse().map((m: { papel: "user" | "assistant"; conteudo: string }) => ({
    role: m.papel,
    content: m.conteudo,
  }));
  // A API exige começar por uma fala do usuário.
  while (turnos.length && turnos[0].role !== "user") turnos.shift();
  return turnos;
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
