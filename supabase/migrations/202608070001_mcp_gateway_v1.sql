begin;
create table if not exists public.mcp_call_log (
  id bigint generated always as identity primary key,
  request_id text not null unique,
  tool_name text not null,
  permission text not null check (permission in ('read', 'write')),
  status text not null check (status in ('success', 'error', 'denied')),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  error_message text,
  created_at timestamptz not null default now()
);
alter table public.mcp_call_log enable row level security;
grant select on public.mcp_call_log to anon, authenticated;
revoke insert, update, delete on public.mcp_call_log from anon, authenticated;
drop policy if exists "leith unlocked read mcp logs" on public.mcp_call_log;
create policy "leith unlocked read mcp logs" on public.mcp_call_log for select to anon, authenticated using ((select public.leith_session_valid()));
create index if not exists mcp_call_log_created_at_idx on public.mcp_call_log (created_at desc);
insert into public.app_state (state_key, value, updated_at)
values ('leith_mcp_gateway_settings_v1','{"enabled":false,"tools":{"system.status":{"enabled":true,"permission":"read"}}}'::jsonb,now())
on conflict (state_key) do nothing;
commit;
