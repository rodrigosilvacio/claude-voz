// Áudio: transcrição (OpenAI) e fala (ElevenLabs, com OpenAI de reserva).
import { segredo } from "./config.ts";

// ~2 minutos de fala por mensagem de voz; texto maior vira mais de um áudio.
export const CARACTERES_POR_AUDIO = 2200;

export async function transcrever(audio: Uint8Array<ArrayBuffer>, glossario: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "audio.ogg");
  form.append("model", "gpt-4o-transcribe");
  form.append("language", "pt");
  // Nomes próprios e siglas que o STT erraria sem dica.
  if (glossario) form.append("prompt", glossario);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${segredo("OPENAI_API_KEY")}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcrição falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { text } = await res.json() as { text: string };
  return text.trim();
}

export interface OpcoesVoz {
  elevenlabsVoiceId: string;
  elevenlabsModel: string;
  openaiVoice: string;
}

// Devolve o MP3 e qual fornecedor falou, para o log.
export async function falar(texto: string, op: OpcoesVoz): Promise<{ mp3: Uint8Array<ArrayBuffer>; fornecedor: string }> {
  try {
    return { mp3: await falarElevenLabs(texto, op), fornecedor: "elevenlabs" };
  } catch (e) {
    console.error("ElevenLabs falhou, usando OpenAI:", e instanceof Error ? e.message : e);
    return { mp3: await falarOpenAI(texto, op), fornecedor: "openai" };
  }
}

async function falarElevenLabs(texto: string, op: OpcoesVoz): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${op.elevenlabsVoiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": segredo("ELEVENLABS_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify({ text: texto, model_id: op.elevenlabsModel }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
}

async function falarOpenAI(texto: string, op: OpcoesVoz): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${segredo("OPENAI_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: op.openaiVoice,
      input: texto,
      instructions:
        "Português do Brasil. Voz feminina madura, firme e direta, de uma mentora experiente. " +
        "Ritmo de conversa, com pausas naturais. Sem tom de locutora nem de atendimento.",
      response_format: "mp3",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array<ArrayBuffer>(await res.arrayBuffer());
}
