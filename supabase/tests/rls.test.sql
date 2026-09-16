begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

select lives_ok(
  $$insert into llmovoice.pages
    (id, user_id, session_id, sequence, status, payload, created_at, updated_at)
    values (
      'rls-page-a', '11111111-1111-4111-8111-111111111111', 'rls-session-a', 1, 'complete',
      '{"id":"rls-page-a"}'::jsonb, now(), now()
    )$$,
  'user A can create its own Page'
);

select lives_ok(
  $$insert into llmovoice.threads
    (id, user_id, status, payload, created_at, updated_at, last_active_at)
    values (
      'rls-thread-a', '11111111-1111-4111-8111-111111111111', 'active',
      '{"id":"rls-thread-a"}'::jsonb, now(), now(), now()
    )$$,
  'user A can create its own Thread'
);

select lives_ok(
  $$insert into llmovoice.traces
    (id, user_id, session_id, type, payload, created_at)
    values (
      'rls-trace-a', '11111111-1111-4111-8111-111111111111', 'rls-session-a',
      'page.created', '{"id":"rls-trace-a"}'::jsonb, now()
    )$$,
  'user A can create its own Trace'
);

select is((select count(*)::integer from llmovoice.pages), 1, 'user A can read its Page');

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);

select is((select count(*)::integer from llmovoice.pages), 0, 'user B cannot read user A Pages');
select is((select count(*)::integer from llmovoice.threads), 0, 'user B cannot read user A Threads');
select is((select count(*)::integer from llmovoice.traces), 0, 'user B cannot read user A Traces');

select * from finish();
rollback;
