const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../desire-engine.js");

function createStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test("无云端时同一 message ID 也不会重复更新", async () => {
  global.localStorage = createStorage();
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  global.document = { visibilityState: "visible", addEventListener() {} };
  global.window = {
    LeithDesireEngine: Engine,
    addEventListener() {},
    dispatchEvent() {},
    setInterval() { return 1; },
    getSupabaseClient() { return null; }
  };
  delete require.cache[require.resolve("../desire-runtime.js")];
  require("../desire-runtime.js");
  const runtime = global.window.LeithDesireRuntime;
  await runtime.init();
  const rawReply = `我也想继续。<leith-event>{"event_type":"shared_project_progress","summary":"一起推进了项目。","relevance":0.9,"novelty":0.7,"goal_congruence":0.9,"intimacy":0.4,"threat":0,"certainty":0.95,"topics":["项目"]}</leith-event>`;
  const options = {
    sourceMessageId: "stable_message_id",
    assistantMessageId: "assistant_1",
    userText: "继续项目",
    rawReply,
    nowIso: "2026-08-04T10:00:00.000Z"
  };
  await runtime.completeTurn(options);
  const once = runtime.getSnapshot().state;
  await runtime.completeTurn(options);
  const twice = runtime.getSnapshot().state;
  assert.deepEqual(twice.drives, once.drives);
  assert.equal(twice.version, once.version);
  assert.equal(runtime.splitEventEnvelope(rawReply, "").visible, "我也想继续。");
});
