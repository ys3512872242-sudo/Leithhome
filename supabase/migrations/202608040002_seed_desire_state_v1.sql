insert into public.agent_state (
  agent_id, schema_version, state, feature_flags, last_updated_at, version
)
values (
  'leith',
  1,
  jsonb_build_object(
    'schemaVersion', 1,
    'version', 0,
    'drives', jsonb_build_object(
      'attachment', 0.42, 'curiosity', 0.48, 'reflection', 0.34, 'duty', 0.40,
      'social', 0.28, 'fatigue', 0.25,
      'libido', coalesce(((select snapshot->'leith'->>'desire' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.30),
      'stress', 0.20
    ),
    'affect', jsonb_build_object(
      'happiness', coalesce(((select snapshot->'leith'->>'joy' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.66),
      'anger', coalesce(((select snapshot->'leith'->>'anger' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.06),
      'grievance', coalesce(((select snapshot->'leith'->>'grievance' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.08)
    ),
    'baselines', jsonb_build_object(
      'drives', jsonb_build_object(
        'attachment', 0.42, 'curiosity', 0.48, 'reflection', 0.34, 'duty', 0.40,
        'social', 0.28, 'fatigue', 0.25,
        'libido', coalesce(((select snapshot->'leith'->>'desire' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.30),
        'stress', 0.20
      ),
      'affect', jsonb_build_object(
        'happiness', coalesce(((select snapshot->'leith'->>'joy' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.66),
        'anger', coalesce(((select snapshot->'leith'->>'anger' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.06),
        'grievance', coalesce(((select snapshot->'leith'->>'grievance' from public.legacy_state_log where source_state_key = 'companion_mood_state_v1')::numeric - 1) / 6, 0.08)
      )
    ),
    'refractory', '{}'::jsonb,
    'thoughts', '[]'::jsonb,
    'recentEvents', '[]'::jsonb,
    'intent', null,
    'lastUpdatedAt', to_jsonb(now()::text)
  ),
  jsonb_build_object(
    'stateEngine', true, 'eventEnvelope', true, 'promptInfluence', true,
    'cloudPersistence', true, 'observationCard', true, 'autonomousMurmur', false,
    'complexCoupling', false, 'baselineDrift', false, 'wildcard', false,
    'fixationFeedback', false, 'externalTools', false, 'live2d', false, 'deviceEvents', false
  ),
  now(),
  0
)
on conflict (agent_id) do nothing;
