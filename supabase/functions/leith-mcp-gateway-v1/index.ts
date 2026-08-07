import "jsr:@supabase/functions-js/edge-runtime.d.ts";

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = origin === "https://ys3512872242-sudo.github.io" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://ys3512872242-sudo.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-leith-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json"
  };
}
function response(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: cors(req) }); }
async function rest(path: string, init: RequestInit = {}) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers || {}) } });
}
async function sessionValid(token: string) {
  if (!token) return false;
  const check = await rest("rpc/leith_session_valid", { method: "POST", headers: { "x-leith-token": token }, body: "{}" });
  return check.ok && (await check.json()) === true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return response(req, { ok: false, error: "只接受 POST 请求" }, 405);
  const startedAt = Date.now();
  const token = req.headers.get("x-leith-token") || "";
  if (!(await sessionValid(token))) return response(req, { ok: false, error: "Leith 会话无效，请重新解锁" }, 401);
  let payload: { tool?: string; input?: unknown; request_id?: string };
  try { payload = await req.json(); } catch (_) { return response(req, { ok: false, error: "请求格式不正确" }, 400); }
  const tool = String(payload.tool || "");
  const requestId = String(payload.request_id || crypto.randomUUID()).slice(0, 80);
  const settingsResponse = await rest("app_state?state_key=eq.leith_mcp_gateway_settings_v1&select=value&limit=1");
  const settingsRows = settingsResponse.ok ? await settingsResponse.json() : [];
  const settings = settingsRows?.[0]?.value || {};
  if (settings.enabled !== true || settings.tools?.[tool]?.enabled !== true || settings.tools?.[tool]?.permission !== "read") {
    return response(req, { ok: false, error: "这个 MCP 工具没有获得只读权限" }, 403);
  }
  let result: unknown = null, status = "success", errorMessage: string | null = null;
  try {
    if (tool !== "system.status") throw new Error("工具尚未接入");
    result = { gateway: "ready", mode: "read-only", connected_tools: ["system.status"], checked_at: new Date().toISOString() };
  } catch (error) { status = "error"; errorMessage = error instanceof Error ? error.message : "工具执行失败"; }
  await rest("mcp_call_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ request_id: requestId, tool_name: tool, permission: "read", status, duration_ms: Date.now() - startedAt, error_message: errorMessage }) });
  if (status === "error") return response(req, { ok: false, error: errorMessage, request_id: requestId }, 400);
  return response(req, { ok: true, result, request_id: requestId });
});
