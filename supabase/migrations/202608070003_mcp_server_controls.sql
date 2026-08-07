-- Per-server MCP switch and optional private authentication header.
alter table public.mcp_servers_private
  add column if not exists enabled boolean not null default false,
  add column if not exists auth_header_name text,
  add column if not exists auth_header_value text;

comment on column public.mcp_servers_private.enabled is
  'Independent server switch. The global gateway switch must also be enabled.';
comment on column public.mcp_servers_private.auth_header_name is
  'Optional outbound MCP authentication header name; service-role only.';
comment on column public.mcp_servers_private.auth_header_value is
  'Optional outbound MCP authentication value; never returned to clients or logs.';

alter table public.mcp_servers_private
  drop constraint if exists mcp_servers_private_auth_header_name_check;
alter table public.mcp_servers_private
  add constraint mcp_servers_private_auth_header_name_check
  check (
    auth_header_name is null
    or auth_header_name ~* '^(authorization|x-api-key|api-key|x-auth-token)$'
  );

revoke all on public.mcp_servers_private from anon, authenticated;
