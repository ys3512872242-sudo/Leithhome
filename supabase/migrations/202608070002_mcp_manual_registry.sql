begin;
create table if not exists public.mcp_servers_private (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[A-Za-z0-9_-]{2,40}$'),
  endpoint text not null,
  host text not null,
  tools jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mcp_servers_private enable row level security;
revoke all on public.mcp_servers_private from anon, authenticated;
comment on table public.mcp_servers_private is 'Service-role-only MCP endpoints. Never expose endpoint through Data API responses or logs.';
commit;
