// Nina: conselheira pessoal do Rodrigo por voz no Telegram (docs/PRD.md).
//
// Fluxo de uma mensagem:
//   1. Telegram chama este webhook. Valida o secret_token, deduplica pelo
//      update_id, responde 200 na hora e segue em segundo plano.
//   2. Áudio é transcrito (OpenAI). Texto entra direto.
//   3. Monta o contexto: perfil, temas abertos, compromissos, memórias
//      relevantes (pgvector) e as últimas mensagens.
//   4. Claude gera a resposta da Nina; ElevenLabs fala (OpenAI de reserva).
//   5. Envia áudio(s) + texto com botões de feedback.
//   6. Um modelo menor extrai memórias da troca e grava.
//
// Só o Telegram user ID guardado em nina_config.telegram_user_id é atendido.
// Enquanto ele não está configurado, o bot só informa o ID de quem escreveu.
//
// Deploy com verify_jwt desligado: quem chama é o Telegram. A autenticação é o
// header X-Telegram-Bot-Api-Secret-Token, igual ao webhook_secret da config.
import { apagarConfig, config, gravarConfig, supabase, SUPABASE_URL } from "./config.ts";
import * as tg from "./telegram.ts";
import { CARACTERES_POR_AUDIO, falar, transcrever } from "./voz.ts";
import { extrairMemorias, responder } from "./cerebro.ts";
import {
  aplicarExtracao,
  embedding,
  formatar,
  historico,
  memoriasAtivas,
  memoriasRelevantes,
  salvarMensagem,
} from "./memoria.ts";
import { contextoDinamico } from "./prompt.ts";

// Global do runtime de edge functions do Supabase (background tasks).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const TOM_PADRAO = "Padrão: franqueza 5 de 5, dura, direta, sem bajulação.";

function iguais(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const agoraSP = () =>
  new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" });
const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("use POST", { status: 405 });
  const cfg = await config();
  const url = new URL(req.url);

  // Registro do webhook e dos comandos no Telegram. Chamado uma vez, com o
  // próprio webhook_secret, porque o token do bot só existe aqui dentro.
  if (url.searchParams.get("acao") === "configurar") {
    if (!iguais(req.headers.get("x-nina-setup") ?? "", cfg.webhook_secret)) {
      return new Response("não autorizado", { status: 401 });
    }
    const resultado = await tg.configurarWebhook(`${SUPABASE_URL}/functions/v1/nina-telegram`, cfg.webhook_secret);
    return Response.json({ ok: true, resultado });
  }

  if (!iguais(req.headers.get("x-telegram-bot-api-secret-token") ?? "", cfg.webhook_secret)) {
    return new Response("não autorizado", { status: 401 });
  }
  const update = await req.json().catch(() => null);
  if (!update || typeof update.update_id !== "number") return new Response("ok");

  const { error } = await supabase.from("nina_updates").insert({ update_id: update.update_id });
  if (error) {
    if (error.code === "23505") return new Response("ok");
    console.error("erro ao registrar update:", error);
    return new Response("erro", { status: 500 });
  }

  EdgeRuntime.waitUntil(tratarUpdate(update).catch((e) => console.error("falha ao tratar update:", e)));
  return new Response("ok");
});

async function tratarUpdate(update: any) {
  const cfg = await config();
  const dono = cfg.telegram_user_id ? Number(cfg.telegram_user_id) : null;

  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.from?.id !== dono) return;
    await tratarCallback(cb);
    return;
  }

  const msg = update.message;
  if (!msg?.from || msg.chat?.type !== "private") return;
  const chatId: number = msg.chat.id;

  if (!dono) {
    await gravarConfig("telegram_user_id_candidato", String(msg.from.id));
    await tg.enviarTexto(chatId, `Seu ID do Telegram é ${msg.from.id}. A Nina ainda não tem dono configurado.`);
    return;
  }
  if (msg.from.id !== dono) return;

  const texto: string | undefined = msg.text?.trim();
  if (texto?.startsWith("/")) {
    await tratarComando(chatId, texto);
    return;
  }

  const audio = msg.voice ?? msg.audio;
  if (!texto && !audio) {
    await tg.enviarTexto(chatId, "Por enquanto eu só entendo áudio e texto.");
    return;
  }

  const comVoz = cfg.responder_com_voz !== "false";
  const pararAcao = tg.manterAcao(chatId, comVoz ? "record_voice" : "typing");
  const t0 = Date.now();
  const latencias: Record<string, number> = {};
  try {
    let fala = texto ?? "";
    if (audio) {
      const bytes = await tg.baixarArquivo(audio.file_id);
      fala = await transcrever(bytes, cfg.glossario ?? "");
      latencias.stt_ms = Date.now() - t0;
      if (!fala) {
        await tg.enviarTexto(chatId, "Não consegui entender o áudio. Manda de novo?");
        return;
      }
    }
    const origem = audio ? "voz" : "texto";
    const mensagemId = await salvarMensagem("user", fala, origem, { telegram_message_id: msg.message_id });

    // Contexto da memória. Se o embedding falhar, segue sem busca semântica.
    const t1 = Date.now();
    const vetor = await embedding(fala).catch((e) => (console.error("embedding da fala falhou:", e), null));
    const [abertas, relevantes, fatos, turnos] = await Promise.all([
      memoriasAtivas(["compromisso", "tema_aberto"]),
      memoriasRelevantes(vetor),
      memoriasAtivas(["fato", "pessoa"], 25),
      historico(),
    ]);
    const idsAbertas = new Set(abertas.map((m) => m.id));
    const contexto = contextoDinamico({
      agora: agoraSP(),
      tom: cfg.tom ?? TOM_PADRAO,
      perfil: [cfg.perfil, ...fatos.map(formatar)].filter(Boolean).join("\n"),
      temasAbertos: abertas.filter((m) => m.tipo === "tema_aberto").map(formatar),
      compromissos: abertas.filter((m) => m.tipo === "compromisso").map(formatar),
      relevantes: relevantes.filter((m) => !idsAbertas.has(m.id)).map(formatar),
    });
    latencias.contexto_ms = Date.now() - t1;

    const t2 = Date.now();
    const esforco = (["low", "medium", "high"].includes(cfg.esforco_conversa) ? cfg.esforco_conversa : "low") as
      | "low"
      | "medium"
      | "high";
    const resposta = await responder(turnos, contexto, cfg.modelo_conversa ?? "claude-opus-5-5", esforco);
    latencias.llm_ms = Date.now() - t2;

    const t3 = Date.now();
    let fornecedorVoz: string | null = null;
    if (comVoz) {
      try {
        for (const parte of tg.dividirTexto(resposta.texto, CARACTERES_POR_AUDIO)) {
          const { mp3, fornecedor } = await falar(parte, {
            elevenlabsVoiceId: cfg.elevenlabs_voice_id,
            elevenlabsModel: cfg.elevenlabs_model ?? "eleven_multilingual_v2",
            openaiVoice: cfg.openai_tts_voice ?? "marin",
          });
          fornecedorVoz = fornecedor;
          await tg.enviarVoz(chatId, mp3);
        }
      } catch (e) {
        console.error("falha na voz:", e);
        fornecedorVoz = "falhou";
      }
      latencias.tts_ms = Date.now() - t3;
    }
    latencias.total_ms = Date.now() - t0;

    const respostaId = await salvarMensagem("assistant", resposta.texto, "texto", {
      latencias: { ...latencias, voz: fornecedorVoz },
      uso: resposta.uso,
    });
    const aviso = fornecedorVoz === "falhou" ? "\n\n(o áudio falhou, segue só o texto)" : "";
    await tg.enviarTexto(chatId, resposta.texto + aviso, [[
      { text: "👍", callback_data: `fb:${respostaId}:1` },
      { text: "👎", callback_data: `fb:${respostaId}:0` },
    ]]);
    pararAcao();

    await atualizarMemoria(fala, resposta.texto, mensagemId, [...abertas, ...relevantes]);
  } catch (e) {
    console.error("falha ao responder:", e);
    await tg.enviarTexto(chatId, "Deu problema do meu lado e não consegui responder. Tenta de novo em um minuto.")
      .catch(() => {});
  } finally {
    pararAcao();
  }
}

async function atualizarMemoria(
  fala: string,
  resposta: string,
  mensagemId: number,
  existentes: { id: number; tipo: string; conteudo: string }[],
) {
  const cfg = await config();
  try {
    const unicas = [...new Map(existentes.map((m) => [m.id, m])).values()];
    const ex = await extrairMemorias(cfg.modelo_memoria ?? "claude-haiku-5-5", hojeISO(), unicas, fala, resposta);
    await aplicarExtracao(ex, mensagemId);
    if (ex.novo_tom) await gravarConfig("tom", ex.novo_tom === "padrao" ? TOM_PADRAO : ex.novo_tom);
  } catch (e) {
    console.error("falha ao extrair memórias:", e);
  }
}

// --- Comandos ---------------------------------------------------------------

async function tratarComando(chatId: number, texto: string) {
  const [bruto, ...resto] = texto.split(/\s+/);
  const comando = bruto.slice(1).split("@")[0].toLowerCase();
  const argumento = resto.join(" ").trim();

  if (comando === "start") {
    await tg.enviarTexto(
      chatId,
      "Aqui é a Nina. Manda áudio ou texto, do trabalho ou da vida. Eu vou te falar o que penso, sem enfeite.\n\n" +
        "/memoria mostra o que eu sei de você\n/esquecer apaga uma memória\n/tom muda meu jeito de falar\n" +
        "/voz e /texto ligam ou desligam o áudio",
    );
    return;
  }

  if (comando === "memoria") {
    const todas = await memoriasAtivas(["fato", "pessoa", "decisao", "compromisso", "tema_aberto", "padrao"], 200);
    if (!todas.length) {
      await tg.enviarTexto(chatId, "Ainda não guardei nada sobre você.");
      return;
    }
    const titulos: Record<string, string> = {
      compromisso: "Compromissos",
      tema_aberto: "Temas abertos",
      decisao: "Decisões",
      padrao: "Padrões",
      pessoa: "Pessoas",
      fato: "Fatos",
    };
    const blocos = Object.entries(titulos)
      .map(([tipo, titulo]) => {
        const itens = todas.filter((m) => m.tipo === tipo);
        return itens.length ? `${titulo}\n${itens.map((m) => `• ${formatar(m)}`).join("\n")}` : "";
      })
      .filter(Boolean);
    await tg.enviarTexto(chatId, blocos.join("\n\n"));
    return;
  }

  if (comando === "esquecer") {
    if (!argumento) {
      await tg.enviarTexto(chatId, "Use /esquecer seguido de um termo (ex.: /esquecer fornecedor X) ou /esquecer tudo.");
      return;
    }
    if (argumento.toLowerCase() === "tudo") {
      await gravarConfig("esquecer_pendente", "tudo");
      await tg.enviarTexto(chatId, "Isso apaga todas as memórias e todo o histórico de conversa. Confirma?", [[
        { text: "Apagar tudo", callback_data: "esq:sim" },
        { text: "Cancelar", callback_data: "esq:nao" },
      ]]);
      return;
    }
    const termo = argumento.replace(/[%_\\]/g, (c) => `\\${c}`);
    const { data, error } = await supabase
      .from("nina_memorias")
      .select("id, tipo, conteudo, prazo, criado_em")
      .ilike("conteudo", `%${termo}%`)
      .limit(15);
    if (error) throw error;
    if (!data?.length) {
      await tg.enviarTexto(chatId, `Não achei nenhuma memória com "${argumento}".`);
      return;
    }
    await gravarConfig("esquecer_pendente", JSON.stringify(data.map((m: { id: number }) => m.id)));
    await tg.enviarTexto(
      chatId,
      `Achei ${data.length}:\n${data.map((m: any) => `• ${formatar(m)}`).join("\n")}\n\nApago essas?`,
      [[{ text: "Apagar", callback_data: "esq:sim" }, { text: "Cancelar", callback_data: "esq:nao" }]],
    );
    return;
  }

  if (comando === "tom") {
    if (!argumento) {
      const cfg = await config();
      await tg.enviarTexto(
        chatId,
        `Tom atual: ${cfg.tom ?? TOM_PADRAO}\n\nPara mudar: /tom seguido do jeito que você quer. Para voltar: /tom padrao. ` +
          "Você também pode só pedir no meio da conversa.",
      );
      return;
    }
    const novo = ["padrao", "padrão"].includes(argumento.toLowerCase()) ? TOM_PADRAO : argumento;
    await gravarConfig("tom", novo);
    await tg.enviarTexto(chatId, `Feito. Tom agora: ${novo}`);
    return;
  }

  if (comando === "voz" || comando === "texto") {
    await gravarConfig("responder_com_voz", comando === "voz" ? "true" : "false");
    await tg.enviarTexto(chatId, comando === "voz" ? "Volto a responder com áudio e texto." : "Agora respondo só com texto.");
    return;
  }

  await tg.enviarTexto(chatId, "Não conheço esse comando. Os que existem: /memoria, /esquecer, /tom, /voz, /texto.");
}

async function tratarCallback(cb: any) {
  const chatId: number = cb.message?.chat?.id;
  const messageId: number = cb.message?.message_id;
  const dados: string = cb.data ?? "";

  if (dados.startsWith("fb:")) {
    const [, id, util] = dados.split(":");
    const { error } = await supabase
      .from("nina_feedback")
      .upsert({ mensagem_id: Number(id), util: util === "1" }, { onConflict: "mensagem_id" });
    if (error) console.error("erro ao salvar feedback:", error);
    await tg.responderCallback(cb.id, "Anotado.");
    await tg.removerBotoes(chatId, messageId);
    return;
  }

  if (dados.startsWith("esq:")) {
    const cfg = await config();
    const pendente = cfg.esquecer_pendente;
    await apagarConfig("esquecer_pendente");
    await tg.removerBotoes(chatId, messageId);
    if (dados !== "esq:sim" || !pendente) {
      await tg.responderCallback(cb.id, "Cancelado.");
      return;
    }
    if (pendente === "tudo") {
      await supabase.from("nina_memorias").delete().gte("id", 0);
      await supabase.from("nina_mensagens").delete().gte("id", 0);
      await tg.responderCallback(cb.id);
      await tg.enviarTexto(chatId, "Apaguei tudo. Começamos do zero.");
      return;
    }
    const ids: number[] = JSON.parse(pendente);
    await supabase.from("nina_memorias").delete().in("id", ids);
    await tg.responderCallback(cb.id);
    await tg.enviarTexto(chatId, `Esqueci ${ids.length} memória(s).`);
  }
}
