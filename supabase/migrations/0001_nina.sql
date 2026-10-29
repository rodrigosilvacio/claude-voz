-- Nina: conselheira pessoal por voz no Telegram (ver docs/PRD.md).
-- Tabelas prefixadas nina_ porque este projeto Supabase é compartilhado entre
-- vários apps. Todas com RLS ligado e sem políticas: só a service role (usada
-- pela edge function nina-telegram) lê e escreve. Nenhum cliente público
-- enxerga nada daqui.

create extension if not exists vector with schema extensions;

-- Configuração não secreta (voice_id, modelos, dono do bot). Segredos de API
-- ficam nos Secrets das Edge Functions, nunca aqui.
create table public.nina_config (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);
comment on table public.nina_config is
  'Configuração da Nina (bot de voz no Telegram). Lida pela edge function nina-telegram com service role. telegram_user_id é o único usuário atendido.';

insert into public.nina_config (chave, valor) values
  ('webhook_secret', encode(extensions.gen_random_bytes(32), 'hex')),
  ('elevenlabs_voice_id', 'oJebhZNaPllxk6W0LSBA'),
  ('elevenlabs_model', 'eleven_multilingual_v2'),
  ('openai_tts_voice', 'marin'),
  ('modelo_conversa', 'claude-opus-5-5'),
  ('esforco_conversa', 'low'),
  ('modelo_memoria', 'claude-haiku-5-5'),
  ('tom', 'Padrão: franqueza 5 de 5, dura, direta, sem bajulação.'),
  ('responder_com_voz', 'true'),
  ('perfil', 'Rodrigo Silva, CIO da Nitro. Lidera tecnologia, dados e IA. Também é mentor, instrutor, conselheiro e articulador de comunidades de tecnologia (Cursor, Lovable, CTOs, SUCESU SP). Mora no Brasil. Pratica jiu-jitsu. Valoriza execução, clareza e franqueza.'),
  ('glossario', 'Nitro, Nina, CIO, CTO, board, Lecom, Datasul, Desk.ms, ChatVolt, Lovable, Replit, Cursor, n8n, Make, Z-API, Typebot, ElevenLabs, Supabase, SUCESU, Power BI, BigQuery, jiu-jitsu.');

-- Mensagens do Rodrigo e respostas da Nina. Áudio não é guardado, só o texto.
create table public.nina_mensagens (
  id bigint generated always as identity primary key,
  papel text not null check (papel in ('user', 'assistant')),
  conteudo text not null,
  origem text not null default 'texto' check (origem in ('texto', 'voz', 'comando')),
  telegram_message_id bigint,
  latencias jsonb,
  uso jsonb,
  criado_em timestamptz not null default now()
);
create index nina_mensagens_criado_em_idx on public.nina_mensagens (criado_em desc);
comment on table public.nina_mensagens is
  'Histórico completo da conversa com a Nina. Escrito só pela edge function nina-telegram.';

-- Memórias atômicas extraídas de cada troca pelo modelo de memória.
create table public.nina_memorias (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('fato', 'pessoa', 'decisao', 'compromisso', 'tema_aberto', 'padrao')),
  conteudo text not null,
  status text not null default 'ativa' check (status in ('ativa', 'resolvida')),
  prazo date,
  embedding extensions.vector(1536),
  origem_mensagem_id bigint references public.nina_mensagens (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index nina_memorias_status_tipo_idx on public.nina_memorias (status, tipo);
create index nina_memorias_embedding_idx on public.nina_memorias
  using hnsw (embedding extensions.vector_cosine_ops);
comment on table public.nina_memorias is
  'Memória de longo prazo da Nina: fatos, pessoas, decisões, compromissos, temas abertos e padrões do Rodrigo.';

-- update_id do Telegram já recebidos: o Telegram reenvia quando não recebe 200
-- a tempo, e a mesma mensagem não pode ser respondida duas vezes.
create table public.nina_updates (
  update_id bigint primary key,
  recebido_em timestamptz not null default now()
);

create table public.nina_feedback (
  id bigint generated always as identity primary key,
  mensagem_id bigint not null references public.nina_mensagens (id) on delete cascade,
  util boolean not null,
  criado_em timestamptz not null default now(),
  unique (mensagem_id)
);

alter table public.nina_config enable row level security;
alter table public.nina_mensagens enable row level security;
alter table public.nina_memorias enable row level security;
alter table public.nina_updates enable row level security;
alter table public.nina_feedback enable row level security;

-- Busca semântica das memórias ativas mais próximas da mensagem atual.
create or replace function public.nina_buscar_memorias(
  p_embedding extensions.vector(1536),
  p_limite int default 12
)
returns table (id bigint, tipo text, conteudo text, prazo date, criado_em timestamptz, similaridade float)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.tipo, m.conteudo, m.prazo, m.criado_em,
         1 - (m.embedding operator(extensions.<=>) p_embedding) as similaridade
  from public.nina_memorias m
  where m.status = 'ativa' and m.embedding is not null
  order by m.embedding operator(extensions.<=>) p_embedding
  limit p_limite;
$$;

revoke all on function public.nina_buscar_memorias(extensions.vector, int) from public, anon, authenticated;
grant execute on function public.nina_buscar_memorias(extensions.vector, int) to service_role;
