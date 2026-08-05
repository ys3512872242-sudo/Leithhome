const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "desire-runtime.js"), "utf8");
const memory = fs.readFileSync(path.join(root, "memory.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/202608040001_desire_state_v1.sql"), "utf8");

test("同一 message ID 由数据库唯一约束和重复检查保护", () => {
  assert.match(migration, /source_event_id text not null unique/i);
  assert.match(migration, /where source_event_id = p_source_event_id/i);
  assert.match(runtime, /`chat:\$\{options\.sourceMessageId\}`/);
});

test("旧七分量表被复制留档而非删除", () => {
  assert.match(migration, /legacy_state_log/i);
  assert.match(migration, /companion_mood_state_v1/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.app_state/i);
  assert.doesNotMatch(migration, /drop\s+table\s+.*app_state/i);
});

test("聊天先保存可见回复，再尝试更新状态", () => {
  const saveIndex = app.indexOf("saveThreadMessages(threadId, freshMessages);", app.indexOf("async function sendChat"));
  const stateIndex = app.indexOf("LeithDesireRuntime?.completeTurn", app.indexOf("async function sendChat"));
  assert.ok(saveIndex >= 0 && stateIndex > saveIndex);
  assert.match(app.slice(stateIndex, stateIndex + 900), /聊天消息已经安全保存/);
});

test("页面多次初始化不会重复创建 heartbeat", () => {
  assert.match(runtime, /if \(heartbeatTimer\) return;/);
  assert.match(runtime, /document\.visibilityState !== "visible"/);
});

test("隐藏事件只由同一次主回复携带，不存在独立评价请求", () => {
  assert.match(app, /evaluatorInstruction/);
  assert.doesNotMatch(runtime, /fetch\s*\(/);
  assert.match(app, /splitEventEnvelope/);
  assert.match(runtime, /leith_feeling/);
  assert.match(runtime, /leith_request/);
  assert.match(app, /LEITH_AGENCY_RULES/);
});

test("删除必须读取返回行并拒绝假成功", () => {
  assert.match(memory, /\.delete\(\)[\s\S]*?\.select\('id'\)/);
  assert.match(memory, /data\.length !== 1/);
  assert.match(app, /没有删掉：请确认已解锁并连接云端/);
});
