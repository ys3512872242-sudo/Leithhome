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
const mcpRegistryMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608070002_mcp_manual_registry.sql"), "utf8");
const mcpControlsMigration = fs.readFileSync(path.join(root, "supabase/migrations/202608070003_mcp_server_controls.sql"), "utf8");
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
  const sendStart = app.indexOf("async function sendChat");
  const saveIndex = app.indexOf("await saveThreadMessagesDurable(threadId, freshMessages);", sendStart);
  const stateIndex = app.indexOf("queueInternalStateUpdate(() => window.LeithDesireRuntime?.completeTurn", sendStart);
  assert.ok(saveIndex >= 0 && stateIndex > saveIndex);
  assert.match(app.slice(saveIndex, stateIndex), /clearAssistantReplyRecovery/);
});

test("页面多次初始化不会重复创建 heartbeat", () => {
  assert.match(runtime, /if \(heartbeatTimer\) return;/);
  assert.match(runtime, /document\.visibilityState !== "visible"/);
});

test("隐藏事件只由同一次主回复携带，不存在独立评价请求", () => {
  assert.match(app, /evaluatorInstruction/);
  assert.doesNotMatch(runtime, /fetch\s*\(/);
  assert.match(app, /splitEventEnvelope/);
  assert.match(runtime, /"feeling":"Leith's felt experience/);
  assert.match(runtime, /"request":"one negotiable request/);
  assert.match(app, /LEITH_AGENCY_RULES/);
});

test("删除必须读取返回行并拒绝假成功", () => {
  assert.match(memory, /\.delete\(\)[\s\S]*?\.select\('id'\)/);
  assert.match(memory, /data\.length !== 1/);
  assert.match(app, /没有删掉：请确认已解锁并连接云端/);
});

test("照片发送前压缩，失败时恢复待发送照片，历史图片不重复上传", () => {
  assert.match(app, /prepareImageForChat/);
  assert.match(app, /maxSide = 1440/);
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

test("关系调谐独立于性欲状态，包含贴合情境的安抚策略", () => {
  assert.match(app, /id:"relational-attunement"/);
  assert.match(app, /Warm touch is not automatically sexual/);
  assert.match(app, /Small frustration gets light companionship/);
  assert.match(app, /therapy-speak/);
});

test("Skills 独立开关、按场景注入且有总字符预算", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /page-app-skills/);
  assert.match(html, /leithSkillList/);
  assert.match(app, /data-skill-toggle/);
  assert.match(app, /saveLeithSkillToggle/);
  assert.match(app, /skillMatchesText/);
  assert.match(app, /isTokenSaverEnabled\(\) \? 900 : 1800/);
});

test("省 token Skill 缩短历史而且不发起额外模型调用", () => {
  assert.match(app, /historyLimit = isTokenSaverEnabled\(\) \? 16 : HISTORY_SEND_LIMIT/);
  assert.match(app, /tokenSaving:true/);
  assert.doesNotMatch(app.slice(app.indexOf("function buildLeithSkillsPromptBlock"), app.indexOf("const DIRECT_ADDRESS_RULES")), /fetch\s*\(/);
});

test("亲密 Skills 区分反撩、主动张力和可逆升级", () => {
  assert.match(app, /id:"innuendo-catch"/);
  assert.match(app, /id:"tension-initiative"/);
  assert.match(app, /reversible intimacy ladder/);
  assert.match(app, /Never substitute forceful possession for sexual intelligence/);
});

test("MCP 网关默认关闭、只读并在前后端同时校验权限", () => {
  assert.match(mcpMigration, /"enabled":false/);
  assert.match(mcpMigration, /permission in \('read', 'write'\)/);
  assert.match(mcpClient, /MCP 总开关尚未开启/);
  assert.match(mcpClient, /tool\.enabled && tool\.permission === "read"/);
  assert.match(mcpFunction, /sessionValid\(token\)/);
  assert.match(mcpFunction, /settings\.enabled !== true/);
  assert.match(mcpFunction, /permission !== "read"/);
  assert.doesNotMatch(mcpFunction, /input\?\.url|fetch\(payload/);
});

test("手动 MCP 地址只保存在服务端，浏览器只缓存脱敏工具目录", () => {
  assert.match(mcpRegistryMigration, /mcp_servers_private/i);
  assert.match(mcpRegistryMigration, /enable row level security/i);
  assert.match(mcpRegistryMigration, /revoke all .* from anon, authenticated/i);
  assert.match(mcpClient, /Sanitized metadata only; never stores endpoint URLs/);
  assert.doesNotMatch(mcpClient, /localStorage\.setItem\([^\n]*endpoint/i);
  assert.match(mcpFunction, /function publicServer[\s\S]*?has_auth/);
  assert.doesNotMatch(mcpFunction, /publicServer[\s\S]{0,300}endpoint:/);
  assert.doesNotMatch(mcpFunction, /publicServer[\s\S]{0,300}auth_header_value:/);
});

test("聊天仅暴露已授权的只读 MCP 工具，写入工具默认禁用", () => {
  assert.match(mcpFunction, /permission: WRITE_WORDS\.test[\s\S]*?\? "write" : "read", enabled: false/);
  assert.match(mcpFunction, /!tool\.enabled \|\| tool\.permission !== "read"/);
  assert.match(mcpClient, /tool\.enabled && tool\.permission === "read"/);
  assert.match(app, /getAvailableChatTools\(provider\.apiStyle\)/);
  assert.match(app, /executeAvailableTool\(tc\)/);
});

test("MCP 支持总开关、单服务开关、单工具开关和不回显的可选密钥", () => {
  assert.match(mcpControlsMigration, /enabled boolean not null default false/i);
  assert.match(mcpControlsMigration, /auth_header_name text/i);
  assert.match(mcpControlsMigration, /auth_header_value text/i);
  assert.match(mcpControlsMigration, /revoke all .* from anon, authenticated/i);
  assert.match(mcpClient, /server\.enabled === true/);
  assert.match(mcpClient, /registry\.server_enabled/);
  assert.match(mcpFunction, /ALLOWED_AUTH_HEADERS/);
  assert.match(mcpFunction, /这个 MCP 的独立开关尚未开启/);
  assert.match(app, /data-mcp-server-toggle/);
});

test("爱爱记录只在用户高潮事后记录，并按回复消息去重", () => {
  assert.match(app, /Only after Susie has clearly reached orgasm/);
  assert.match(app, /One confirmed Susie orgasm equals one record/);
  assert.match(app, /for Leith's orgasm alone/);
  assert.match(app, /handleAIActions\(actions, \{ sourceMessageId: finalMsgId \}\)/);
  assert.match(memory, /item\.sourceMessageId/);
  assert.match(memory, /event: actor === 'leith' \? 'user_orgasm'/);
});
