// Chamadas ao Claude: a resposta da Nina e a extração de memórias da troca.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { segredo } from "./config.ts";
import { NINA_SYSTEM } from "./prompt.ts";

let cliente: Anthropic | null = null;
const anthropic = () => (cliente ??= new Anthropic({ apiKey: segredo("ANTHROPIC_API_KEY") }));

export type Turno = { role: "user" | "assistant"; content: string };

export interface Resposta {
  texto: string;
  uso: unknown;
}

// Camada 2 do histórico: a Nina pesquisa conversas antigas quando o Rodrigo
// pede para lembrar de algo ou quando ela precisa de um detalhe que não está
// no contexto.
const FERRAMENTA_HISTORICO = {
  name: "pesquisar_historico",
  description:
    "Pesquisa o histórico completo de conversas com o Rodrigo. Use quando ele pedir para lembrar de algo " +
    "dito antes (\"o que eu te falei sobre...\", \"o que você me aconselhou...\", \"semana passada...\") ou " +
    "quando você precisar de um detalhe de conversa antiga que não está no contexto. Combine os filtros: " +
    "consulta para buscar por assunto, de e ate para um período, termo_exato para um nome ou palavra específica.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      consulta: { type: "string", description: "Assunto a buscar, em linguagem natural." },
      de: { type: "string", description: "Data inicial AAAA-MM-DD, inclusiva, no fuso de São Paulo." },
      ate: { type: "string", description: "Data final AAAA-MM-DD, inclusiva, no fuso de São Paulo." },
      termo_exato: { type: "string", description: "Nome ou palavra que precisa aparecer no texto." },
    },
    required: [],
  },
};

// Quantas pesquisas a Nina pode encadear antes de ter que responder.
const MAX_PESQUISAS = 3;

export type Pesquisar = (filtros: Record<string, string>) => Promise<string>;

// Effort baixo segura a latência da conversa por voz; dá para subir pela
// nina_config (esforco_conversa) sem novo deploy.
export async function responder(
  historico: Turno[],
  contexto: string,
  modelo: string,
  esforco: "low" | "medium" | "high",
  pesquisar: Pesquisar,
): Promise<Resposta> {
  // Contexto da memória como mensagem de sistema depois da última fala do
  // Rodrigo: não quebra o cache do histórico e tem autoridade de operador.
  const mensagens: Anthropic.Beta.BetaMessageParam[] = [...historico, { role: "system", content: contexto }];
  const usos: unknown[] = [];
  let pesquisas = 0;

  // Uma rodada a mais que o limite: depois do aviso de limite, a Nina responde.
  for (let rodada = 0; rodada <= MAX_PESQUISAS + 1; rodada++) {
    const resposta = await anthropic().beta.messages.create({
      model: modelo,
      max_tokens: 8000,
      // Se um classificador de segurança recusar (falso positivo em tema pessoal
      // pesado), a própria API refaz no modelo de reserva recomendado.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: esforco },
      // Prompt fixo em cache; histórico só cresce no fim, então o prefixo também
      // é reaproveitado entre mensagens.
      cache_control: { type: "ephemeral" },
      system: NINA_SYSTEM,
      // A ferramenta fica sempre declarada: o histórico do turno já tem blocos
      // de tool_use, e trocar a lista quebraria o cache.
      tools: [FERRAMENTA_HISTORICO],
      messages: mensagens,
    });
    usos.push(resposta.usage);

    if (resposta.stop_reason === "refusal") {
      return {
        texto: "Não consigo responder isso desse jeito. Me conta de outro ângulo o que está acontecendo.",
        uso: usos,
      };
    }

    const chamadas = resposta.content.filter((b) => b.type === "tool_use");
    if (resposta.stop_reason !== "tool_use" || !chamadas.length) {
      const texto = resposta.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      return { texto: texto || "Travei aqui. Fala de novo?", uso: usos };
    }

    // Conteúdo devolvido sem alteração, inclusive os blocos de raciocínio.
    mensagens.push({ role: "assistant", content: resposta.content });
    const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const chamada of chamadas) {
      if (chamada.type !== "tool_use") continue;
      pesquisas++;
      if (pesquisas > MAX_PESQUISAS) {
        resultados.push({
          type: "tool_result",
          tool_use_id: chamada.id,
          content: "Limite de pesquisas desta resposta atingido. Responda agora com o que você já tem.",
          is_error: true,
        });
        continue;
      }
      try {
        resultados.push({
          type: "tool_result",
          tool_use_id: chamada.id,
          content: await pesquisar(chamada.input as Record<string, string>),
        });
      } catch (e) {
        resultados.push({
          type: "tool_result",
          tool_use_id: chamada.id,
          content: `A pesquisa falhou: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        });
      }
    }
    mensagens.push({ role: "user", content: resultados });
  }
  return { texto: "Me perdi procurando no nosso histórico. Pergunta de novo de um jeito mais direto?", uso: usos };
}

export interface Extracao {
  novas: { tipo: string; conteudo: string; prazo: string | null }[];
  resolvidas: number[];
  atualizadas: { id: number; conteudo: string }[];
  novo_tom: string | null;
}

const ESQUEMA_EXTRACAO = {
  type: "object",
  additionalProperties: false,
  required: ["novas", "resolvidas", "atualizadas", "novo_tom"],
  properties: {
    novas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "conteudo", "prazo"],
        properties: {
          tipo: { type: "string", enum: ["fato", "pessoa", "decisao", "compromisso", "tema_aberto", "padrao"] },
          conteudo: { type: "string" },
          prazo: { type: ["string", "null"], description: "AAAA-MM-DD quando houver prazo explícito" },
        },
      },
    },
    resolvidas: { type: "array", items: { type: "integer" } },
    atualizadas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "conteudo"],
        properties: { id: { type: "integer" }, conteudo: { type: "string" } },
      },
    },
    novo_tom: { type: ["string", "null"] },
  },
};

const INSTRUCAO_EXTRACAO = `Você mantém a memória de longo prazo da Nina, conselheira pessoal do Rodrigo Silva (CIO da Nitro). Leia a última troca entre os dois e decida o que precisa ser lembrado em conversas futuras.

Tipos de memória:
- fato: algo estável sobre a vida ou o trabalho dele (cargo, contexto da empresa, família, saúde, preferências).
- pessoa: quem é alguém que ele mencionou e qual a relação.
- decisao: algo que ele decidiu.
- compromisso: algo que ele disse que vai fazer. Preencha prazo se houver data, convertendo datas relativas a partir da data de hoje.
- tema_aberto: um assunto em andamento que vai voltar (um conflito, uma negociação, um dilema).
- padrao: um comportamento recorrente que a Nina apontou ou que aparece de novo.

Regras:
- Cada memória é uma frase curta e autossuficiente, em português, na terceira pessoa ("Rodrigo ...").
- Só registre o que tem chance real de importar depois. Conversa trivial não gera memória.
- Não duplique o que já existe: se uma memória existente mudou, use atualizadas com o id dela.
- Se um compromisso foi cumprido ou um tema aberto foi encerrado, coloque o id em resolvidas.
- novo_tom: só preencha se o Rodrigo pediu explicitamente para a Nina mudar o jeito de falar (por exemplo "pega mais leve" ou "pode voltar ao normal"). Descreva o novo tom em uma frase. Se ele pediu para voltar ao normal, escreva exatamente "padrao". Caso contrário, null.`;

export async function extrairMemorias(
  modelo: string,
  hoje: string,
  existentes: { id: number; tipo: string; conteudo: string }[],
  falaRodrigo: string,
  respostaNina: string,
): Promise<Extracao> {
  const lista = existentes.map((m) => `[${m.id}] (${m.tipo}) ${m.conteudo}`).join("\n") || "(nenhuma)";
  const resposta = await anthropic().messages.create({
    model: modelo,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_EXTRACAO } },
    system: INSTRUCAO_EXTRACAO,
    messages: [{
      role: "user",
      content: `Hoje: ${hoje}\n\nMemórias existentes relacionadas:\n${lista}\n\n` +
        `Rodrigo disse:\n${falaRodrigo}\n\nNina respondeu:\n${respostaNina}`,
    }],
  });
  const texto = resposta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(texto) as Extracao;
}
