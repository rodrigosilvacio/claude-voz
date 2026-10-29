-- Histórico pesquisável da Nina: cada troca (fala do Rodrigo + resposta da
-- Nina) ganha um embedding, para ser lembrada automaticamente quando o assunto
-- volta (camada 1) e pesquisada por assunto e período quando ele pedir
-- (camada 2, ferramenta pesquisar_historico).
create table public.nina_trocas (
  id bigint generated always as identity primary key,
  mensagem_user_id bigint not null unique references public.nina_mensagens (id) on delete cascade,
  mensagem_nina_id bigint not null references public.nina_mensagens (id) on delete cascade,
  texto text not null,
  embedding extensions.vector(1536),
  criado_em timestamptz not null
);
create index nina_trocas_criado_em_idx on public.nina_trocas (criado_em desc);
create index nina_trocas_embedding_idx on public.nina_trocas
  using hnsw (embedding extensions.vector_cosine_ops);
comment on table public.nina_trocas is
  'Cada troca da conversa com a Nina, com embedding, para busca no histórico. Apagada em cascata com nina_mensagens.';

alter table public.nina_trocas enable row level security;

-- Camada 1: trechos antigos parecidos com a mensagem atual, fora da janela de
-- mensagens recentes que já vai inteira no contexto.
create or replace function public.nina_buscar_trocas(
  p_embedding extensions.vector(1536),
  p_antes_de_mensagem bigint,
  p_limite int default 4
)
returns table (id bigint, texto text, criado_em timestamptz, similaridade float)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.texto, t.criado_em,
         1 - (t.embedding operator(extensions.<=>) p_embedding) as similaridade
  from public.nina_trocas t
  where t.embedding is not null and t.mensagem_user_id < p_antes_de_mensagem
  order by t.embedding operator(extensions.<=>) p_embedding
  limit p_limite;
$$;

-- Camada 2: pesquisa sob demanda. Filtra por período e por termo exato quando
-- informados; ordena por significado quando há consulta, senão pelas mais
-- recentes do período.
create or replace function public.nina_pesquisar_historico(
  p_embedding extensions.vector(1536) default null,
  p_de timestamptz default null,
  p_ate timestamptz default null,
  p_termo text default null,
  p_limite int default 8
)
returns table (id bigint, texto text, criado_em timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.texto, t.criado_em
  from public.nina_trocas t
  where (p_de is null or t.criado_em >= p_de)
    and (p_ate is null or t.criado_em < p_ate)
    and (p_termo is null or t.texto ilike '%' || p_termo || '%')
  order by
    case when p_embedding is null then null else t.embedding operator(extensions.<=>) p_embedding end nulls last,
    t.criado_em desc
  limit p_limite;
$$;

revoke all on function public.nina_buscar_trocas(extensions.vector, bigint, int) from public, anon, authenticated;
grant execute on function public.nina_buscar_trocas(extensions.vector, bigint, int) to service_role;
revoke all on function public.nina_pesquisar_historico(extensions.vector, timestamptz, timestamptz, text, int)
  from public, anon, authenticated;
grant execute on function public.nina_pesquisar_historico(extensions.vector, timestamptz, timestamptz, text, int)
  to service_role;

-- Pares (fala do Rodrigo, resposta da Nina) ainda sem troca indexada: a
-- resposta é a primeira mensagem da Nina depois de cada fala dele. Usado para
-- indexar o que já foi conversado antes desta migration.
create or replace function public.nina_trocas_pendentes(p_limite int default 50)
returns table (mensagem_user_id bigint, mensagem_nina_id bigint, fala text, resposta text, criado_em timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select u.id, a.id, u.conteudo, a.conteudo, u.criado_em
  from public.nina_mensagens u
  cross join lateral (
    select m.id, m.conteudo from public.nina_mensagens m
    where m.papel = 'assistant' and m.id > u.id
    order by m.id limit 1
  ) a
  where u.papel = 'user' and u.origem <> 'comando'
    and not exists (select 1 from public.nina_trocas t where t.mensagem_user_id = u.id)
  order by u.id
  limit p_limite;
$$;

revoke all on function public.nina_trocas_pendentes(int) from public, anon, authenticated;
grant execute on function public.nina_trocas_pendentes(int) to service_role;
