const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const runtime = fs.readFileSync(path.join(root, "desire-runtime.js"), "utf8");
const memory = fs.readFileSync(path.join(root, "memory.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/202608040001_desire_state_v1.sql"), "utf8");
const mcpMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608070001_mcp_gateway_v1.sql"), "utf8");
const mcpClient = fs.readFileSync(path.join(root, "mcp-gateway.js"), "utf8");
const mcpFunction = fs.readFileSync(path.join(root, "supabase/functions/leith-mcp-gateway-v1/index.ts"), "utf8");

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

test("照片发送前压缩，失败时恢复待发送照片，历史图片不重复上传", () => {
  assert.match(app, /prepareImageForChat/);
  assert.match(app, /maxSide = 1600/);
  assert.match(app, /pendingAttachments = attachments/);
  assert.match(app, /Image bytes omitted from repeated context/);
});

test("模块开关控制真实提示词注入而非只隐藏界面", () => {
  assert.match(app, /modules\.longTermMemory/);
  assert.match(app, /modules\.shopping/);
  assert.match(app, /modules\.healthContext/);
  assert.match(runtime, /modules\.emotionInfluence/);
  assert.match(runtime, /modules\.desireAgency/);
});

test("MCP 网关默认关闭、只读并在前后端同时校验权限", () => {
  assert.match(mcpMigration, /"enabled":false/);
  assert.match(mcpMigration, /permission in \('read', 'write'\)/);
  assert.match(mcpClient, /MCP 总开关尚未开启/);
  assert.match(mcpClient, /permission !== "read"/);
  assert.match(mcpFunction, /sessionValid\(token\)/);
  assert.match(mcpFunction, /settings\.enabled !== true/);
  assert.match(mcpFunction, /permission !== "read"/);
  assert.doesNotMatch(mcpFunction, /input\?\.url|fetch\(payload/);
});
