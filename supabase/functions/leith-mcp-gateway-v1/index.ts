import "jsr:@supabase/functions-js/edge-runtime.d.ts";
function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = origin === "https://ys3512872242-sudo.github.io" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return { "Access-Control-Allow-Origin": allowed ? origin : "https://ys3512872242-sudo.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-leith-token", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json" };
}
function response(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: cors(req) }); }
async function rest(path: string, init: RequestInit = {}) {
  const url = Deno.env.get("SUPABASE_URL") || ""; const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers || {}) } });
}
async function sessionValid(token: string) { if (!token) return false; const check = await rest("rpc/leith_session_valid", { method: "POST", headers: { "x-leith-token": token }, body: "{}" }); return check.ok && (await check.json()) === true; }
function safeEndpoint(raw: string) {
  const url = new URL(raw); const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("只允许不含账号密码的 HTTPS 地址");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) throw new Error("不允许连接本机、内网或 IP 地址");
  if (raw.length > 1000) throw new Error("地址过长"); return { endpoint: url.toString(), host };
}
function parseRpc(text: string, contentType: string) {
  if (contentType.includes("text/event-stream")) {
    const values = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean);
    for (let i = values.length - 1; i >= 0; i--) { try { const value = JSON.parse(values[i]); if (value.result || value.error) return value; } catch (_) {} }
    throw new Error("MCP 没有返回可读取的结果");
  }
  return JSON.parse(text || "{}");
}
async function mcpPost(endpoint: string, message: unknown, sessionId = "") {
  const headers: Record<string,string> = { "content-type": "application/json", "accept": "application/json, text/event-stream", "origin": "https://ys3512872242-sudo.github.io" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const result = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message), redirect: "error" });
  const text = await result.text(); if (!result.ok) throw new Error(`MCP 连接失败（HTTP ${result.status}）`);
  return { rpc: text ? parseRpc(text, result.headers.get("content-type") || "") : {}, sessionId: result.headers.get("mcp-session-id") || sessionId };
}
async function connect(endpoint: string) {
  const initialized = await mcpPost(endpoint, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "leithhome", version: "1.0" } } });
  if (initialized.rpc.error) throw new Error(initialized.rpc.error.message || "MCP 初始化失败");
  await mcpPost(endpoint, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, initialized.sessionId);
  const listed = await mcpPost(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
  if (listed.rpc.error) throw new Error(listed.rpc.error.message || "无法读取 MCP 工具");
  return { tools: listed.rpc.result?.tools || [], sessionId: listed.sessionId };
}
const WRITE_WORDS = /(answer|comment|ask|edit|mark|withdraw|delete|publish|post|create|update|send|write|upload|remove)/i;
function sanitizeTools(tools: any[]) { return tools.slice(0, 80).map(tool => ({ name: String(tool.name || "").slice(0, 100), description: String(tool.description || "").slice(0, 500), inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }, permission: WRITE_WORDS.test(String(tool.name || "")) ? "write" : "read", enabled: false })); }
function publicServer(row: any) { return { id: row.id, name: row.name, host: row.host, tools: row.tools || [], created_at: row.created_at }; }
async function logCall(requestId: string, tool: string, status: string, startedAt: number, errorMessage: string | null = null) { await rest("mcp_call_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ request_id: requestId, tool_name: tool, permission: "read", status, duration_ms: Date.now() - startedAt, error_message: errorMessage }) }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return response(req, { ok: false, error: "只接受 POST 请求" }, 405);
  const token = req.headers.get("x-leith-token") || ""; if (!(await sessionValid(token))) return response(req, { ok: false, error: "Leith 会话无效，请重新解锁" }, 401);
  let payload: any; try { payload = await req.json(); } catch (_) { return response(req, { ok: false, error: "请求格式不正确" }, 400); }
  const action = String(payload.action || payload.tool || ""); const requestId = String(payload.request_id || crypto.randomUUID()).slice(0, 80); const startedAt = Date.now();
  try {
    if (action === "system.status") return response(req, { ok: true, result: { gateway: "ready", mode: "read-only", checked_at: new Date().toISOString() }, request_id: requestId });
    if (action === "registry.list") { const result = await rest("mcp_servers_private?select=id,name,host,tools,created_at&order=created_at.asc"); const rows = result.ok ? await result.json() : []; return response(req, { ok: true, result: { servers: rows.map(publicServer) }, request_id: requestId }); }
    if (action === "registry.add") {
      const name = String(payload.name || "").trim(); if (!/^[A-Za-z0-9_-]{2,40}$/.test(name)) throw new Error("名称只能用英文、数字、下划线或连字符");
      const target = safeEndpoint(String(payload.endpoint || "")); const discovered = await connect(target.endpoint); const tools = sanitizeTools(discovered.tools);
      const saved = await rest("mcp_servers_private?on_conflict=name", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ name, endpoint: target.endpoint, host: target.host, tools, updated_at: new Date().toISOString() }) });
      if (!saved.ok) throw new Error("MCP 已连通，但保存失败"); const row = (await saved.json())[0]; return response(req, { ok: true, result: publicServer(row), request_id: requestId });
    }
    if (action === "registry.remove") { const id = String(payload.server_id || ""); await rest(`mcp_servers_private?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }); return response(req, { ok: true, result: { removed: true }, request_id: requestId }); }
    if (action === "registry.permission") {
      const id = String(payload.server_id || ""), toolName = String(payload.tool_name || ""); const found = await rest(`mcp_servers_private?id=eq.${encodeURIComponent(id)}&select=tools&limit=1`); const row = (await found.json())[0];
      const tools = (row?.tools || []).map((tool: any) => tool.name === toolName && tool.permission === "read" ? { ...tool, enabled: payload.enabled === true } : tool);
      await rest(`mcp_servers_private?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ tools, updated_at: new Date().toISOString() }) }); return response(req, { ok: true, result: { saved: true }, request_id: requestId });
    }
    if (action === "tools.call") {
      const settingsResponse = await rest("app_state?state_key=eq.leith_mcp_gateway_settings_v1&select=value&limit=1"); const settings = (await settingsResponse.json())?.[0]?.value || {}; if (settings.enabled !== true) throw new Error("MCP 总开关尚未开启");
      const id = String(payload.server_id || ""), toolName = String(payload.tool_name || ""); const found = await rest(`mcp_servers_private?id=eq.${encodeURIComponent(id)}&select=endpoint,tools&limit=1`); const row = (await found.json())[0]; const tool = row?.tools?.find((item: any) => item.name === toolName);
      if (!row || !tool || !tool.enabled || tool.permission !== "read") throw new Error("这个工具没有获得只读权限");
      const connected = await connect(row.endpoint); const called = await mcpPost(row.endpoint, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: payload.arguments || {} } }, connected.sessionId);
      if (called.rpc.error) throw new Error(called.rpc.error.message || "MCP 工具执行失败"); await logCall(requestId, toolName, "success", startedAt); return response(req, { ok: true, result: called.rpc.result, request_id: requestId });
    }
    throw new Error("未知的 MCP 操作");
  } catch (error) { const message = error instanceof Error ? error.message : "MCP 操作失败"; if (action === "tools.call") await logCall(requestId, String(payload.tool_name || "unknown"), "error", startedAt, message); return response(req, { ok: false, error: message, request_id: requestId }, 400); }
});
