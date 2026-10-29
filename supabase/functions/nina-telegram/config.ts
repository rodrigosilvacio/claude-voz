// Cliente Supabase (service role) e leitura da tabela nina_config.
// Versão exata pinada, mesmo padrão das outras functions deste projeto: uma
// release nova do supabase-js não entra em produção sem passar por commit.
import { createClient } from "npm:@supabase/supabase-js@2.110.5";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

export const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export function segredo(nome: string): string {
  const valor = Deno.env.get(nome);
  if (!valor) throw new Error(`Falta o secret ${nome} nas Edge Functions do Supabase.`);
  return valor;
}

// Cache curto: a config muda raramente (tom, voz), e 30s basta para uma
// mudança via comando valer já na mensagem seguinte da mesma instância,
// porque gravarConfig também atualiza o cache.
let cache: Record<string, string> | null = null;
let cacheExpiraEm = 0;

export async function config(): Promise<Record<string, string>> {
  if (cache && Date.now() < cacheExpiraEm) return cache;
  const { data, error } = await supabase.from("nina_config").select("chave, valor");
  if (error) throw error;
  cache = Object.fromEntries(data.map((l: { chave: string; valor: string }) => [l.chave, l.valor]));
  cacheExpiraEm = Date.now() + 30_000;
  return cache!;
}

export async function gravarConfig(chave: string, valor: string): Promise<void> {
  const { error } = await supabase
    .from("nina_config")
    .upsert({ chave, valor, atualizado_em: new Date().toISOString() });
  if (error) throw error;
  if (cache) cache[chave] = valor;
}

export async function apagarConfig(chave: string): Promise<void> {
  const { error } = await supabase.from("nina_config").delete().eq("chave", chave);
  if (error) throw error;
  if (cache) delete cache[chave];
}
