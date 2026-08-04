begin;

create table if not exists public.agent_state (
  agent_id text primary key,
  schema_version integer not null default 1,
  state jsonb not null,
  feature_flags jsonb not null default '{}'::jsonb,
  last_updated_at timestamptz not null default now(),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.state_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id text not null unique,
  source_kind text not null default 'chat',
  event_type text not null,
  summary text not null,
  appraisal jsonb not null,
  topics text[] not null default '{}',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.state_changes (
  id bigint generated always as identity primary key,
  agent_id text not null references public.agent_state(agent_id) on delete cascade,
  before_state jsonb not null,
  delta jsonb not null,
  after_state jsonb not null,
  mechanism text not null,
  cause_event_id uuid references public.state_events(id) on delete set null,
  state_version bigint not null,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.thoughts (
  id text primary key,
  text text not null,
  drive_key text not null check (drive_key in ('attachment','curiosity','reflection','duty','social','fatigue','libido','stress')),
  kind text not null default 'flit' check (kind in ('flit','fixation')),
  strength double precision not null check (strength between 0 and 1),
  source_event_id text,
  born_at timestamptz not null,
  updated_at timestamptz not null,
  fed_count integer not null default 1,
  status text not null default 'active',
  can_upgrade_to_fixation boolean not null default true
);

create table if not exists public.intents (
  id text primary key,
  source_event_id text,
  want_action text not null,
  drive_key text not null,
  reason text not null,
  score double precision not null check (score between 0 and 1),
  query_hint text,
  selected_at timestamptz not null,
  status text not null default 'active',
  refractory_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.action_log (
  id bigint generated always as identity primary key,
  source_event_id text,
  intent_id text references public.intents(id) on delete set null,
  assistant_message_id text not null unique,
  action_type text not null,
  result jsonb not null default '{}'::jsonb,
  satisfied boolean not null default false,
  drive_delta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.legacy_state_log (
  id bigint generated always as identity primary key,
  source_state_key text not null,
  snapshot jsonb not null,
  captured_at timestamptz not null default now(),
  unique (source_state_key)
);

create table if not exists public.state_token_usage (
  id bigint generated always as identity primary key,
  source_message_id text not null unique,
  provider text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  state_capsule_tokens integer not null default 0,
  event_tokens integer not null default 0,
  estimated boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists state_events_occurred_at_idx on public.state_events (occurred_at desc);
create index if not exists state_changes_agent_created_idx on public.state_changes (agent_id, created_at desc);
create index if not exists thoughts_active_strength_idx on public.thoughts (status, strength desc);
create index if not exists intents_selected_at_idx on public.intents (selected_at desc);

insert into public.legacy_state_log (source_state_key, snapshot)
select state_key, value
from public.app_state
where state_key = 'companion_mood_state_v1'
on conflict (source_state_key) do nothing;

alter table public.agent_state enable row level security;
alter table public.state_events enable row level security;
alter table public.state_changes enable row level security;
alter table public.thoughts enable row level security;
alter table public.intents enable row level security;
alter table public.action_log enable row level security;
alter table public.legacy_state_log enable row level security;
alter table public.state_token_usage enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'agent_state','state_events','state_changes','thoughts','intents',
    'action_log','legacy_state_log','state_token_usage'
  ] loop
    execute format('drop policy if exists leith_session_access on public.%I', table_name);
    execute format(
      'create policy leith_session_access on public.%I for all to anon, authenticated using ((select public.leith_session_valid())) with check ((select public.leith_session_valid()))',
      table_name
    );
  end loop;
end $$;

grant select, insert, update, delete on table public.agent_state to anon, authenticated;
grant select, insert, update, delete on table public.state_events to anon, authenticated;
grant select, insert, update, delete on table public.state_changes to anon, authenticated;
grant select, insert, update, delete on table public.thoughts to anon, authenticated;
grant select, insert, update, delete on table public.intents to anon, authenticated;
grant select, insert, update, delete on table public.action_log to anon, authenticated;
grant select, insert on table public.legacy_state_log to anon, authenticated;
grant select, insert, update on table public.state_token_usage to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

create or replace function public.commit_desire_event_v1(
  p_expected_version bigint,
  p_source_event_id text,
  p_source_kind text,
  p_event jsonb,
  p_before jsonb,
  p_after jsonb,
  p_delta jsonb,
  p_reasons jsonb,
  p_intent jsonb,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version bigint;
  event_row_id uuid;
  thought jsonb;
begin
  if exists (select 1 from public.state_events where source_event_id = p_source_event_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select version into current_version
  from public.agent_state
  where agent_id = 'leith'
  for update;

  if current_version is null or current_version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', current_version);
  end if;

  insert into public.state_events (
    source_event_id, source_kind, event_type, summary, appraisal, topics, occurred_at
  ) values (
    p_source_event_id,
    coalesce(nullif(p_source_kind, ''), 'chat'),
    coalesce(nullif(p_event->>'event_type', ''), 'unclassified'),
    coalesce(p_event->>'summary', ''),
    p_event,
    array(select jsonb_array_elements_text(coalesce(p_event->'topics', '[]'::jsonb))),
    p_occurred_at
  ) returning id into event_row_id;

  update public.agent_state
  set state = p_after,
      version = current_version + 1,
      last_updated_at = (p_after->>'lastUpdatedAt')::timestamptz,
      updated_at = now()
  where agent_id = 'leith' and version = current_version;

  insert into public.state_changes (
    agent_id, before_state, delta, after_state, mechanism, cause_event_id, state_version, reasons
  ) values (
    'leith', p_before, p_delta, p_after, 'event_pulse', event_row_id, current_version + 1, p_reasons
  );

  for thought in select value from jsonb_array_elements(coalesce(p_after->'thoughts', '[]'::jsonb)) loop
    insert into public.thoughts (
      id, text, drive_key, kind, strength, source_event_id, born_at, updated_at,
      fed_count, status, can_upgrade_to_fixation
    ) values (
      thought->>'id', thought->>'text', thought->>'drive_key', coalesce(thought->>'kind', 'flit'),
      (thought->>'strength')::double precision, thought->>'source_event_id',
      (thought->>'born_at')::timestamptz, (thought->>'updated_at')::timestamptz,
      coalesce((thought->>'fed_count')::integer, 1), coalesce(thought->>'status', 'active'),
      coalesce((thought->>'can_upgrade_to_fixation')::boolean, true)
    ) on conflict (id) do update set
      text = excluded.text,
      drive_key = excluded.drive_key,
      kind = excluded.kind,
      strength = excluded.strength,
      updated_at = excluded.updated_at,
      fed_count = excluded.fed_count,
      status = excluded.status;
  end loop;

  if p_intent is not null and p_intent <> 'null'::jsonb then
    insert into public.intents (
      id, source_event_id, want_action, drive_key, reason, score, query_hint, selected_at, status
    ) values (
      p_intent->>'id', p_source_event_id, p_intent->>'want_action', p_intent->>'drive_key',
      p_intent->>'reason', (p_intent->>'score')::double precision, p_intent->>'query_hint',
      (p_intent->>'selected_at')::timestamptz, coalesce(p_intent->>'status', 'active')
    ) on conflict (id) do nothing;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'version', current_version + 1,
    'event_id', event_row_id,
    'intent_id', p_intent->>'id'
  );
exception when unique_violation then
  return jsonb_build_object('status', 'duplicate');
end;
$$;

create or replace function public.complete_desire_action_v1(
  p_expected_version bigint,
  p_assistant_message_id text,
  p_source_event_id text,
  p_intent jsonb,
  p_before jsonb,
  p_after jsonb,
  p_delta jsonb,
  p_reasons jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version bigint;
begin
  if exists (select 1 from public.action_log where assistant_message_id = p_assistant_message_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  select version into current_version from public.agent_state where agent_id = 'leith' for update;
  if current_version is null or current_version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', current_version);
  end if;
  update public.agent_state
  set state = p_after,
      version = current_version + 1,
      last_updated_at = (p_after->>'lastUpdatedAt')::timestamptz,
      updated_at = now()
  where agent_id = 'leith' and version = current_version;
  insert into public.state_changes (
    agent_id, before_state, delta, after_state, mechanism, state_version, reasons
  ) values ('leith', p_before, p_delta, p_after, 'satisfy', current_version + 1, p_reasons);
  update public.intents set status = 'satisfied' where id = p_intent->>'id';
  insert into public.action_log (
    source_event_id, intent_id, assistant_message_id, action_type, result, satisfied, drive_delta
  ) values (
    p_source_event_id, p_intent->>'id', p_assistant_message_id,
    coalesce(p_intent->>'want_action', 'reply'), '{}'::jsonb, true, p_delta
  );
  return jsonb_build_object('status', 'ok', 'version', current_version + 1);
exception when unique_violation then
  return jsonb_build_object('status', 'duplicate');
end;
$$;

grant execute on function public.commit_desire_event_v1(bigint,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz) to anon, authenticated;
grant execute on function public.complete_desire_action_v1(bigint,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) to anon, authenticated;

commit;
