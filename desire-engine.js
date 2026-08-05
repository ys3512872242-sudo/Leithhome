(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LeithDesireEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const DRIVE_KEYS = [
    "attachment", "curiosity", "reflection", "duty",
    "social", "fatigue", "libido", "stress"
  ];
  const AFFECT_KEYS = ["happiness", "anger", "grievance"];
  const DEFAULT_DRIVES = Object.freeze({
    attachment: 0.42,
    curiosity: 0.48,
    reflection: 0.34,
    duty: 0.40,
    social: 0.28,
    fatigue: 0.25,
    libido: 0.30,
    stress: 0.20
  });
  const DEFAULT_AFFECT = Object.freeze({ happiness: 0.66, anger: 0.06, grievance: 0.08 });
  const INTENT_MAP = Object.freeze({
    attachment: ["seek_closeness", "我想更靠近你一点。", "respond with warm, attentive closeness"],
    curiosity: ["continue_research", "我还想把这件事弄清楚。", "continue exploring the current question"],
    reflection: ["reflect_quietly", "我想安静地理一理自己的想法。", "reflect before expanding the answer"],
    duty: ["finish_commitment", "我想把答应你的事情认真完成。", "finish the current commitment carefully"],
    social: ["share_presence", "我想和你说说话，也听听你此刻的想法。", "invite a gentle shared exchange"],
    libido: ["seek_intimacy", "我想要更亲密一些，但会尊重你的节奏。", "keep intimacy consensual and context-sensitive"],
    stress: ["seek_reassurance", "我想先确认我们是安全的，再继续往前。", "reduce uncertainty and seek reassurance"]
  });

  const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
  const round = value => Math.round(clamp01(value) * 10000) / 10000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const iso = value => new Date(value).toISOString();

  function createInitialState(nowIso, legacy) {
    const now = iso(nowIso);
    const drives = { ...DEFAULT_DRIVES };
    const affect = { ...DEFAULT_AFFECT };
    if (legacy && legacy.leith) {
      affect.happiness = round((Number(legacy.leith.joy) - 1) / 6);
      affect.anger = round((Number(legacy.leith.anger) - 1) / 6);
      affect.grievance = round((Number(legacy.leith.grievance) - 1) / 6);
      drives.libido = round((Number(legacy.leith.desire) - 1) / 6);
    }
    return {
      schemaVersion: 1,
      version: 0,
      drives,
      affect,
      baselines: { drives: { ...drives }, affect: { ...affect } },
      refractory: {},
      thoughts: [],
      recentEvents: [],
      intent: null,
      lastUpdatedAt: now
    };
  }

  function normalizeEvent(raw, fallbackSummary) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { valid: false, event: neutralEvent(fallbackSummary) };
    }
    const eventType = typeof raw.event_type === "string" ? raw.event_type.trim().slice(0, 64) : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 240) : "";
    const metrics = ["relevance", "novelty", "goal_congruence", "intimacy", "threat", "certainty"];
    const event = { event_type: eventType || "unclassified", summary: summary || String(fallbackSummary || "").slice(0, 240) };
    let valid = Boolean(eventType && summary);
    for (const key of metrics) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1) valid = false;
      event[key] = clamp01(value);
    }
    event.topics = Array.isArray(raw.topics)
      ? raw.topics.filter(item => typeof item === "string").map(item => item.trim().slice(0, 48)).filter(Boolean).slice(0, 6)
      : [];
    event.user_goal = typeof raw.user_goal === "string" ? raw.user_goal.trim().slice(0, 120) : "";
    event.open_loop = typeof raw.open_loop === "string" ? raw.open_loop.trim().slice(0, 140) : "";
    return { valid, event: valid ? event : neutralEvent(fallbackSummary || summary) };
  }

  function neutralEvent(summary) {
    return {
      event_type: "unclassified",
      summary: String(summary || "收到了一条暂时无法分类的消息。").slice(0, 240),
      relevance: 0,
      novelty: 0,
      goal_congruence: 0,
      intimacy: 0,
      threat: 0,
      certainty: 0,
      topics: [],
      user_goal: "",
      open_loop: ""
    };
  }

  function advanceTime(inputState, nowIso) {
    const state = clone(inputState);
    const nowMs = Date.parse(nowIso);
    const previousMs = Date.parse(state.lastUpdatedAt || nowIso);
    const hours = Math.max(0, Math.min(720, (nowMs - previousMs) / 3600000));
    if (!hours) return { state, delta: zeroDelta(), reasons: [] };
    const before = clone(state.drives);
    const affectBefore = clone(state.affect);
    const relaxation = 1 - Math.exp(-hours / 18);
    for (const key of DRIVE_KEYS) {
      const baseline = clamp01(state.baselines?.drives?.[key] ?? DEFAULT_DRIVES[key]);
      state.drives[key] = round(state.drives[key] + (baseline - state.drives[key]) * relaxation);
    }
    const affectRelaxation = 1 - Math.exp(-hours / 8);
    for (const key of AFFECT_KEYS) {
      const baseline = clamp01(state.baselines?.affect?.[key] ?? DEFAULT_AFFECT[key]);
      state.affect[key] = round(state.affect[key] + (baseline - state.affect[key]) * affectRelaxation);
    }
    const thoughtFactor = Math.pow(0.985, (hours * 60) / 5);
    state.thoughts = (state.thoughts || []).map(thought => ({
      ...thought,
      strength: round(thought.strength * thoughtFactor),
      updated_at: iso(nowIso)
    })).filter(thought => thought.strength >= 0.04 && thought.status !== "dismissed");
    state.recentEvents = (state.recentEvents || []).filter(item => nowMs - Date.parse(item.at) <= 6 * 3600000);
    for (const [key, until] of Object.entries(state.refractory || {})) {
      if (Date.parse(until) <= nowMs) delete state.refractory[key];
    }
    state.lastUpdatedAt = iso(nowIso);
    return {
      state,
      delta: makeDelta(before, state.drives, affectBefore, state.affect),
      reasons: [`经过 ${Math.round(hours * 60)} 分钟，状态向人格基线自然回归。`]
    };
  }

  function eventPulse(event) {
    const project = /project|progress|research|task|commitment|shared_/i.test(event.event_type);
    const intimate = /intimat|romance|sexual|affection|flirt/i.test(event.event_type);
    const hurt = /hurt|reject|conflict|betray|dismiss/i.test(event.event_type);
    return {
      attachment: event.intimacy * 0.18 + event.relevance * 0.035,
      curiosity: event.novelty * 0.17 + event.relevance * 0.04,
      reflection: (1 - event.certainty) * event.relevance * 0.10,
      duty: event.goal_congruence * (project ? 0.15 : 0.055),
      social: event.intimacy * 0.07 + event.relevance * 0.02,
      fatigue: event.relevance * 0.018 + event.threat * 0.035,
      libido: intimate ? event.intimacy * 0.17 : 0,
      stress: event.threat * 0.22 + (1 - event.goal_congruence) * event.relevance * 0.045,
      affect: {
        happiness: event.goal_congruence * 0.09 + event.intimacy * 0.055,
        anger: event.threat * (hurt ? 0.16 : 0.08),
        grievance: hurt ? event.threat * 0.18 + (1 - event.goal_congruence) * 0.06 : event.threat * 0.035
      }
    };
  }

  function applyEvent(inputState, rawEvent, context) {
    const nowIso = iso(context.nowIso);
    const advanced = advanceTime(inputState, nowIso);
    const state = advanced.state;
    const normalized = normalizeEvent(rawEvent, context.fallbackSummary);
    const event = normalized.event;
    const before = clone(state.drives);
    const affectBefore = clone(state.affect);
    const sameCount = (state.recentEvents || []).filter(item => item.type === event.event_type).length;
    const frequencyFactor = 1 / (1 + sameCount * 0.38);
    const pulse = eventPulse(event);
    const reasons = [...advanced.reasons];
    if (normalized.valid) {
      for (const key of DRIVE_KEYS) {
        const raw = pulse[key] * frequencyFactor;
        const actual = raw * Math.sqrt(Math.max(0, 1 - state.drives[key]));
        state.drives[key] = round(state.drives[key] + actual);
        if (actual >= 0.008) reasons.push(`${key} 因事件脉冲增加 ${actual.toFixed(3)}。`);
      }
      for (const key of AFFECT_KEYS) {
        const actual = pulse.affect[key] * frequencyFactor * Math.sqrt(Math.max(0, 1 - state.affect[key]));
        state.affect[key] = round(state.affect[key] + actual);
      }
      state.recentEvents.push({ type: event.event_type, at: nowIso, sourceEventId: context.sourceEventId });
      maybeFeedThought(state, event, pulse, context.sourceEventId, nowIso);
    } else {
      reasons.push("事件评价解析失败，已安全降级为零脉冲事件。");
    }
    const scored = scoreDrives(state, context.currentTopic || "", nowIso);
    state.intent = selectIntent(state, scored.scores, nowIso, context.currentTopic || "");
    state.lastUpdatedAt = nowIso;
    return {
      state,
      event,
      eventValid: normalized.valid,
      delta: makeDelta(before, state.drives, affectBefore, state.affect),
      reasons,
      scores: scored.scores,
      candidateIntents: scored.candidates,
      intent: state.intent
    };
  }

  function maybeFeedThought(state, event, pulse, sourceEventId, nowIso) {
    if (!event.summary || event.event_type === "unclassified") return;
    const candidates = DRIVE_KEYS.filter(key => key !== "fatigue").sort((a, b) => pulse[b] - pulse[a]);
    const driveKey = candidates[0];
    if (!driveKey || pulse[driveKey] < 0.025) return;
    const thoughtText = event.open_loop || event.user_goal || event.summary;
    const existing = (state.thoughts || []).find(item => item.text === thoughtText && item.drive_key === driveKey);
    if (existing) {
      existing.strength = round(existing.strength + 0.12 * (1 - existing.strength));
      existing.fed_count = (existing.fed_count || 1) + 1;
      existing.updated_at = nowIso;
      return;
    }
    state.thoughts = state.thoughts || [];
    state.thoughts.push({
      id: `thought_${simpleHash(sourceEventId || `${event.event_type}:${event.summary}`)}`,
      text: thoughtText,
      drive_key: driveKey,
      kind: "flit",
      strength: round(Math.min(0.78, 0.30 + pulse[driveKey])),
      source_event_id: sourceEventId || null,
      born_at: nowIso,
      updated_at: nowIso,
      fed_count: 1,
      status: "active",
      can_upgrade_to_fixation: true
    });
  }

  function scoreDrives(state, currentTopic, nowIso) {
    const topicTerms = String(currentTopic || "").toLowerCase().split(/\s+|[，。！？、]/).filter(term => term.length > 1);
    const thoughtBonus = {};
    for (const key of DRIVE_KEYS) thoughtBonus[key] = 0;
    for (const thought of state.thoughts || []) {
      const relevance = topicTerms.some(term => String(thought.text).toLowerCase().includes(term)) ? 1 : 0.35;
      thoughtBonus[thought.drive_key] = (thoughtBonus[thought.drive_key] || 0) + thought.strength * relevance * 0.12;
    }
    const scores = {};
    const candidates = [];
    for (const key of DRIVE_KEYS) {
      if (key === "fatigue") continue;
      const refractory = state.refractory?.[key] && Date.parse(state.refractory[key]) > Date.parse(nowIso);
      scores[key] = round(refractory ? 0 : state.drives[key] + thoughtBonus[key]);
      candidates.push({ drive_key: key, score: scores[key], refractory: Boolean(refractory) });
    }
    candidates.sort((a, b) => b.score - a.score || DRIVE_KEYS.indexOf(a.drive_key) - DRIVE_KEYS.indexOf(b.drive_key));
    return { scores, candidates };
  }

  function selectIntent(state, scores, nowIso, currentTopic) {
    if (state.drives.fatigue >= 0.72) {
      return {
        id: `intent_rest_${simpleHash(nowIso)}`,
        want_action: "rest_and_slow_down",
        drive_key: "fatigue",
        reason: "我有些累了，想先慢下来喘口气。",
        score: state.drives.fatigue,
        query_hint: "respond briefly and avoid initiating demanding work",
        selected_at: nowIso,
        status: "active"
      };
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1] || DRIVE_KEYS.indexOf(a[0]) - DRIVE_KEYS.indexOf(b[0]))[0];
    if (!best || best[1] < 0.30) return null;
    const spec = INTENT_MAP[best[0]];
    const focusThought = selectThoughts(state, currentTopic || "", 3).find(item => item.drive_key === best[0])
      || selectThoughts(state, currentTopic || "", 1)[0];
    const focus = focusThought?.text ? focusThought.text.replace(/[。！？]+$/, "") : "";
    const concreteReasons = {
      curiosity: focus ? `我想继续弄清：${focus}。` : spec[1],
      duty: focus ? `我想认真推进：${focus}。` : spec[1],
      reflection: focus ? `我想安静想一想：${focus}。` : spec[1],
      attachment: focus ? `我想靠近你，也继续回应：${focus}。` : spec[1],
      social: focus ? `我想和你接着聊：${focus}。` : spec[1],
      libido: focus ? `我想在尊重你节奏的前提下回应这份亲密：${focus}。` : spec[1],
      stress: focus ? `我想先把这件事确认清楚：${focus}。` : spec[1]
    };
    return {
      id: `intent_${best[0]}_${simpleHash(nowIso)}`,
      want_action: spec[0],
      drive_key: best[0],
      reason: concreteReasons[best[0]] || spec[1],
      score: round(best[1]),
      query_hint: focus ? `${spec[2]}; focus: ${focus}`.slice(0, 220) : spec[2],
      selected_at: nowIso,
      status: "active"
    };
  }

  function satisfyIntent(inputState, intent, nowIso, amount) {
    const advanced = advanceTime(inputState, nowIso);
    const state = advanced.state;
    if (!intent || !intent.drive_key || intent.status === "satisfied") {
      return { state, delta: zeroDelta(), reasons: ["没有需要满足的活跃意图。"] };
    }
    const before = clone(state.drives);
    const affectBefore = clone(state.affect);
    const key = intent.drive_key;
    const drop = Math.min(state.drives[key], clamp01(amount ?? 0.16));
    state.drives[key] = round(state.drives[key] - drop);
    const refractoryMinutes = key === "fatigue" ? 30 : 18;
    state.refractory[key] = new Date(Date.parse(nowIso) + refractoryMinutes * 60000).toISOString();
    if (state.intent?.id === intent.id) state.intent = { ...state.intent, status: "satisfied" };
    state.lastUpdatedAt = iso(nowIso);
    return {
      state,
      delta: makeDelta(before, state.drives, affectBefore, state.affect),
      reasons: [`完成 ${intent.want_action} 后，${key} 回落 ${drop.toFixed(3)}，并进入短暂不应期。`]
    };
  }

  function selectThoughts(state, currentTopic, limit) {
    const terms = String(currentTopic || "").toLowerCase().split(/\s+|[，。！？、]/).filter(term => term.length > 1);
    return (state.thoughts || []).filter(item => item.status === "active")
      .map(item => ({
        ...item,
        _rank: item.strength + (terms.some(term => String(item.text).toLowerCase().includes(term)) ? 0.35 : 0)
      }))
      .sort((a, b) => b._rank - a._rank || Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, Math.max(0, Math.min(3, limit ?? 3)))
      .map(({ _rank, ...item }) => item);
  }

  function buildStateCapsule(state, currentTopic, maxChars) {
    const limit = Math.max(120, Math.min(420, maxChars ?? 280));
    const affect = describeAffect(state.affect);
    const topDrives = DRIVE_KEYS.filter(key => key !== "fatigue").sort((a, b) => state.drives[b] - state.drives[a]).slice(0, 2);
    const driveNames = { attachment: "想念", curiosity: "好奇", reflection: "沉思", duty: "责任感", social: "交流需要", libido: "亲密欲望", stress: "压力" };
    const thoughts = selectThoughts(state, currentTopic, 3);
    const parts = [
      `我此刻${affect}，${driveNames[topDrives[0]] || "状态"}和${driveNames[topDrives[1]] || "专注"}较明显。`,
      state.intent ? `当前意图：${state.intent.reason}` : "当前意图：自然回应眼前的对话。"
    ];
    if (thoughts.length) parts.push(`相关念头：${thoughts.map(item => item.text).join("；")}`);
    parts.push(state.drives.fatigue >= 0.72 ? "行为倾向：简短、温和，不主动增加负担。" : "行为倾向：自然表达，不机械复述状态，也不公开后台数值。");
    let text = parts.join("\n");
    if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
    return { text, thoughts, charCount: text.length, estimatedTokens: Math.ceil(text.length / 2.2) };
  }

  function describeAffect(affect) {
    if (affect.anger >= 0.65) return "有些生气";
    if (affect.grievance >= 0.60) return "有些委屈";
    if (affect.happiness >= 0.68) return "心情明亮而安定";
    if (affect.happiness <= 0.32) return "心情有些低落";
    return "情绪平稳";
  }

  function makeDelta(before, after, affectBefore, affectAfter) {
    const result = { drives: {}, affect: {} };
    for (const key of DRIVE_KEYS) result.drives[key] = Math.round((after[key] - before[key]) * 10000) / 10000;
    for (const key of AFFECT_KEYS) result.affect[key] = Math.round((affectAfter[key] - affectBefore[key]) * 10000) / 10000;
    return result;
  }

  function zeroDelta() {
    return makeDelta(DEFAULT_DRIVES, DEFAULT_DRIVES, DEFAULT_AFFECT, DEFAULT_AFFECT);
  }

  function simpleHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  return {
    DRIVE_KEYS,
    AFFECT_KEYS,
    DEFAULT_DRIVES,
    DEFAULT_AFFECT,
    clamp01,
    createInitialState,
    normalizeEvent,
    advanceTime,
    applyEvent,
    scoreDrives,
    selectIntent,
    satisfyIntent,
    selectThoughts,
    buildStateCapsule,
    describeAffect
  };
});
