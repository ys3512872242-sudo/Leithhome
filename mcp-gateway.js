// Leith MCP Gateway V1 — browser-side permission gate and read-only test client.
(function (root) {
  "use strict";
  const SETTINGS_KEY = "leith_mcp_gateway_settings_v1";
  const FUNCTION_NAME = "leith-mcp-gateway-v1";
  const DEFAULTS = Object.freeze({ enabled: false, tools: { "system.status": { enabled: true, permission: "read" } } });

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    const tools = source.tools && typeof source.tools === "object" ? source.tools : {};
    return { enabled: source.enabled === true, tools: { "system.status": { enabled: tools["system.status"]?.enabled !== false, permission: "read" } } };
  }
  function getSettings() {
    try { return normalize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")); }
    catch (_) { return normalize(DEFAULTS); }
  }
  async function saveSettings(next) {
    const value = normalize(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    if (root.Memory?.isReady?.() && root.Memory?.saveAppState) await root.Memory.saveAppState(SETTINGS_KEY, value);
    root.dispatchEvent(new CustomEvent("leith:mcp-settings-changed", { detail: value }));
    return value;
  }
  async function restoreSettings() {
    if (!root.Memory?.isReady?.() || !root.Memory?.loadAppStateKey) return getSettings();
    const row = await root.Memory.loadAppStateKey(SETTINGS_KEY);
    if (row?.value) {
      const value = normalize(row.value);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      return value;
    }
    const local = getSettings();
    await root.Memory.saveAppState(SETTINGS_KEY, local);
    return local;
  }
  function assertAllowed(toolName) {
    const settings = getSettings();
    if (!settings.enabled) throw new Error("MCP 总开关尚未开启");
    const tool = settings.tools[toolName];
    if (!tool?.enabled) throw new Error("这个工具尚未开启");
    if (tool.permission !== "read") throw new Error("第一阶段只允许只读操作");
  }
  async function call(toolName, input = {}) {
    assertAllowed(toolName);
    if (!root.Memory?.isReady?.()) throw new Error("请先解锁并连接 Leith 云端记忆");
    const client = root.getSupabaseClient?.();
    const token = localStorage.getItem("leith_memory_session_v2") || "";
    if (!client || !token) throw new Error("当前设备没有有效的 Leith 会话");
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, {
      body: { tool: toolName, input, request_id: crypto.randomUUID() },
      headers: { "x-leith-token": token }
    });
    if (error) throw new Error(error.message || "MCP 网关调用失败");
    if (!data?.ok) throw new Error(data?.error || "MCP 工具没有返回结果");
    return data;
  }
  root.LeithMCP = { SETTINGS_KEY, getSettings, saveSettings, restoreSettings, call, test: () => call("system.status", {}) };
  root.addEventListener("leith:supabase-ready", event => {
    if (event.detail?.ok) restoreSettings().then(() => root.dispatchEvent(new CustomEvent("leith:mcp-settings-changed", { detail: getSettings() }))).catch(error => console.warn("MCP 设置同步失败:", error));
  });
})(typeof window !== "undefined" ? window : globalThis);
