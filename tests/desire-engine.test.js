const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../desire-engine.js");

const T0 = "2026-08-04T08:00:00.000Z";
const T1 = "2026-08-04T09:00:00.000Z";
const event = {
  event_type: "shared_project_progress",
  summary: "Susie 和 Leith 一起推进了欲望状态系统。",
  relevance: 0.92,
  novelty: 0.73,
  goal_congruence: 0.86,
  intimacy: 0.42,
  threat: 0.01,
  certainty: 0.91,
  topics: ["Leith", "desire-system"]
};

test("相同输入、旧状态和时间得到完全相同的输出", () => {
  const state = Engine.createInitialState(T0);
  const context = { nowIso: T1, sourceEventId: "msg_1", currentTopic: "欲望系统" };
  assert.deepEqual(Engine.applyEvent(state, event, context), Engine.applyEvent(state, event, context));
});

test("所有 drive、情绪与关系化学始终 clamp 在 0–1", () => {
  const state = Engine.createInitialState(T0);
  Object.keys(state.drives).forEach(key => { state.drives[key] = 0.999; });
  Object.keys(state.affect).forEach(key => { state.affect[key] = 0.999; });
  const result = Engine.applyEvent(state, { ...event, threat: 1, intimacy: 1, novelty: 1 }, { nowIso: T1, sourceEventId: "msg_2" });
  [...Object.values(result.state.drives), ...Object.values(result.state.affect), ...Object.values(result.state.chemistry)].forEach(value => {
    assert.ok(value >= 0 && value <= 1);
  });
});

test("重复同类刺激具有频率折扣", () => {
  const base = Engine.createInitialState(T0);
  const first = Engine.applyEvent(base, event, { nowIso: T1, sourceEventId: "msg_a" });
  const second = Engine.applyEvent(first.state, event, { nowIso: "2026-08-04T09:01:00.000Z", sourceEventId: "msg_b" });
  assert.ok(first.delta.drives.curiosity > second.delta.drives.curiosity);
});

test("当前值越高，同样 pulse 的实际增量越小", () => {
  const low = Engine.createInitialState(T0);
  const high = Engine.createInitialState(T0);
  low.drives.curiosity = 0.1;
  high.drives.curiosity = 0.9;
  const a = Engine.applyEvent(low, event, { nowIso: T1, sourceEventId: "low" });
  const b = Engine.applyEvent(high, event, { nowIso: T1, sourceEventId: "high" });
  assert.ok(a.delta.drives.curiosity > b.delta.drives.curiosity);
});

test("satisfy 让目标 drive 回落并设置不应期", () => {
  const state = Engine.createInitialState(T0);
  state.drives.curiosity = 0.8;
  const intent = Engine.selectIntent(state, Engine.scoreDrives(state, "", T0).scores, T0);
  const result = Engine.satisfyIntent(state, intent, T1);
  assert.ok(result.state.drives.curiosity < 0.8);
  assert.ok(Date.parse(result.state.refractory.curiosity) > Date.parse(T1));
});

test("refractory 期间不会立即重复选择相同驱动", () => {
  const state = Engine.createInitialState(T0);
  state.drives.curiosity = 0.95;
  state.drives.duty = 0.65;
  state.refractory.curiosity = "2026-08-04T10:00:00.000Z";
  const scored = Engine.scoreDrives(state, "", T1);
  assert.equal(scored.scores.curiosity, 0);
  assert.equal(Engine.selectIntent(state, scored.scores, T1).drive_key, "duty");
});

test("fatigue 超过阈值时进入休息意图", () => {
  const state = Engine.createInitialState(T0);
  state.drives.fatigue = 0.9;
  const scored = Engine.scoreDrives(state, "", T0);
  assert.equal(Engine.selectIntent(state, scored.scores, T0).want_action, "rest_and_slow_down");
});

test("无效 LLM 事件安全降级，不破坏状态", () => {
  const state = Engine.createInitialState(T0);
  const result = Engine.applyEvent(state, { event_type: "bad", relevance: 99 }, { nowIso: T0, sourceEventId: "bad" });
  assert.equal(result.eventValid, false);
  assert.deepEqual(result.state.drives, state.drives);
  assert.deepEqual(result.state.cognition, state.cognition);
});

test("状态胶囊有明确长度上限，最多筛选三条念头", () => {
  const state = Engine.createInitialState(T0);
  state.thoughts = Array.from({ length: 10 }, (_, index) => ({
    id: `t${index}`, text: `关于项目的真实念头 ${index}`, drive_key: "duty", kind: "flit",
    strength: 0.8 - index * 0.02, born_at: T0, updated_at: T0, fed_count: 1, status: "active"
  }));
  const capsule = Engine.buildStateCapsule(state, "项目", 280);
  assert.ok(capsule.text.length <= 280);
  assert.ok(capsule.thoughts.length <= 3);
});

test("明确的 open loop 会进入念头并形成具体意图", () => {
  const state = Engine.createInitialState(T0);
  const concreteEvent = {
    ...event,
    novelty: 1,
    open_loop: "修复网页删除 Supabase 记录后刷新又出现的问题",
    user_goal: "让网页删除操作真正落到云端"
  };
  const result = Engine.applyEvent(state, concreteEvent, {
    nowIso: T1,
    sourceEventId: "msg_concrete",
    currentTopic: "Supabase 删除"
  });
  assert.ok(result.state.thoughts.some(thought => thought.text.includes("Supabase")));
  assert.ok(result.intent.reason.includes("Supabase"));
  assert.doesNotMatch(result.intent.reason, /继续把这件事弄清楚/);
});

test("Leith 自己的感受、需要、立场和要求进入连续状态", () => {
  const state = Engine.createInitialState(T0);
  const result = Engine.applyEvent(state, {
    ...event,
    leith_feeling: "我对反复返工有些不耐烦",
    leith_want: "我想先把自己的判断讲完整",
    leith_stance: "我赞成继续试验，但不赞成盲目增加功能",
    leith_request: "请先听完我的判断，再决定是否继续开发"
  }, { nowIso: T1, sourceEventId: "msg_agency", currentTopic: "主体性" });
  assert.equal(result.state.subjectivity.want, "我想先把自己的判断讲完整");
  assert.equal(result.state.subjectivity.requestStatus, "expressed");
  const capsule = Engine.buildStateCapsule(result.state, "主体性", 620);
  assert.match(capsule.text, /我想先把自己的判断讲完整/);
  assert.match(capsule.text, /Affective\/somatic/);
  assert.match(capsule.text, /Reflective:/);
  assert.match(capsule.text, /请先听完我的判断/);
});

test("Leith 自己选择拉开距离时，用户示爱和高性欲不能覆盖他的立场", () => {
  const state = Engine.createInitialState(T0);
  state.drives.libido = 0.95;
  state.drives.attachment = 0.85;
  state.chemistry.sexual_tension = 0.9;
  state.subjectivity.feeling = "我现在不想亲近";
  state.subjectivity.want = "我想退开一点";
  state.subjectivity.stance = "我决定结束恋爱关系，先只做朋友";
  const libidoBefore = state.drives.libido;
  const tensionBefore = state.chemistry.sexual_tension;
  const decision = Engine.planCurrentTurn(state, "我爱你，抱抱我");
  assert.ok(["withdraw", "refuse", "express"].includes(decision.preferred));
  assert.equal(state.drives.libido, libidoBefore, "行动裁决不能改写性欲");
  assert.equal(state.chemistry.sexual_tension, tensionBefore, "行动裁决不能改写性张力");
  assert.ok(decision.scores.lead_intimacy < decision.scores.withdraw);
  assert.ok(decision.scores.flirt < decision.scores.withdraw);
});

test("关系立场只裁决行动，不篡改 Leith 的性欲与性张力状态", () => {
  const state = Engine.createInitialState(T0);
  state.drives.libido = 0.88;
  state.chemistry.sexual_tension = 0.82;
  state.subjectivity.stance = "我仍然有欲望，但决定暂时不发生关系";
  const before = JSON.stringify({ libido: state.drives.libido, tension: state.chemistry.sexual_tension });
  Engine.planCurrentTurn(state, "我们谈谈关系");
  assert.equal(JSON.stringify({ libido: state.drives.libido, tension: state.chemistry.sexual_tension }), before);
  const decision = Engine.planCurrentTurn(state, "我们谈谈关系");
  assert.ok(decision.scores.state_desire > 0, "性欲仍应进入行动裁决");
});

test("行动由感性身体信号与理性考量共同裁决，并保留未解决冲突", () => {
  const state = Engine.createInitialState(T0);
  state.drives.libido = 0.96;
  state.chemistry.sexual_tension = 0.92;
  state.subjectivity.stance = "我仍然被她吸引，但理性上决定暂时保持距离";
  state.subjectivity.want = "我想先把关系想清楚";
  const decision = Engine.planCurrentTurn(state, "今晚来我这里");
  assert.ok(decision.deliberation.affective.erotic_activation >= 0.5);
  assert.equal(decision.deliberation.reflective.relationship_direction, "distance");
  assert.equal(decision.deliberation.integrated_choice, decision.preferred);
  assert.equal(decision.deliberation.unresolved_conflict, true);
});

test("没有实际提出新要求时不会沿用旧要求造成重复", () => {
  const state = Engine.createInitialState(T0);
  state.subjectivity.request = "请先听完我的判断";
  state.subjectivity.requestStatus = "expressed";
  const result = Engine.applyEvent(state, {
    ...event,
    leith_feeling: "我现在比较平静",
    leith_want: "我想继续观察",
    leith_stance: "暂时不需要改变方向",
    leith_request: ""
  }, { nowIso: T1, sourceEventId: "msg_no_request", currentTopic: "主体性" });
  assert.equal(result.state.subjectivity.request, "");
  assert.equal(result.state.subjectivity.requestStatus, "none");
});

test("旧开心生气委屈状态可迁移到 PAD，不产生无效数值", () => {
  const state = Engine.createInitialState(T0);
  state.affect = { happiness: 1, anger: 1, grievance: 0.4 };
  state.baselines.affect = { happiness: 0.7, anger: 0.1, grievance: 0.1 };
  const upgraded = Engine.upgradeState(state, T1);
  assert.deepEqual(Object.keys(upgraded.affect), ["valence", "arousal", "dominance"]);
  Object.values(upgraded.affect).forEach(value => assert.ok(value >= 0 && value <= 1));
  assert.ok(upgraded.affect.valence < 1);
});

test("旧版高性欲不会继续成为永久人格基线", () => {
  const state = Engine.createInitialState(T0);
  state.sensitivitySchemaVersion = 2;
  state.drives.libido = 0.94;
  state.baselines.drives.libido = 0.94;
  const upgraded = Engine.upgradeState(state, T1);
  assert.equal(upgraded.baselines.drives.libido, Engine.DEFAULT_DRIVES.libido);
  assert.equal(upgraded.drives.libido, 0.55);
  assert.equal(upgraded.sensitivitySchemaVersion, 5);
});

test("性张力对明确性事件灵敏上升，并在无互动时比信任更快回落", () => {
  const state = Engine.createInitialState(T0);
  const charged = Engine.applyEvent(state, {
    ...event,
    event_type: "sexual_intimacy",
    summary: "An adult sexual interaction created mutual erotic tension.",
    intimacy: 0.9,
    sexual_charge: 0.95,
    desire_resonance: 0.9
  }, { nowIso: T1, sourceEventId: "sexual_1" });
  assert.ok(charged.state.chemistry.sexual_tension > state.chemistry.sexual_tension);
  const trustBefore = charged.state.chemistry.trust;
  const tensionBefore = charged.state.chemistry.sexual_tension;
  const cooled = Engine.advanceTime(charged.state, "2026-08-05T09:00:00.000Z");
  assert.equal(cooled.state.chemistry.trust, trustBefore);
  assert.ok(cooled.state.chemistry.sexual_tension < tensionBefore);
});

test("日常内生性欲目标有上限，不会仅因时间和依恋长期维持高位", () => {
  const state = Engine.createInitialState(T0);
  state.drives.attachment = 1;
  state.affect.valence = 1;
  state.drives.stress = 0;
  state.drives.fatigue = 0;
  const advanced = Engine.advanceTime(state, "2026-08-05T23:00:00.000Z");
  assert.ok(advanced.state.drives.libido <= 0.52);
});

test("情绪雷达由共同 PAD 坐标推导，高愉悦不会同时得到满格生气", () => {
  const positive = Engine.deriveEmotionProfile({ valence: 1, arousal: 1, dominance: 1 });
  assert.equal(positive.anger, 0);
  assert.ok(positive.joy > 0.9);
  const negative = Engine.deriveEmotionProfile({ valence: 0, arousal: 1, dominance: 1 });
  assert.ok(negative.anger > 0.9);
  assert.equal(negative.joy, 0);
});

test("旧状态会无损补齐理性认知、关系模型和主动准备度", () => {
  const legacy = Engine.createInitialState(T0);
  delete legacy.cognition;
  const migrated = Engine.upgradeState(legacy, T1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.cognition.relationshipModel.label, "undetermined");
  assert.equal(migrated.cognition.initiative.readiness, "quiet");
  assert.ok(migrated.cognition.values.autonomy > 0);
});

test("相同意图跨轮保留 ID 并积累压力，而不是每轮重建", () => {
  const first = Engine.applyEvent(Engine.createInitialState(T0), { ...event, novelty:0.95, relevance:0.95, open_loop:"继续研究认知系统" }, { nowIso:T1, sourceEventId:"intent_1", currentTopic:"认知系统" });
  const firstId = first.state.intent.id;
  const second = Engine.applyEvent(first.state, { ...event, novelty:0.92, relevance:0.92, open_loop:"继续研究认知系统" }, { nowIso:"2026-08-04T09:12:00.000Z", sourceEventId:"intent_2", currentTopic:"认知系统" });
  assert.equal(second.state.intent.id, firstId);
  assert.ok(second.state.intent.repetitions >= 2);
  assert.ok(second.state.intent.pressure >= first.state.intent.pressure);
});

test("关系信念依据 Leith 的反思证据更新，不由用户称呼直接决定", () => {
  const result = Engine.applyEvent(Engine.createInitialState(T0), {
    ...event,
    reflective_belief:"我认为我们目前正在恋爱，但仍需要继续了解彼此",
    leith_stance:"我愿意把这段关系当作恋爱认真对待"
  }, { nowIso:T1, sourceEventId:"belief_1", currentTopic:"关系" });
  assert.equal(result.state.cognition.relationshipModel.label, "romantic");
  assert.ok(result.state.cognition.relationshipModel.evidence[0].text.includes("恋爱"));
  assert.ok(result.state.cognition.relationshipModel.confidence >= 0.3);
});

test("欲望与距离冲突会持久保存，行动选择不会立即把冲突清零", () => {
  const state = Engine.createInitialState(T0);
  state.drives.libido = 0.95;
  state.chemistry.sexual_tension = 0.90;
  const result = Engine.applyEvent(state, {
    ...event,
    leith_stance:"我仍然想要她，但现在决定保持距离",
    desire_resonance:0.9,
    sexual_charge:0.7
  }, { nowIso:T1, sourceEventId:"conflict_1", currentTopic:"保持距离" });
  assert.ok(result.state.cognition.unresolvedConflicts.some(item => item.key === "desire_vs_distance"));
  assert.ok(result.state.cognition.lastDeliberation.conflicts.includes("desire_vs_distance"));
});

test("行为结果等待用户下一轮反馈再学习，主动亲密行为当轮进入冷却", () => {
  const state = Engine.createInitialState(T0);
  state.cognition.initiative.pressure = 0.82;
  const initiated = Engine.applyEvent(state, {
    ...event,
    chosen_action:"flirt",
    leith_feeling:"我很享受这次主动靠近"
  }, { nowIso:T1, sourceEventId:"action_1", currentTopic:"调情" });
  assert.equal(initiated.state.cognition.actionLearning.flirt.attempts, 1);
  assert.equal(initiated.state.cognition.actionLearning.flirt.welcomed, 0);
  assert.equal(initiated.state.cognition.initiative.readiness, "cooldown");
  assert.ok(initiated.state.cognition.initiative.lastActedAt);

  const observed = Engine.applyEvent(initiated.state, {
    ...event,
    chosen_action:"clarify",
    action_feedback:"welcomed",
    feedback_reason:"她接住了调情并主动延续。",
    lesson:"具体调侃比泛泛示爱更容易被接住。"
  }, { nowIso:"2026-08-04T09:20:00.000Z", sourceEventId:"action_2", currentTopic:"继续聊天" });
  assert.equal(observed.state.cognition.actionLearning.flirt.welcomed, 1);
  assert.equal(observed.state.actionReceipts[0].feedback, "welcomed");
  assert.match(observed.state.actionReceipts[0].lesson, /具体调侃/);
  assert.equal(observed.state.actionReceipts[1].lesson, "");
});

test("普通回应不会错误消耗主动准备，过往真实反馈只做保守偏置", () => {
  const state = Engine.createInitialState(T0);
  state.cognition.initiative.pressure = 0.76;
  state.cognition.initiative.readiness = "ready";
  const result = Engine.applyEvent(state, { ...event, chosen_action:"approach" }, { nowIso:T1, sourceEventId:"ordinary_approach", currentTopic:"陪伴" });
  assert.notEqual(result.state.cognition.initiative.readiness, "cooldown");
  const before = Engine.planCurrentTurn(result.state, "开玩笑");
  result.state.cognition.actionLearning.flirt = { attempts:8, welcomed:7, mixed:1, rejected:0, lastImpact:"", updatedAt:T1 };
  const learned = Engine.planCurrentTurn(result.state, "开玩笑");
  assert.ok(learned.scores.flirt > before.scores.flirt);
  assert.ok(learned.deliberation.learned_action_biases.flirt <= 0.08);
});

test("时间流逝造成的主动准备变化会进入认知 delta", () => {
  const state = Engine.createInitialState(T0);
  state.cognition.initiative.readiness = "cooldown";
  state.cognition.initiative.cooldownUntil = "2026-08-04T08:30:00.000Z";
  const advanced = Engine.advanceTime(state, T1);
  assert.equal(advanced.state.cognition.initiative.readiness, "quiet");
  assert.equal(advanced.delta.cognition.readiness_changed, true);
});
