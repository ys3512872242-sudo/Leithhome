create index if not exists action_log_intent_id_idx on public.action_log (intent_id);
create index if not exists state_changes_cause_event_id_idx on public.state_changes (cause_event_id);
