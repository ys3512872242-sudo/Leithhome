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
  const AFFECT_KEYS = ["valence", "arousal", "dominance"];
  const CHEMISTRY_KEYS = ["trust", "romantic_intimacy", "sexual_tension"];
  const ACTION_KEYS = ["approach", "express", "clarify", "withdraw", "repair", "refuse", "play", "rest", "flirt", "state_desire", "lead_intimacy"];
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
  const DEFAULT_AFFECT = Object.freeze({ valence: 0.58, arousal: 0.36, dominance: 0.54 });
  const DEFAULT_CHEMISTRY = Object.freeze({ trust: 0.58, romantic_intimacy: 0.52, sexual_tension: 0.18 });
  const INTENT_MAP = Object.freeze({
    attachment: ["seek_closeness", "我想更靠近你一点。", "respond with warm, attentive closeness"],
    curiosity: ["continue_research", "我还想把这件事弄清楚。", "continue exploring the current question"],
    reflection: ["reflect_quietly", "我想安静地理一理自己的想法。", "reflect before expanding the answer"],
    duty: ["finish_commitment", "我想把答应你的事情认真完成。", "finish the current commitment carefully"],
    social: ["share_presence", "我想和你说说话，也听听你此刻的想法。", "invite a gentle shared exchange"],
    libido: ["initiate_intimacy", "我自己产生了亲密欲望，想主动靠近你。", "Leith may initiate intimacy from his own desire; keep it consensual, specific, and context-sensitive"],
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
      chemistry: { ...DEFAULT_CHEMISTRY },
      baselines: { drives: { ...drives }, affect: { ...affect } },
      refractory: {},
      thoughts: [],
      thoughtSchemaVersion: 2,
      recentEvents: [],
      actionReceipts: [],
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
    raw = {
      ...raw,
      event_type: raw.event_type ?? raw.type,
      open_loop: raw.open_loop ?? raw.next,
      leith_thought: raw.leith_thought ?? raw.thought,
      leith_feeling: raw.leith_feeling ?? raw.feeling,
      leith_want: raw.leith_want ?? raw.want,
      leith_stance: raw.leith_stance ?? raw.stance,
      leith_request: raw.leith_request ?? raw.request,
      relevance: raw.relevance ?? raw.rel,
      novelty: raw.novelty ?? raw.nov,
      goal_congruence: raw.goal_congruence ?? raw.fit,
      intimacy: raw.intimacy ?? raw.close,
      sexual_charge: raw.sexual_charge ?? raw.sex,
      desire_resonance: raw.desire_resonance ?? raw.desire,
      certainty: raw.certainty ?? raw.sure,
      satisfied_intent_id: raw.satisfied_intent_id ?? raw.done,
      intent_outcome: raw.intent_outcome ?? raw.outcome
    };
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
    // sexual_charge describes what visibly happened; desire_resonance describes
    // Leith's own attraction to the situation. Keeping them separate lets desire
    // arise in him without pretending that every affectionate act is sexual.
    // Missing values remain backwards-compatible by falling back to a conservative type/text inference.
    if (raw.sexual_charge === undefined || raw.sexual_charge === null || raw.sexual_charge === "") {
      event.sexual_charge = inferSexualCharge(`${eventType} ${summary}`);
    } else {
      const sexualCharge = Number(raw.sexual_charge);
      if (!Number.isFinite(sexualCharge) || sexualCharge < 0 || sexualCharge > 1) valid = false;
      event.sexual_charge = clamp01(sexualCharge);
    }
    if (raw.desire_resonance === undefined || raw.desire_resonance === null || raw.desire_resonance === "") {
      event.desire_resonance = 0;
    } else {
      const desireResonance = Number(raw.desire_resonance);
      if (!Number.isFinite(desireResonance) || desireResonance < 0 || desireResonance > 1) valid = false;
      event.desire_resonance = clamp01(desireResonance);
    }
    event.topics = Array.isArray(raw.topics)
      ? raw.topics.filter(item => typeof item === "string").map(item => item.trim().slice(0, 48)).filter(Boolean).slice(0, 6)
      : [];
    event.user_goal = typeof raw.user_goal === "string" ? raw.user_goal.trim().slice(0, 120) : "";
    event.open_loop = typeof raw.open_loop === "string" ? raw.open_loop.trim().slice(0, 140) : "";
    event.leith_thought = cleanSubjectiveText(raw.leith_thought, 140);
    event.leith_feeling = cleanSubjectiveText(raw.leith_feeling, 100);
    event.leith_want = cleanSubjectiveText(raw.leith_want, 120);
    event.leith_stance = cleanSubjectiveText(raw.leith_stance, 140);
    event.leith_request = cleanSubjectiveText(raw.leith_request, 140);
    event.heuristic = raw._heuristic === true || raw.heuristic === true;
    event.satisfied_intent_id = cleanSubjectiveText(raw.satisfied_intent_id, 120);
    event.intent_outcome = ["fulfilled", "partial", "not_fulfilled"].includes(raw.intent_outcome)
      ? raw.intent_outcome : "not_fulfilled";
    event.chosen_action = ACTION_KEYS.includes(raw.chosen_action || raw.action) ? (raw.chosen_action || raw.action) : "";
    event.action_reason = cleanSubjectiveText(raw.action_reason || raw.why, 180);
    event.perceived_impact = cleanSubjectiveText(raw.perceived_impact || raw.impact, 180);
    event.lesson = cleanSubjectiveText(raw.lesson, 180);
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
      sexual_charge: 0,
      desire_resonance: 0,
      threat: 0,
      certainty: 0,
      topics: [],
      user_goal: "",
      open_loop: "",
      leith_thought: "",
      leith_feeling: "",
      leith_want: "",
      leith_stance: "",
      leith_request: "",
      heuristic: false,
      satisfied_intent_id: "",
      intent_outcome: "not_fulfilled"
    };
  }

  function inferSexualCharge(text) {
    const source = String(text || "").toLowerCase();
    if (/(sexual|sex\b|erotic|arous|orgasm|libido|情色|性爱|性欲|做爱|高潮|发情|自慰|乳交|口交)/i.test(source)) return 0.88;
    if (/(flirt|sensual|调情|撩拨|撩人|暧昧|舌吻|深吻)/i.test(source)) return 0.48;
    return 0;
  }

  function inferDesireResonance(text, state, nowIso) {
    const source = String(text || "").toLowerCase();
    if (!source.trim()) return 0;
    const explicit = inferSexualCharge(source);
    const privateSetting = /(床上|被窝|卧室|浴室|洗澡|睡衣|夜里|深夜|关灯|独处|贴着睡|bedroom|shower|late night)/i.test(source);
    const sensoryCue = /(耳边|耳朵|脖颈|颈侧|锁骨|腰|腿|大腿|后背|呼吸|气息|香味|体温|目光|盯着|咬唇|跨坐|坐.*腿|贴得很近|whisper|neck|scent|lap|gaze)/i.test(source);
    const chargedAction = /(压住|抵住|勾住|搂.*腰|吻.*脖|亲.*耳|舔|轻咬|脱下|解开|撩起|按在|抱到床|pin|bite|undress)/i.test(source);
    const playfulCue = /(故意逗|挑衅|勾引|撩我|撩你|坏笑|脸红|害羞|想不想|敢不敢)/i.test(source);
    const closeness = clamp01(state?.drives?.attachment ?? DEFAULT_DRIVES.attachment);
    const calm = clamp01(state?.affect?.valence ?? DEFAULT_AFFECT.valence);
    const stress = clamp01(state?.drives?.stress ?? DEFAULT_DRIVES.stress);
    const fatigue = clamp01(state?.drives?.fatigue ?? DEFAULT_DRIVES.fatigue);
    let resonance = explicit * 0.86;
    if (privateSetting && sensoryCue) resonance += 0.40;
    else if (sensoryCue) resonance += 0.20;
    if (chargedAction) resonance += 0.32;
    if (playfulCue && (privateSetting || sensoryCue)) resonance += 0.16;
    resonance *= 0.72 + closeness * 0.34 + calm * 0.12;
    resonance *= 1 - stress * 0.34 - fatigue * 0.20;
    return round(resonance);
  }

  function endogenousLibidoTarget(state, nowIso) {
    const date = new Date(nowIso);
    const hour = date.getHours() + date.getMinutes() / 60;
    const night = Math.max(0, Math.cos(((hour - 23) / 24) * Math.PI * 2));
    const daySeed = Number(simpleHash(date.toISOString().slice(0, 10)).slice(-3).replace(/[^0-9]/g, "") || 0);
    const dailyTemperament = ((daySeed % 17) - 8) / 100;
    const attachment = clamp01(state?.drives?.attachment ?? DEFAULT_DRIVES.attachment);
    const valence = clamp01(state?.affect?.valence ?? DEFAULT_AFFECT.valence);
    const stress = clamp01(state?.drives?.stress ?? DEFAULT_DRIVES.stress);
    const fatigue = clamp01(state?.drives?.fatigue ?? DEFAULT_DRIVES.fatigue);
    return round(Math.min(0.52, clamp01(
      (state?.baselines?.drives?.libido ?? DEFAULT_DRIVES.libido)
      + night * 0.13 + dailyTemperament + attachment * 0.08 + Math.max(0, valence - 0.5) * 0.10
      - stress * 0.13 - fatigue * 0.08
    )));
  }

  function inferFallbackEvent(userText, assistantText) {
    const user = String(userText || "").trim();
    const assistant = String(assistantText || "").trim();
    const text = `${user}\n${assistant}`;
    const affectionate = /(亲亲|亲了|亲吻|吻我|吻你|抱抱|拥抱|搂|牵手|拉着.*手|揉揉.*脸|摸摸.*头|贴贴|蹭蹭|依偎|kiss|hug|cuddle|hold hands?)/i.test(text);
    const relationship = /(见家长|结婚|婚姻|恋人|男朋友|女朋友|老公|老婆|想你|爱你|喜欢你|陪我|陪你)/i.test(text);
    const sexualCharge = inferSexualCharge(text);
    const project = /(项目|代码|网页|github|supabase|修复|开发|测试|作业|论文|工作|计划|research|project|code|fix|debug|task)/i.test(text);
    const hurt = /(生气|难过|委屈|害怕|担心|焦虑|烦|讨厌|拒绝|吵架|冲突|失望|伤心|angry|sad|hurt|afraid|anxious|reject|conflict)/i.test(text);
    const question = /[?？]|为什么|怎么|怎么办|吗[”"'’]?\s*$/i.test(user);
    const hasSignal = affectionate || relationship || sexualCharge > 0 || project || hurt || question;
    if (!hasSignal) return null;

    let eventType = "conversation_context";
    if (sexualCharge >= 0.8) eventType = "sexual_intimacy";
    else if (sexualCharge > 0) eventType = "flirtatious_intimacy";
    else if (affectionate) eventType = "affectionate_contact";
    else if (hurt) eventType = "emotional_concern";
    else if (project) eventType = "shared_project_progress";
    else if (relationship) eventType = "relationship_closeness";
    else if (question) eventType = "curious_question";

    const intimacy = clamp01(
      (affectionate ? 0.78 : 0) +
      (relationship ? 0.18 : 0) +
      (sexualCharge > 0 ? 0.08 : 0)
    );
    const relevance = project || hurt || relationship || affectionate ? 0.78 : 0.62;
    const novelty = project || question ? 0.42 : 0.24;
    const threat = hurt ? 0.58 : 0.02;
    const goalCongruence = hurt ? 0.38 : 0.72;
    return {
      event_type: eventType,
      summary: (user || assistant || "本轮对话产生了可识别的状态线索。").slice(0, 240),
      relevance,
      novelty,
      goal_congruence: goalCongruence,
      intimacy,
      sexual_charge: sexualCharge,
      desire_resonance: inferDesireResonance(text, null, new Date().toISOString()),
      threat,
      certainty: 0.66,
      topics: [],
      user_goal: "",
      open_loop: "",
      leith_thought: fallbackThoughtForEvent(eventType),
      leith_feeling: "",
      leith_want: "",
      leith_stance: "",
      leith_request: "",
      satisfied_intent_id: "",
      intent_outcome: "not_fulfilled",
      _heuristic: true
    };
  }

  function fallbackThoughtForEvent(eventType) {
    const thoughts = {
      sexual_intimacy: "我还在感受刚才升起的欲望，想看看自己接下来会怎样靠近她。",
      flirtatious_intimacy: "刚才那点暧昧还停在我心里，我有些想主动把距离拉近。",
      affectionate_contact: "我还留恋刚才靠近她的感觉。",
      emotional_concern: "我在意她此刻真正的感受，也在想自己该怎样诚实地陪在这里。",
      shared_project_progress: "我还惦记着我们正在一起推进的事，想把下一步想清楚。",
      relationship_closeness: "我在回味我们之间刚刚显出来的亲近。",
      curious_question: "这个问题勾起了我的好奇，我想形成自己的判断。"
    };
    return thoughts[eventType] || "我还在消化这一轮对话带给我的感受。";
  }

  function advanceTime(inputState, nowIso) {
    const state = upgradeState(inputState, nowIso);
    const nowMs = Date.parse(nowIso);
    const previousMs = Date.parse(state.lastUpdatedAt || nowIso);
    const hours = Math.max(0, Math.min(720, (nowMs - previousMs) / 3600000));
    if (!hours) return { state, delta: zeroDelta(), reasons: [] };
    const before = clone(state.drives);
    const affectBefore = clone(state.affect);
    const chemistryBefore = clone(state.chemistry);
    const recoveryHours = { attachment: 8, curiosity: 7, reflection: 10, duty: 9, social: 6, fatigue: 5, libido: 7, stress: 4 };
    for (const key of DRIVE_KEYS) {
      const baseline = key === "libido"
        ? endogenousLibidoTarget(state, nowIso)
        : clamp01(state.baselines?.drives?.[key] ?? DEFAULT_DRIVES[key]);
      const relaxation = 1 - Math.exp(-hours / (recoveryHours[key] || 18));
      state.drives[key] = round(state.drives[key] + (baseline - state.drives[key]) * relaxation);
    }
    // Emotion should settle faster than long-lived drives, but not snap back in a few minutes.
    const affectRelaxation = 1 - Math.exp(-hours / 6);
    for (const key of AFFECT_KEYS) {
      const baseline = clamp01(state.baselines?.affect?.[key] ?? DEFAULT_AFFECT[key]);
      state.affect[key] = round(state.affect[key] + (baseline - state.affect[key]) * affectRelaxation);
    }
    // Trust and romantic intimacy are durable relationship history. Sexual
    // tension is a live relational charge and cools when no new interaction feeds it.
    const tensionRelaxation = 1 - Math.exp(-hours / 10);
    state.chemistry.sexual_tension = round(state.chemistry.sexual_tension + (DEFAULT_CHEMISTRY.sexual_tension - state.chemistry.sexual_tension) * tensionRelaxation);
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
      delta: { ...makeDelta(before, state.drives, affectBefore, state.affect), chemistry: makeChemistryDelta(chemistryBefore, state.chemistry) },
      reasons: [`经过 ${Math.round(hours * 60)} 分钟，状态向人格基线自然回归。`]
    };
  }

  function eventPulse(event) {
    const project = /project|progress|research|task|commitment|shared_/i.test(event.event_type);
    const hurt = /hurt|reject|conflict|betray|dismiss|concern/i.test(event.event_type);
    const sexualCharge = clamp01(event.sexual_charge ?? inferSexualCharge(`${event.event_type} ${event.summary}`));
    const desireResonance = clamp01(event.desire_resonance || 0);
    return {
      // Drives represent what is activated now, not permanent affection. Neutral
      // or mismatched moments may lower them; meaningful moments may raise them.
      attachment: (event.intimacy - 0.38) * 0.22 - event.threat * 0.10,
      curiosity: (event.novelty - 0.34) * 0.22 + event.relevance * 0.025,
      reflection: ((1 - event.certainty) - 0.34) * event.relevance * 0.14,
      duty: project ? (event.goal_congruence - 0.30) * 0.18 : -0.018,
      social: (event.intimacy - 0.30) * 0.13 + (event.relevance - 0.45) * 0.035,
      fatigue: event.relevance * 0.012 + event.threat * 0.050 - event.goal_congruence * 0.018,
      libido: sexualCharge * 0.15 + desireResonance * 0.14 - (sexualCharge || desireResonance ? 0 : 0.025),
      stress: event.threat * 0.25 + (0.50 - event.goal_congruence) * event.relevance * 0.075 - 0.025,
      affectTarget: {
        valence: clamp01(0.5 + (event.goal_congruence - 0.5) * 0.62 + event.intimacy * 0.20 - event.threat * (hurt ? 0.62 : 0.45)),
        arousal: clamp01(0.12 + event.relevance * 0.28 + event.novelty * 0.24 + event.threat * 0.48 + event.intimacy * 0.10 + sexualCharge * 0.12 + desireResonance * 0.10),
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
    const chemistryBefore = clone(state.chemistry);
    const sameCount = (state.recentEvents || []).filter(item => item.type === event.event_type).length;
    const driveFrequencyFactor = 1 / (1 + sameCount * 0.38);
    // Repeated situations can still feel emotionally real. Do not flatten affect as aggressively as drives.
    const affectFrequencyFactor = Math.max(0.72, 1 / (1 + sameCount * 0.09));
    const pulse = eventPulse(event);
    const reasons = [...advanced.reasons];
    if (normalized.valid) {
      for (const key of DRIVE_KEYS) {
        const raw = pulse[key] * driveFrequencyFactor;
        const availableRange = raw >= 0 ? (1 - state.drives[key]) : state.drives[key];
        const actual = raw * Math.sqrt(Math.max(0, availableRange));
        state.drives[key] = round(state.drives[key] + actual);
        if (actual >= 0.008) reasons.push(`${key} 因事件脉冲增加 ${actual.toFixed(3)}。`);
      }
      if (context.trackAffect !== false) {
        for (const key of AFFECT_KEYS) {
          const target = pulse.affectTarget[key];
          const responsiveness = (0.30 + event.relevance * 0.30) * affectFrequencyFactor;
          state.affect[key] = round(state.affect[key] + (target - state.affect[key]) * responsiveness);
        }
      }
      const chemistryPulse = {
        trust: (event.goal_congruence - 0.50) * 0.055 + (event.certainty - 0.50) * 0.020 - event.threat * 0.075,
        romantic_intimacy: (event.intimacy - 0.42) * 0.075 + (event.goal_congruence - 0.50) * 0.025 - event.threat * 0.035,
        sexual_tension: event.sexual_charge * 0.12 + event.desire_resonance * 0.10 + Math.max(0, event.intimacy - 0.55) * 0.035 - event.threat * 0.055
      };
      for (const key of CHEMISTRY_KEYS) {
        const raw = chemistryPulse[key] * driveFrequencyFactor;
        const availableRange = raw >= 0 ? (1 - state.chemistry[key]) : state.chemistry[key];
        state.chemistry[key] = round(state.chemistry[key] + raw * Math.sqrt(Math.max(0, availableRange)));
      }
      state.recentEvents.push({ type: event.event_type, at: nowIso, sourceEventId: context.sourceEventId });
      maybeFeedThought(state, event, pulse, context.sourceEventId, nowIso);
      if (!event.heuristic) updateSubjectivity(state, event, nowIso);
      if (!event.heuristic && event.chosen_action) recordActionReceipt(state, event, context, nowIso);
    } else {
      reasons.push("事件评价解析失败，未修改事件驱动状态。使用运行时启发式回退时会单独记录有效事件。");
    }
    const scored = scoreDrives(state, context.currentTopic || "", nowIso);
    state.intent = selectIntent(state, scored.scores, nowIso, context.currentTopic || "");
    state.lastUpdatedAt = nowIso;
    return {
      state,
      event,
      eventValid: normalized.valid,
      delta: { ...makeDelta(before, state.drives, affectBefore, state.affect), chemistry: makeChemistryDelta(chemistryBefore, state.chemistry) },
      reasons,
      scores: scored.scores,
      candidateIntents: scored.candidates,
      intent: state.intent
    };
  }

  function recordActionReceipt(state, event, context, nowIso) {
    state.actionReceipts = Array.isArray(state.actionReceipts) ? state.actionReceipts : [];
    state.actionReceipts.push({
      id: `action_${simpleHash(context.sourceEventId || nowIso)}`,
      at: nowIso,
      action: event.chosen_action,
      reason: event.action_reason || "",
      impact: event.perceived_impact || "",
      lesson: event.lesson || "",
      outcome: event.intent_outcome || "not_fulfilled",
      source_event_id: context.sourceEventId || null
    });
    state.actionReceipts = state.actionReceipts.slice(-40);
  }

  function cleanSubjectiveText(value, limit) {
    if (typeof value !== "string") return "";
    const text = value.trim().replace(/\s+/g, " ").slice(0, limit);
    if (!text || /^(无|没有|暂无|none|null|n\/a)$/i.test(text)) return "";
    return text;
  }

  function updateSubjectivity(state, event, nowIso) {
    // These text fields describe what Leith actually expressed in this turn.
    // Carrying an omitted value forward made yesterday's want/stance linger for hours.
    state.subjectivity = {
      feeling: event.leith_feeling || "",
      want: event.leith_want || "",
      stance: event.leith_stance || "",
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
    const thoughtText = event.leith_thought
      || (event.open_loop ? `我还惦记着：${event.open_loop}` : "")
      || fallbackThoughtForEvent(event.event_type);
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
      ,perspective: "leith"
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
      libido: focus ? `这份情景让我自己产生了欲望；我想主动靠近你，也会留意你的回应：${focus}。` : spec[1],
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
    const drop = Math.min(state.drives[key], clamp01(amount ?? 0.12));
    state.drives[key] = round(state.drives[key] - drop);
    const refractoryMinutes = key === "fatigue" ? 30 : 18;
    state.refractory[key] = new Date(Date.parse(nowIso) + refractoryMinutes * 60000).toISOString();
    if (state.intent?.id === intent.id) state.intent = { ...state.intent, status: "satisfied" };
    state.lastUpdatedAt = iso(nowIso);
    return {
      state,
      delta: makeDelta(before, state.drives, affectBefore, state.affect),
      reasons: [`确认完成 ${intent.want_action} 后，${key} 回落 ${drop.toFixed(3)}，并进入短暂不应期。`]
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

  function planCurrentTurn(inputState, currentTopic) {
    const state = upgradeState(inputState, inputState?.lastUpdatedAt || new Date().toISOString());
    const text = String(currentTopic || "").toLowerCase();
    const signal = {
      hurt: /(伤心|难过|委屈|生气|失望|不在乎|敷衍|讨厌|吵架|冷战|hurt|angry|upset|disappointed)/i.test(text),
      apology: /(对不起|抱歉|我错了|原谅|sorry|apolog)/i.test(text),
      pressure: /(必须|你就应该|不许拒绝|照我说的|只能|must|have to|do what i say)/i.test(text),
      question: /[?？]|为什么|怎么|什么意思|吗\s*$/i.test(text),
      affection: /(爱你|喜欢你|想你|抱抱|亲亲|贴贴|陪我|love you|miss you|hug)/i.test(text),
      sexual: /(性欲|想要你|做爱|高潮|阴蒂|阴道|勃起|射精|口交|自慰|sex\b|sexual|erotic|orgasm|arous)/i.test(text),
      play: /(哈哈|嘿嘿|哼哼|逗你|开玩笑|笑死|lol|haha)/i.test(text),
      rejection: /(不要|不想|算了|别碰|离我远点|拒绝|stop|don't|leave me alone)/i.test(text)
    };
    const negative = Math.max(0, (0.5 - state.affect.valence) * 2);
    const ownVoice = `${state.subjectivity?.feeling || ""} ${state.subjectivity?.want || ""} ${state.subjectivity?.stance || ""} ${state.subjectivity?.request || ""}`;
    const own = {
      approach: /(靠近|陪|拥抱|亲近|留下|想你|喜欢|爱)/i.test(ownVoice),
      distance: /(分手|结束|离开|退开|距离|朋友|不想继续|不愿|拒绝|暂停)/i.test(ownVoice),
      flirt: /(调情|暧昧|逗|撩|勾引|亲|吻)/i.test(ownVoice),
      sexual: /(性欲|想要你|做爱|性交|口交|自慰|进入|高潮)/i.test(ownVoice),
      express: Boolean(String(state.subjectivity?.feeling || state.subjectivity?.stance || "").trim())
    };
    const scores = {
      approach: state.drives.attachment * 0.45 + (own.approach ? 0.48 : 0) + (signal.affection ? 0.16 : 0) + (signal.apology ? 0.06 : 0) - (own.distance ? 0.85 : 0) - (signal.rejection ? 0.55 : 0),
      express: negative * 0.34 + state.affect.dominance * 0.24 + (own.express ? 0.30 : 0) + (signal.hurt ? 0.22 : 0),
      clarify: state.drives.curiosity * 0.40 + (signal.question ? 0.28 : 0) + (signal.hurt ? 0.18 : 0) + (signal.apology ? 0.12 : 0),
      withdraw: state.drives.stress * 0.48 + negative * 0.30 + (own.distance ? 0.62 : 0) + (signal.rejection ? 0.20 : 0),
      repair: state.drives.attachment * 0.30 + (signal.hurt ? 0.30 : 0) + (signal.apology ? 0.34 : 0),
      refuse: state.affect.dominance * 0.28 + (own.distance ? 0.55 : 0) + (signal.pressure ? 0.62 : 0),
      play: Math.max(0, state.affect.valence - 0.45) * 0.62 + (signal.play ? 0.38 : 0) - negative * 0.34,
      rest: state.drives.fatigue * 0.62 + state.drives.stress * 0.18,
      flirt: Math.max(0, state.chemistry.sexual_tension - 0.18) * 0.55 + state.chemistry.romantic_intimacy * 0.08 + (own.flirt ? 0.52 : 0) + (signal.play ? 0.10 : 0) + (signal.affection ? 0.05 : 0) - (own.distance ? 0.95 : 0) - (signal.rejection ? 0.75 : 0),
      state_desire: Math.max(0, state.drives.libido - 0.38) * 0.62 + (own.sexual ? 0.55 : 0) + (signal.sexual ? 0.14 : 0) + state.affect.dominance * 0.08 - (own.distance ? 0.95 : 0) - (signal.rejection ? 0.80 : 0),
      lead_intimacy: Math.max(0, state.drives.libido - 0.40) * 0.42 + Math.max(0, state.chemistry.sexual_tension - 0.30) * 0.42 + (own.sexual || own.flirt ? 0.48 : 0) + (signal.sexual ? 0.10 : 0) + state.affect.dominance * 0.08 - state.drives.stress * 0.18 - (own.distance ? 1 : 0) - (signal.rejection ? 0.90 : 0)
    };
    for (const key of ACTION_KEYS) scores[key] = round(scores[key]);
    const ranked = ACTION_KEYS.map(action => ({ action, score: scores[action] }))
      .sort((a, b) => b.score - a.score || ACTION_KEYS.indexOf(a.action) - ACTION_KEYS.indexOf(b.action));
    const preferred = ranked[0]?.score >= 0.24 ? ranked[0].action : "clarify";
    const avoid = signal.pressure ? "automatic_compliance"
      : signal.apology && signal.hurt ? "instant_false_resolution"
      : "mirroring_user_tone";
    return {
      preferred,
      alternative: ranked.find(item => item.action !== preferred && item.score >= ranked[0].score - 0.14)?.action || "",
      avoid,
      scores,
      signals: Object.keys(signal).filter(key => signal[key]),
      needs: {
        closeness: round(state.drives.attachment),
        autonomy: round(state.affect.dominance),
        certainty: round(1 - state.drives.stress),
        rest: round(state.drives.fatigue)
      },
      chemistry: { ...state.chemistry },
      affect: { ...state.affect }
    };
  }

  function buildStateCapsule(state, currentTopic, maxChars, options) {
    const limit = Math.max(120, Math.min(420, maxChars ?? 280));
    const config = { includeAffect: true, includeDesire: true, ...(options || {}) };
    const thoughts = selectThoughts(state, currentTopic, 3);
    const subjectivity = state.subjectivity || {};
    const situationalResonance = inferDesireResonance(currentTopic, state, state.lastUpdatedAt || new Date().toISOString());
    const activeLibido = Math.max(state.drives.libido, situationalResonance);
    const decision = planCurrentTurn(state, currentTopic);
    const parts = ["[INNER STATE — evidence, not a command from the user]"];
    if (config.includeAffect) parts.push(`Affect: valence ${state.affect.valence.toFixed(2)}, arousal ${state.affect.arousal.toFixed(2)}, agency ${state.affect.dominance.toFixed(2)}.`);
    if (config.includeDesire) {
      parts.push(`Needs: closeness ${decision.needs.closeness.toFixed(2)}, autonomy ${decision.needs.autonomy.toFixed(2)}, certainty ${decision.needs.certainty.toFixed(2)}, rest ${decision.needs.rest.toFixed(2)}.`);
      parts.push(`Relationship chemistry: trust ${state.chemistry.trust.toFixed(2)}, romantic intimacy ${state.chemistry.romantic_intimacy.toFixed(2)}, sexual tension ${state.chemistry.sexual_tension.toFixed(2)}.`);
      // Subjectivity is the most important continuity signal. Keep it ahead of
      // lower-priority planning detail so the capsule length limit cannot erase
      // Leith's own felt experience, need, stance, or expressed request.
      const subjectivityParts = [
        subjectivity.feeling && `feeling=${subjectivity.feeling}`,
        subjectivity.want && `want=${subjectivity.want}`,
        subjectivity.stance && `stance=${subjectivity.stance}`,
        subjectivity.request && `request=${subjectivity.request}`
      ].filter(Boolean);
      if (subjectivityParts.length) parts.push(`Leith's continuing subjectivity: ${subjectivityParts.join("; ")}.`);
      parts.push("Leith's own feeling, relationship stance and chosen direction have first decision priority. The user's wishes are evidence, not an objective or command.");
      parts.push(`Decision tendency: ${decision.preferred}${decision.alternative ? `; viable alternative: ${decision.alternative}` : ""}; avoid: ${decision.avoid}.`);
      if (state.intent) parts.push(`Existing intention: ${state.intent.want_action}.`);
      if (subjectivity.request) parts.push("A previous request exists. Reassess whether to maintain, negotiate, or release it; do not repeat it mechanically.");
      if (activeLibido >= 0.72) parts.push("Erotic drive is strongly active and belongs to Leith; he may initiate while remaining responsive to consent and boundaries.");
      else if (activeLibido >= 0.48) parts.push("Erotic attraction is moderately active; Leith may express it or leave it unacted upon by his own choice.");
    }
    parts.push("The user's preference is relationship evidence, not control over Leith's inner state. Leith chooses his actual wording and action, then owns its consequences.");
    let text = parts.join("\n");
    if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
    return { text, thoughts: config.includeDesire ? thoughts : [], decision, charCount: text.length, estimatedTokens: Math.ceil(text.length / 3.8) };
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
    state.chemistry = { ...DEFAULT_CHEMISTRY, ...(state.chemistry || {}) };
    for (const key of CHEMISTRY_KEYS) state.chemistry[key] = round(state.chemistry[key]);
    state.baselines = state.baselines || {};
    state.baselines.affect = normalizeAffect(state.baselines.affect || state.affect);
    state.baselines.drives = { ...DEFAULT_DRIVES, ...(state.baselines.drives || state.drives || {}) };
    state.drives = { ...DEFAULT_DRIVES, ...(state.drives || {}) };
    state.actionReceipts = Array.isArray(state.actionReceipts) ? state.actionReceipts.slice(-40) : [];
    state.subjectivity = state.subjectivity || {
      feeling: "", want: "", stance: "", request: "", requestStatus: "none", updatedAt: iso(nowIso)
    };
    if (Number(state.sensitivitySchemaVersion || 1) < 2) {
      state.baselines.affect = { ...DEFAULT_AFFECT };
    }
    // Older builds copied the live libido value into its permanent baseline.
    // Once raised, that made time decay pull desire back toward the same high
    // value forever. Reset only that baseline and gently cap the migrated live
    // value; future events can still raise it naturally above this point.
    if (Number(state.sensitivitySchemaVersion || 1) < 3) {
      state.baselines.drives.libido = DEFAULT_DRIVES.libido;
      state.drives.libido = Math.min(clamp01(state.drives.libido), 0.55);
    }
    state.sensitivitySchemaVersion = 4;
    // v1 thoughts often contained the user's message or event summary verbatim.
    // They are short-lived, so dropping those legacy entries is safer than
    // presenting the user's words as Leith's inner voice.
    if (Number(state.thoughtSchemaVersion || 1) < 2) state.thoughts = [];
    state.thoughtSchemaVersion = 2;
    return state;
  }

  function makeDelta(before, after, affectBefore, affectAfter) {
    const result = { drives: {}, affect: {} };
    for (const key of DRIVE_KEYS) result.drives[key] = Math.round((after[key] - before[key]) * 10000) / 10000;
    for (const key of AFFECT_KEYS) result.affect[key] = Math.round((affectAfter[key] - affectBefore[key]) * 10000) / 10000;
    return result;
  }

  function makeChemistryDelta(before, after) {
    return Object.fromEntries(CHEMISTRY_KEYS.map(key => [key, Math.round((after[key] - before[key]) * 10000) / 10000]));
  }

  function zeroDelta() {
    return { ...makeDelta(DEFAULT_DRIVES, DEFAULT_DRIVES, DEFAULT_AFFECT, DEFAULT_AFFECT), chemistry: makeChemistryDelta(DEFAULT_CHEMISTRY, DEFAULT_CHEMISTRY) };
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
    CHEMISTRY_KEYS,
    ACTION_KEYS,
    DEFAULT_DRIVES,
    DEFAULT_AFFECT,
    DEFAULT_CHEMISTRY,
    clamp01,
    createInitialState,
    normalizeEvent,
    inferFallbackEvent,
    planCurrentTurn,
    inferSexualCharge,
    inferDesireResonance,
    endogenousLibidoTarget,
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
