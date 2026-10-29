// Chamadas à Bot API do Telegram usadas pela Nina.
import { segredo } from "./config.ts";

const API = () => `https://api.telegram.org/bot${segredo("NINA_TELEGRAM_BOT_TOKEN")}`;

// Limite do Telegram para texto de uma mensagem.
const LIMITE_TEXTO = 4096;

export type Botao = { text: string; callback_data: string };

async function chamar(metodo: string, corpo: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API()}/${metodo}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${metodo} falhou (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.result;
}

export async function enviarTexto(chatId: number, texto: string, botoes?: Botao[][]): Promise<void> {
  const partes = dividirTexto(texto, LIMITE_TEXTO);
  for (let i = 0; i < partes.length; i++) {
    const ultima = i === partes.length - 1;
    await chamar("sendMessage", {
      chat_id: chatId,
      text: partes[i],
      ...(ultima && botoes ? { reply_markup: { inline_keyboard: botoes } } : {}),
    });
  }
}

// sendVoice aceita MP3 além de OGG/Opus, então o áudio do TTS vai direto.
export async function enviarVoz(chatId: number, mp3: Uint8Array<ArrayBuffer>): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([mp3], { type: "audio/mpeg" }), "nina.mp3");
  const res = await fetch(`${API()}/sendVoice`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram sendVoice falhou (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
}

export async function acao(chatId: number, tipo: "typing" | "record_voice"): Promise<void> {
  await chamar("sendChatAction", { chat_id: chatId, action: tipo }).catch(() => {});
}

// O indicador "gravando áudio..." some sozinho em ~5s; repete até o fim.
export function manterAcao(chatId: number, tipo: "typing" | "record_voice"): () => void {
  acao(chatId, tipo);
  const id = setInterval(() => acao(chatId, tipo), 4500);
  return () => clearInterval(id);
}

export async function responderCallback(callbackId: string, texto?: string): Promise<void> {
  await chamar("answerCallbackQuery", { callback_query_id: callbackId, ...(texto ? { text: texto } : {}) })
    .catch((e) => console.error(e));
}

export async function removerBotoes(chatId: number, messageId: number): Promise<void> {
  await chamar("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    .catch((e) => console.error(e));
}

export async function baixarArquivo(fileId: string): Promise<Uint8Array<ArrayBuffer>> {
  const arquivo = await chamar("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${segredo("NINA_TELEGRAM_BOT_TOKEN")}/${arquivo.file_path}`);
  if (!res.ok) throw new Error(`Download do áudio no Telegram falhou (HTTP ${res.status}).`);
  return new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
}

export async function configurarWebhook(url: string, secretToken: string): Promise<unknown> {
  await chamar("setMyCommands", {
    commands: [
      { command: "memoria", description: "O que a Nina sabe de você e o que está em aberto" },
      { command: "esquecer", description: "Apagar uma memória (/esquecer termo) ou tudo" },
      { command: "tom", description: "Ver ou mudar o tom da Nina" },
      { command: "voz", description: "Responder com áudio e texto" },
      { command: "texto", description: "Responder só com texto" },
    ],
  });
  return await chamar("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

// Quebra em parágrafos e, se preciso, em frases, sem cortar palavra no meio.
export function dividirTexto(texto: string, limite: number): string[] {
  if (texto.length <= limite) return [texto];
  const partes: string[] = [];
  let atual = "";
  const pedacos = texto.split(/(?<=\n\n)|(?<=[.!?…])\s+/);
  for (const p of pedacos) {
    if (atual && (atual + " " + p).length > limite) {
      partes.push(atual.trim());
      atual = "";
    }
    if (p.length > limite) {
      for (let i = 0; i < p.length; i += limite) partes.push(p.slice(i, i + limite));
      continue;
    }
    atual = atual ? `${atual} ${p}` : p;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}
