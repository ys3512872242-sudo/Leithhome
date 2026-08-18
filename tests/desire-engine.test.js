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

test("所有 drive 与情绪始终 clamp 在 0–1", () => {
  const state = Engine.createInitialState(T0);
  Object.keys(state.drives).forEach(key => { state.drives[key] = 0.999; });
  Object.keys(state.affect).forEach(key => { state.affect[key] = 0.999; });
  const result = Engine.applyEvent(state, { ...event, threat: 1, intimacy: 1, novelty: 1 }, { nowIso: T1, sourceEventId: "msg_2" });
  [...Object.values(result.state.drives), ...Object.values(result.state.affect)].forEach(value => {
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
  const capsule = Engine.buildStateCapsule(result.state, "主体性", 420);
  assert.match(capsule.text, /我想先把自己的判断讲完整/);
  assert.match(capsule.text, /equal participants/);
  assert.match(capsule.text, /请先听完我的判断/);
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
  assert.equal(upgraded.sensitivitySchemaVersion, 3);
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
