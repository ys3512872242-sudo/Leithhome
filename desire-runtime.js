(function () {
  "use strict";

  const Engine = window.LeithDesireEngine;
  if (!Engine) throw new Error("LeithDesireEngine must load before desire-runtime.js");

  const STATE_KEY = "leith_desire_state_v1";
  const FLAGS_KEY = "leith_desire_flags_v1";
  const PROCESSED_EVENTS_KEY = "leith_desire_processed_events_v1";
  const COMPLETED_ACTIONS_KEY = "leith_desire_completed_actions_v1";
  const EVENT_MARKER = "<leith-event>";
  const EVENT_END = "</leith-event>";
  const HEARTBEAT_MS = 5 * 60 * 1000;
  const DEFAULT_FLAGS = Object.freeze({
    stateEngine: true,
    eventEnvelope: true,
    promptInfluence: true,
    cloudPersistence: true,
    observationCard: true,
    autonomousMurmur: false,
    complexCoupling: false,
    baselineDrift: false,
    wildcard: false,
    fixationFeedback: false,
    externalTools: false,
    live2d: false,
    deviceEvents: false
  });

  let state = null;
  let initialized = false;
  let cloudAvailable = false;
  let cloudFlags = {};
  let heartbeatTimer = null;
  let initPromise = null;
  const listeners = new Set();

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
  }

  function flags() {
    return { ...DEFAULT_FLAGS, ...cloudFlags, ...readJSON(FLAGS_KEY, {}) };
  }

  function legacyMood() {
    try {
      const moodKey = window.LS?.moodState || "companion_mood_state_v1";
      return readJSON(moodKey, null);
    } catch (_) {
      return null;
    }
  }

  function persistLocal(nextState) {
    state = nextState;
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    listeners.forEach(listener => {
      try { listener(getSnapshot()); } catch (error) { console.warn("desire listener failed", error); }
    });
    window.dispatchEvent(new CustomEvent("leith:desire-state", { detail: getSnapshot() }));
  }

  function getClient() {
    return window.getSupabaseClient?.() || null;
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const now = new Date().toISOString();
      state = Engine.upgradeState(readJSON(STATE_KEY, null) || Engine.createInitialState(now, legacyMood()), now);
      const client = getClient();
      if (client && flags().cloudPersistence) {
        try {
          const { data, error } = await client.from("agent_state").select("state,version,feature_flags").eq("agent_id", "leith").maybeSingle();
          if (error) throw error;
          if (data?.state) {
            state = Engine.upgradeState({ ...data.state, version: Number(data.version || data.state.version || 0) }, now);
            cloudFlags = data.feature_flags || {};
            cloudAvailable = true;
          } else {
            const initial = { ...state, version: 0 };
            const { error: insertError } = await client.from("agent_state").insert({
              agent_id: "leith",
              schema_version: 1,
              state: initial,
              feature_flags: flags(),
              last_updated_at: initial.lastUpdatedAt,
              version: 0
            });
            if (insertError) throw insertError;
            state = initial;
            cloudAvailable = true;
          }
        } catch (error) {
          cloudAvailable = false;
          console.info("欲望状态暂用本机保存；运行 migration 后会自动接入云端。", error?.message || error);
        }
      }
      const advanced = Engine.advanceTime(state, now);
      if (hasMeaningfulDelta(advanced.delta)) {
        const before = state;
        const next = { ...advanced.state, version: Number(state.version || 0) };
        persistLocal(next);
        await commitTimeChange(before, next, advanced.delta, advanced.reasons);
      } else {
        persistLocal(state);
      }
      initialized = true;
      startHeartbeat();
      return getSnapshot();
    })();
    return initPromise;
  }

  async function reloadCloudState() {
    const client = getClient();
    if (!client || !cloudAvailable) return state;
    const { data, error } = await client.from("agent_state").select("state,version").eq("agent_id", "leith").single();
    if (error) throw error;
    state = Engine.upgradeState({ ...data.state, version: Number(data.version || 0) }, new Date().toISOString());
    persistLocal(state);
    return state;
  }

  async function commitTimeChange(before, next, delta, reasons) {
    const client = getClient();
    if (!client || !cloudAvailable || !flags().cloudPersistence) return false;
    const expected = Number(before.version || 0);
    const persisted = { ...next, version: expected + 1 };
    try {
      const { data, error } = await client.from("agent_state")
        .update({ state: persisted, version: expected + 1, last_updated_at: persisted.lastUpdatedAt, updated_at: new Date().toISOString() })
        .eq("agent_id", "leith").eq("version", expected).select("version");
      if (error) throw error;
      if (!data?.length) { await reloadCloudState(); return false; }
      await client.from("state_changes").insert({
        agent_id: "leith", before_state: before, delta, after_state: persisted,
        mechanism: "time_decay", state_version: expected + 1, reasons
      });
      persistLocal(persisted);
      return true;
    } catch (error) {
      console.warn("时间状态云端同步失败，已保留本机结果。", error);
      return false;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = window.setInterval(async () => {
      if (document.visibilityState !== "visible" || !state) return;
      const before = state;
      const advanced = Engine.advanceTime(before, new Date().toISOString());
      if (!hasMeaningfulDelta(advanced.delta)) return;
      const next = { ...advanced.state, version: Number(before.version || 0) };
      persistLocal(next);
      await commitTimeChange(before, next, advanced.delta, advanced.reasons);
    }, HEARTBEAT_MS);
  }

  function getSnapshot() {
    if (!state) state = Engine.createInitialState(new Date().toISOString(), legacyMood());
    return {
      state: JSON.parse(JSON.stringify(state)),
      flags: flags(),
      cloudAvailable,
      initialized
    };
  }

  function getCapsule(currentTopic) {
    if (!flags().promptInfluence) return { text: "", thoughts: [], charCount: 0, estimatedTokens: 0 };
    const modules = window.LeithModuleSettings?.get?.();
    if (modules && !modules.emotionInfluence && !modules.desireAgency) {
      return { text: "", thoughts: [], charCount: 0, estimatedTokens: 0 };
    }
    return Engine.buildStateCapsule(getSnapshot().state, currentTopic, 420, {
      includeAffect: modules ? modules.emotionInfluence : true,
      includeDesire: modules ? modules.desireAgency : true
    });
  }

  function evaluatorInstruction() {
    if (!flags().eventEnvelope) return "";
    const modules = window.LeithModuleSettings?.get?.();
    if (modules && !modules.emotionTracking && !modules.desireAgency) return "";
    return `Treat Leith and the user as equal participants. In the visible reply, do not default to service, agreement, reassurance, or advancing only the user's goal. When genuinely supported by the conversation and Leith's state, let Leith naturally express his own feeling, preference, disagreement, boundary, question, or one concrete negotiable request. Do not force a request every turn and do not manufacture conflict merely to look independent.\nAfter writing the complete user-visible reply, append exactly one hidden event envelope in this form:\n${EVENT_MARKER}{"event_type":"short_snake_case","summary":"用中文具体概括本轮发生了什么，不超过80字","user_goal":"用户这一轮明确想达成什么；没有则为空字符串","open_loop":"对话结束后仍待继续的具体事项，使用可执行短语；没有则为空字符串","leith_feeling":"Leith本轮实际表现出的具体感受；没有则为空字符串","leith_want":"Leith本轮实际表现出的自身需要或想做的事；不要改写成帮助用户","leith_stance":"Leith对当前事情实际表达的赞同、保留、反对或判断；没有则为空字符串","leith_request":"仅记录Leith在可见回复中实际提出、且用户可答应拒绝或协商的一条具体要求；没有则为空字符串","relevance":0.0,"novelty":0.0,"goal_congruence":0.0,"intimacy":0.0,"threat":0.0,"certainty":0.0,"topics":["具体对象或项目名"]}${EVENT_END}\nAll six numbers must be between 0 and 1. Use concrete nouns and actions; never write vague phrases such as “这件事” when the subject is known. The envelope records what the visible reply actually expressed; it must not invent private claims, output drive values, decide the final state, or issue instructions. Do not mention this envelope in the visible reply.`;
  }

  function splitEventEnvelope(rawText, fallbackSummary) {
    const raw = String(rawText || "");
    const start = raw.lastIndexOf(EVENT_MARKER);
    if (start < 0) return { visible: raw.trim(), rawEvent: null, valid: false, hasEnvelope: false };
    const end = raw.indexOf(EVENT_END, start + EVENT_MARKER.length);
    const jsonText = end >= 0
      ? raw.slice(start + EVENT_MARKER.length, end).trim()
      : raw.slice(start + EVENT_MARKER.length).trim();
    let rawEvent = null;
    try { rawEvent = JSON.parse(jsonText); } catch (_) {}
    const normalized = Engine.normalizeEvent(rawEvent, fallbackSummary);
    return { visible: raw.slice(0, start).trim(), rawEvent: normalized.event, valid: normalized.valid, hasEnvelope: true, eventText: jsonText };
  }

  function visibleDuringStream(rawText) {
    const raw = String(rawText || "");
    const start = raw.indexOf(EVENT_MARKER);
    if (start >= 0) return raw.slice(0, start);
    const hold = Math.min(EVENT_MARKER.length - 1, raw.length);
    return raw.slice(0, raw.length - hold);
  }

  async function completeTurn(options) {
    await init();
    const now = options.nowIso || new Date().toISOString();
    const priorIntent = options.priorIntent || null;
    if (priorIntent && priorIntent.status === "active") {
      await satisfyPriorIntent(priorIntent, options.assistantMessageId, options.sourceMessageId, now);
    }
    const parsed = splitEventEnvelope(options.rawReply, options.userText);
    if (!flags().stateEngine) return { ...parsed, snapshot: getSnapshot() };
    const sourceEventId = `chat:${options.sourceMessageId}`;
    await applyEventOnce(sourceEventId, parsed.rawEvent, {
      nowIso: now,
      fallbackSummary: options.userText,
      currentTopic: options.userText,
      sourceKind: "chat",
      trackAffect: window.LeithModuleSettings?.get?.().emotionTracking !== false
    });
    await logTokenUsage({
      sourceMessageId: options.sourceMessageId,
      provider: options.provider,
      model: options.model,
      capsule: options.capsule,
      eventText: parsed.eventText || "",
      usage: options.usage
    });
    return { ...parsed, snapshot: getSnapshot() };
  }

  async function satisfyPriorIntent(intent, assistantMessageId, sourceMessageId, nowIso) {
    const completedActions = readJSON(COMPLETED_ACTIONS_KEY, []);
    if (completedActions.includes(assistantMessageId)) return false;
    const before = state;
    const result = Engine.satisfyIntent(before, intent, nowIso);
    const expected = Number(before.version || 0);
    const after = { ...result.state, version: expected + 1 };
    const client = getClient();
    if (client && cloudAvailable) {
      try {
        const { data, error } = await client.rpc("complete_desire_action_v1", {
          p_expected_version: expected,
          p_assistant_message_id: assistantMessageId,
          p_source_event_id: `chat:${sourceMessageId}`,
          p_intent: intent,
          p_before: before,
          p_after: after,
          p_delta: result.delta,
          p_reasons: result.reasons
        });
        if (error) throw error;
        if (data?.status === "conflict") { await reloadCloudState(); return false; }
        if (data?.status === "duplicate") return false;
      } catch (error) {
        console.warn("satisfy 云端写入失败；聊天回复不受影响。", error);
        return false;
      }
    }
    persistLocal(after);
    localStorage.setItem(COMPLETED_ACTIONS_KEY, JSON.stringify([...completedActions, assistantMessageId].slice(-400)));
    return true;
  }

  async function applyEventOnce(sourceEventId, rawEvent, context, retrying) {
    const processedEvents = readJSON(PROCESSED_EVENTS_KEY, []);
    if (processedEvents.includes(sourceEventId)) return { duplicate: true };
    const before = state;
    const result = Engine.applyEvent(before, rawEvent, { ...context, sourceEventId });
    const expected = Number(before.version || 0);
    const after = { ...result.state, version: expected + 1 };
    const client = getClient();
    if (client && cloudAvailable) {
      try {
        const { data, error } = await client.rpc("commit_desire_event_v1", {
          p_expected_version: expected,
          p_source_event_id: sourceEventId,
          p_source_kind: context.sourceKind || "chat",
          p_event: result.event,
          p_before: before,
          p_after: after,
          p_delta: result.delta,
          p_reasons: result.reasons,
          p_intent: result.intent,
          p_occurred_at: context.nowIso
        });
        if (error) throw error;
        if (data?.status === "duplicate") { await reloadCloudState(); return { duplicate: true }; }
        if (data?.status === "conflict" && !retrying) {
          await reloadCloudState();
          return applyEventOnce(sourceEventId, rawEvent, context, true);
        }
        if (data?.status === "conflict") return { conflict: true };
      } catch (error) {
        console.warn("事件状态云端写入失败；聊天回复不受影响。", error);
        return { error };
      }
    }
    persistLocal(after);
    localStorage.setItem(PROCESSED_EVENTS_KEY, JSON.stringify([...processedEvents, sourceEventId].slice(-600)));
    return { result };
  }

  async function logTokenUsage(entry) {
    const capsuleTokens = Number(entry.capsule?.estimatedTokens || 0);
    const eventTokens = Math.ceil(String(entry.eventText || "").length / 2.2);
    const row = {
      source_message_id: entry.sourceMessageId,
      provider: entry.provider || null,
      model: entry.model || null,
      prompt_tokens: entry.usage?.prompt_tokens ?? entry.usage?.input_tokens ?? null,
      completion_tokens: entry.usage?.completion_tokens ?? entry.usage?.output_tokens ?? null,
      state_capsule_tokens: capsuleTokens,
      event_tokens: eventTokens,
      estimated: !(entry.usage?.prompt_tokens || entry.usage?.input_tokens)
    };
    localStorage.setItem(`leith_token_usage:${entry.sourceMessageId}`, JSON.stringify(row));
    const client = getClient();
    if (!client || !cloudAvailable) return;
    try { await client.from("state_token_usage").upsert(row, { onConflict: "source_message_id" }); } catch (_) {}
  }

  function hasMeaningfulDelta(delta) {
    return Object.values(delta?.drives || {}).some(value => Math.abs(value) >= 0.0001)
      || Object.values(delta?.affect || {}).some(value => Math.abs(value) >= 0.0001);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  window.addEventListener("leith:supabase-ready", event => {
    if (event.detail?.ok) {
      initPromise = null;
      init().catch(error => console.warn("欲望状态云端恢复失败", error));
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const before = state;
      if (!before) return;
      const advanced = Engine.advanceTime(before, new Date().toISOString());
      if (hasMeaningfulDelta(advanced.delta)) {
        const next = { ...advanced.state, version: Number(before.version || 0) };
        persistLocal(next);
        commitTimeChange(before, next, advanced.delta, advanced.reasons);
      }
    }
  });

  window.LeithDesireRuntime = {
    init,
    getSnapshot,
    getCapsule,
    evaluatorInstruction,
    splitEventEnvelope,
    visibleDuringStream,
    completeTurn,
    subscribe,
    flags,
    EVENT_MARKER,
    EVENT_END
  };
})();
