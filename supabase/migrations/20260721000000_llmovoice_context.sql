create extension if not exists vector with schema extensions;
create schema if not exists llmovoice;

create table if not exists llmovoice.pages (
  id text primary key,
  user_id text not null,
  session_id text not null,
  sequence integer not null check (sequence > 0),
  status text not null check (status in ('open', 'complete', 'interrupted')),
  payload jsonb not null,
  embedding extensions.vector(1536),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, user_id),
  unique (session_id, sequence)
);

create table if not exists llmovoice.threads (
  id text primary key,
  user_id text not null,
  status text not null check (status in ('active', 'background', 'archived')),
  payload jsonb not null,
  embedding extensions.vector(1536),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_active_at timestamptz not null,
  unique (id, user_id)
);

create table if not exists llmovoice.thread_pages (
  thread_id text not null,
  page_id text not null,
  user_id text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  primary key (thread_id, page_id),
  unique (thread_id, position),
  foreign key (thread_id, user_id) references llmovoice.threads (id, user_id) on delete cascade,
  foreign key (page_id, user_id) references llmovoice.pages (id, user_id) on delete cascade
);

create table if not exists llmovoice.traces (
  id text primary key,
  user_id text not null,
  session_id text not null,
  page_id text,
  thread_id text,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null
);

create table if not exists llmovoice.enrichment_jobs (
  id text primary key,
  user_id text not null,
  page_id text not null,
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null,
  lease_expires_at timestamptz,
  worker_id text,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (page_id, user_id) references llmovoice.pages (id, user_id) on delete cascade
);

create index if not exists pages_user_sequence_idx on llmovoice.pages (user_id, sequence asc);
create index if not exists pages_session_updated_idx on llmovoice.pages (user_id, session_id, updated_at desc);
create index if not exists threads_user_active_idx on llmovoice.threads (user_id, last_active_at desc);
create index if not exists thread_pages_page_idx on llmovoice.thread_pages (page_id, user_id);
create index if not exists traces_session_created_idx on llmovoice.traces (user_id, session_id, created_at asc);
create index if not exists enrichment_jobs_claim_idx
  on llmovoice.enrichment_jobs (user_id, available_at asc, created_at asc)
  where status in ('pending', 'processing');
create index if not exists pages_embedding_hnsw_idx
  on llmovoice.pages using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;
create index if not exists threads_embedding_hnsw_idx
  on llmovoice.threads using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;

alter table llmovoice.pages enable row level security;
alter table llmovoice.threads enable row level security;
alter table llmovoice.thread_pages enable row level security;
alter table llmovoice.traces enable row level security;
alter table llmovoice.enrichment_jobs enable row level security;
alter table llmovoice.pages force row level security;
alter table llmovoice.threads force row level security;
alter table llmovoice.thread_pages force row level security;
alter table llmovoice.traces force row level security;
alter table llmovoice.enrichment_jobs force row level security;

drop policy if exists pages_owner on llmovoice.pages;
create policy pages_owner on llmovoice.pages for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

drop policy if exists threads_owner on llmovoice.threads;
create policy threads_owner on llmovoice.threads for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

drop policy if exists thread_pages_owner on llmovoice.thread_pages;
create policy thread_pages_owner on llmovoice.thread_pages for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

drop policy if exists traces_owner on llmovoice.traces;
create policy traces_owner on llmovoice.traces for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

drop policy if exists enrichment_jobs_owner on llmovoice.enrichment_jobs;
create policy enrichment_jobs_owner on llmovoice.enrichment_jobs for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

create or replace function llmovoice.match_pages(
  query_user_id text,
  query_embedding extensions.vector(1536),
  match_count integer default 40
)
returns table (payload jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select pages.payload
  from llmovoice.pages
  where pages.user_id = query_user_id and pages.embedding is not null
  order by pages.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 200)
$$;

create or replace function llmovoice.match_threads(
  query_user_id text,
  query_embedding extensions.vector(1536),
  match_count integer default 40
)
returns table (payload jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select threads.payload
  from llmovoice.threads
  where threads.user_id = query_user_id and threads.embedding is not null
  order by threads.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 200)
$$;

create or replace function llmovoice.upsert_thread(
  input_id text,
  input_user_id text,
  input_status text,
  input_payload jsonb,
  input_embedding extensions.vector(1536),
  input_page_ids text[],
  input_created_at timestamptz,
  input_updated_at timestamptz,
  input_last_active_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into llmovoice.threads
    (id, user_id, status, payload, embedding, created_at, updated_at, last_active_at)
  values
    (input_id, input_user_id, input_status, input_payload, input_embedding, input_created_at, input_updated_at, input_last_active_at)
  on conflict (id) do update set
    status = excluded.status,
    payload = excluded.payload,
    embedding = excluded.embedding,
    updated_at = excluded.updated_at,
    last_active_at = excluded.last_active_at;

  delete from llmovoice.thread_pages
  where thread_id = input_id and user_id = input_user_id;

  insert into llmovoice.thread_pages (thread_id, page_id, user_id, position)
  select input_id, page_id, input_user_id, ordinal::integer - 1
  from unnest(input_page_ids) with ordinality as pages(page_id, ordinal);
end
$$;

create or replace function llmovoice.claim_enrichment(
  input_user_id text,
  input_worker_id text,
  input_lease_ms integer default 30000
)
returns setof llmovoice.enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select jobs.id
    from llmovoice.enrichment_jobs as jobs
    where jobs.user_id = input_user_id
      and jobs.attempts < jobs.max_attempts
      and jobs.available_at <= now()
      and (
        jobs.status = 'pending'
        or (jobs.status = 'processing' and jobs.lease_expires_at < now())
      )
    order by jobs.available_at asc, jobs.created_at asc
    for update skip locked
    limit 1
  )
  update llmovoice.enrichment_jobs as jobs
  set status = 'processing',
      attempts = jobs.attempts + 1,
      worker_id = input_worker_id,
      lease_expires_at = now() + (greatest(input_lease_ms, 5000) * interval '1 millisecond'),
      updated_at = now()
  from candidate
  where jobs.id = candidate.id
  returning jobs.*;
end
$$;

create or replace function llmovoice.fail_enrichment(
  input_id text,
  input_user_id text,
  input_worker_id text,
  input_error text,
  input_retry_at timestamptz
)
returns void
language sql
security invoker
set search_path = ''
as $$
  update llmovoice.enrichment_jobs
  set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
      available_at = input_retry_at,
      lease_expires_at = null,
      worker_id = null,
      last_error = left(input_error, 2000),
      updated_at = now()
  where id = input_id
    and user_id = input_user_id
    and worker_id = input_worker_id
    and status = 'processing'
$$;

revoke all on schema llmovoice from public, anon;
revoke all on all tables in schema llmovoice from public, anon;
revoke all on all functions in schema llmovoice from public, anon;
grant usage on schema llmovoice to authenticated, service_role;
grant select, insert, update, delete on all tables in schema llmovoice to authenticated, service_role;
grant execute on function llmovoice.match_pages(text, extensions.vector, integer) to authenticated, service_role;
grant execute on function llmovoice.match_threads(text, extensions.vector, integer) to authenticated, service_role;
grant execute on function llmovoice.upsert_thread(text, text, text, jsonb, extensions.vector, text[], timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function llmovoice.claim_enrichment(text, text, integer) to authenticated, service_role;
grant execute on function llmovoice.fail_enrichment(text, text, text, text, timestamptz) to authenticated, service_role;

alter default privileges in schema llmovoice revoke all on tables from public, anon;
alter default privileges in schema llmovoice revoke all on functions from public, anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'llmovoice-audio',
  'llmovoice-audio',
  false,
  26214400,
  array['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/pcm']
)
on conflict (id) do update set public = false;

drop policy if exists llmovoice_audio_select on storage.objects;
create policy llmovoice_audio_select on storage.objects for select to authenticated
  using (bucket_id = 'llmovoice-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists llmovoice_audio_insert on storage.objects;
create policy llmovoice_audio_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'llmovoice-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists llmovoice_audio_update on storage.objects;
create policy llmovoice_audio_update on storage.objects for update to authenticated
  using (bucket_id = 'llmovoice-audio' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'llmovoice-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists llmovoice_audio_delete on storage.objects;
create policy llmovoice_audio_delete on storage.objects for delete to authenticated
  using (bucket_id = 'llmovoice-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
