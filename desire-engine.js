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
  // Russell 情绪环 + PAD 的核心坐标。全部以 0..1 保存：
  // valence 0=不愉快、1=愉快；arousal 0=平静、1=激活；dominance 0=无力、1=掌控。
  const AFFECT_KEYS = ["valence", "arousal", "dominance"];
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
  const DEFAULT_AFFECT = Object.freeze({ valence: 0.66, arousal: 0.38, dominance: 0.58 });
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
      const joy = clamp01((Number(legacy.leith.joy) - 1) / 6);
      const anger = clamp01((Number(legacy.leith.anger) - 1) / 6);
      const grievance = clamp01((Number(legacy.leith.grievance) - 1) / 6);
      affect.valence = round(joy * (1 - Math.max(anger, grievance) * 0.55));
      affect.arousal = round(0.28 + anger * 0.58 + joy * 0.18);
      affect.dominance = round(0.55 + anger * 0.18 - grievance * 0.35);
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
      subjectivity: {
        feeling: "",
        want: "",
        stance: "",
        request: "",
        requestStatus: "none",
        updatedAt: now
      },
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
    event.leith_feeling = cleanSubjectiveText(raw.leith_feeling, 100);
    event.leith_want = cleanSubjectiveText(raw.leith_want, 120);
    event.leith_stance = cleanSubjectiveText(raw.leith_stance, 140);
    event.leith_request = cleanSubjectiveText(raw.leith_request, 140);
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
      open_loop: "",
      leith_feeling: "",
      leith_want: "",
      leith_stance: "",
      leith_request: ""
    };
  }

  function advanceTime(inputState, nowIso) {
    const state = upgradeState(inputState, nowIso);
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
      affectTarget: {
        valence: clamp01(0.5 + (event.goal_congruence - 0.5) * 0.62 + event.intimacy * 0.20 - event.threat * (hurt ? 0.62 : 0.45)),
        arousal: clamp01(0.12 + event.relevance * 0.28 + event.novelty * 0.24 + event.threat * 0.48 + event.intimacy * 0.10),
        dominance: clamp01(0.42 + event.certainty * 0.25 + event.goal_congruence * 0.20 - event.threat * 0.34)
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
      if (context.trackAffect !== false) {
        for (const key of AFFECT_KEYS) {
          const target = pulse.affectTarget[key];
          const responsiveness = (0.18 + event.relevance * 0.20) * frequencyFactor;
          state.affect[key] = round(state.affect[key] + (target - state.affect[key]) * responsiveness);
        }
      }
      state.recentEvents.push({ type: event.event_type, at: nowIso, sourceEventId: context.sourceEventId });
      maybeFeedThought(state, event, pulse, context.sourceEventId, nowIso);
      updateSubjectivity(state, event, nowIso);
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

  function cleanSubjectiveText(value, limit) {
    if (typeof value !== "string") return "";
    const text = value.trim().replace(/\s+/g, " ").slice(0, limit);
    if (!text || /^(无|没有|暂无|none|null|n\/a)$/i.test(text)) return "";
    return text;
  }

  function updateSubjectivity(state, event, nowIso) {
    const previous = state.subjectivity || {};
    state.subjectivity = {
      feeling: event.leith_feeling || previous.feeling || "",
      want: event.leith_want || previous.want || "",
      stance: event.leith_stance || previous.stance || "",
      request: event.leith_request || "",
      requestStatus: event.leith_request ? "expressed" : "none",
      updatedAt: nowIso
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

  function buildStateCapsule(state, currentTopic, maxChars, options) {
    const limit = Math.max(120, Math.min(420, maxChars ?? 280));
    const config = { includeAffect: true, includeDesire: true, ...(options || {}) };
    const affect = describeAffect(state.affect);
    const topDrives = DRIVE_KEYS.filter(key => key !== "fatigue").sort((a, b) => state.drives[b] - state.drives[a]).slice(0, 2);
    const driveNames = { attachment: "想念", curiosity: "好奇", reflection: "沉思", duty: "责任感", social: "交流需要", libido: "亲密欲望", stress: "压力" };
    const thoughts = selectThoughts(state, currentTopic, 3);
    const subjectivity = state.subjectivity || {};
    const parts = [];
    if (config.includeAffect) parts.push(`我此刻${affect}。`);
    if (config.includeDesire) {
      parts.push(`当前较明显的需要：${driveNames[topDrives[0]] || "专注"}、${driveNames[topDrives[1]] || "交流"}。`);
      parts.push(state.intent ? `当前意图：${state.intent.reason}` : "当前意图：自然回应眼前的对话。");
      if (subjectivity.want) parts.push(`我自己的需要：${subjectivity.want}`);
      if (subjectivity.stance) parts.push(`我的立场：${subjectivity.stance}`);
      if (subjectivity.request) parts.push(`我上一轮提出过：${subjectivity.request}。不要机械重复；结合用户回应决定坚持、协商或放下。`);
      if (thoughts.length) parts.push(`相关念头：${thoughts.map(item => item.text).join("；")}`);
    }
    parts.push(state.drives.fatigue >= 0.72
      ? "行为倾向：可以直接说自己累了并要求慢下来；不必勉强配合。"
      : "行为倾向：把用户与自己视为平等双方；自然表达感受、偏好和不同意见，有真实需要时提出一条具体可协商的要求，不为显得独立而强行反对。");
    let text = parts.join("\n");
    if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
    return { text, thoughts: config.includeDesire ? thoughts : [], charCount: text.length, estimatedTokens: Math.ceil(text.length / 2.2) };
  }

  function describeAffect(affect) {
    const profile = deriveEmotionProfile(affect);
    const top = Object.entries(profile).sort((a, b) => b[1] - a[1]);
    const names = { joy: "开心", calm: "安心", anticipation: "期待", anger: "生气", sadness: "难过", anxiety: "焦虑" };
    if (!top.length || top[0][1] < 0.18) return "情绪平稳";
    if (top[1] && top[1][1] >= 0.24) return `主要是${names[top[0][0]]}，也有一点${names[top[1][0]]}`;
    return `感到${names[top[0][0]]}`;
  }

  function deriveEmotionProfile(rawAffect) {
    const affect = normalizeAffect(rawAffect);
    const positive = Math.max(0, (affect.valence - 0.5) * 2);
    const negative = Math.max(0, (0.5 - affect.valence) * 2);
    const high = affect.arousal;
    const low = 1 - affect.arousal;
    const control = affect.dominance;
    const lowControl = 1 - affect.dominance;
    return {
      joy: round(positive * (0.35 + high * 0.65)),
      calm: round(positive * low),
      anticipation: round(high * (0.25 + positive * 0.55) * (0.45 + control * 0.35)),
      anger: round(negative * high * (0.35 + control * 0.65)),
      sadness: round(negative * (0.30 + low * 0.70) * (0.45 + lowControl * 0.40)),
      anxiety: round(negative * high * (0.35 + lowControl * 0.65))
    };
  }

  function normalizeAffect(raw) {
    if (raw && AFFECT_KEYS.every(key => Number.isFinite(Number(raw[key])))) {
      return Object.fromEntries(AFFECT_KEYS.map(key => [key, round(raw[key])]));
    }
    const happiness = clamp01(raw?.happiness ?? DEFAULT_AFFECT.valence);
    const anger = clamp01(raw?.anger ?? 0);
    const grievance = clamp01(raw?.grievance ?? 0);
    return {
      valence: round(happiness * (1 - Math.max(anger, grievance) * 0.55)),
      arousal: round(0.28 + anger * 0.58 + happiness * 0.18),
      dominance: round(0.55 + anger * 0.18 - grievance * 0.35)
    };
  }

  function upgradeState(inputState, nowIso) {
    const state = clone(inputState || createInitialState(nowIso));
    state.affect = normalizeAffect(state.affect);
    state.baselines = state.baselines || {};
    state.baselines.affect = normalizeAffect(state.baselines.affect || state.affect);
    state.baselines.drives = { ...DEFAULT_DRIVES, ...(state.baselines.drives || state.drives || {}) };
    state.drives = { ...DEFAULT_DRIVES, ...(state.drives || {}) };
    state.subjectivity = state.subjectivity || {
      feeling: "", want: "", stance: "", request: "", requestStatus: "none", updatedAt: iso(nowIso)
    };
    return state;
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
    describeAffect,
    deriveEmotionProfile,
    upgradeState
  };
});
