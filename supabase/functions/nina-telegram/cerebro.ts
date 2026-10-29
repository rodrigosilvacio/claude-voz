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

// Effort baixo segura a latência da conversa por voz; dá para subir pela
// nina_config (esforco_conversa) sem novo deploy.
export async function responder(
  historico: Turno[],
  contexto: string,
  modelo: string,
  esforco: "low" | "medium" | "high",
): Promise<Resposta> {
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
    messages: [
      ...historico,
      // Contexto da memória como mensagem de sistema depois da última fala do
      // Rodrigo: não quebra o cache do histórico e tem autoridade de operador.
      { role: "system", content: contexto },
    ],
  });

  if (resposta.stop_reason === "refusal") {
    return {
      texto: "Não consigo responder isso desse jeito. Me conta de outro ângulo o que está acontecendo.",
      uso: resposta.usage,
    };
  }
  const texto = resposta.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
  return { texto: texto || "Travei aqui. Fala de novo?", uso: resposta.usage };
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
