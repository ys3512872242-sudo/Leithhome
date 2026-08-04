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

