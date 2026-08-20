const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const Kokoro = require("../kokoro-engine.js");
const Voice = require("../voice-output.js");
const voiceSource = fs.readFileSync(path.join(root, "voice-output.js"), "utf8");
const engineSource = fs.readFileSync(path.join(root, "kokoro-engine.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "kokoro-worker.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const runtime = fs.readFileSync(path.join(root, "desire-runtime.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "sw.js"), "utf8");

test("语音输出会剥离隐藏事件、链接和动作标记", () => {
  const text = Voice.cleanSpokenText("**你好** [链接](https://example.com) <leith-event>{\"x\":1}</leith-event>");
  assert.equal(text, "你好 链接");
  assert.equal(Voice.extractSpokenText("*从背后抱住她*“不和那个怪兽玩了。”"), "不和那个怪兽玩了。");
  assert.equal(Voice.extractSpokenText("（从背后抱住她）没有明确标出的台词"), "");
});

test("结构化台词字段即使为空也不会退回朗读整段动作", async () => {
  assert.equal(await Voice.speakMessage({ _id:"only-action", content:"（低头吻了吻她）", _speech:"" }), false);
});

test("项目只实现 Leith 的 TTS 输出，不请求麦克风或语音识别", () => {
  assert.doesNotMatch(`${voiceSource}\n${engineSource}\n${app}`, /getUserMedia|SpeechRecognition|webkitSpeechRecognition/);
  assert.match(html, /只朗读 Leith 真正说出口的台词，不读动作/);
  assert.match(html, /不读取麦克风，也没有语音输入/);
  assert.match(app, /maybeAutoSpeak/);
  assert.match(app, /createVoiceReplayButton/);
});

test("Kokoro 是唯一语音引擎，不保留系统朗读或旧克隆接口", () => {
  const production = `${voiceSource}\n${app}\n${html}`;
  assert.equal(Voice.DEFAULTS.engine, "kokoro");
  assert.doesNotMatch(production, /speechSynthesis|SpeechSynthesisUtterance|gpt-sovits|GPT-SoVITS|systemVoiceURI/);
  assert.match(html, /声音工坊/);
  assert.match(html, /Kokoro 本地声线/);
});

test("旧语音设置会迁移为 Kokoro 且只保留可用参数", () => {
  const originalStorage = global.localStorage;
  global.localStorage = {
    getItem: () => JSON.stringify({
      engine:"system",
      systemVoiceURI:"old-system-voice",
      endpoint:"http://127.0.0.1:9880/tts",
      rate:1.1,
      autoSpeak:true
    })
  };
  try {
    const settings = Voice.getSettings();
    assert.equal(settings.engine, "kokoro");
    assert.equal(settings.rate, 1.1);
    assert.equal(settings.autoSpeak, true);
    assert.equal(Object.hasOwn(settings, "systemVoiceURI"), false);
    assert.equal(Object.hasOwn(settings, "endpoint"), false);
  } finally {
    if (originalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalStorage;
  }
});

test("声线混合会限制三个男声且保证至少一个有效权重", () => {
  const normalized = Kokoro.normalizeBlend([
    { voice:"zm_010", weight:0 },
    { voice:"not-a-voice", weight:0 },
    { voice:"zm_080", weight:0 },
    { voice:"zm_100", weight:100 }
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].voice, "zm_010");
  assert.equal(normalized[1].voice, Kokoro.DEFAULT_PROFILE.blend[1].voice);
  assert.equal(normalized[0].weight, 100);
  assert.equal(normalized[1].weight, 0);
  assert.equal(normalized[2].weight, 0);
});

test("Kokoro 工作者使用真实中文模型、完整声线张量和内存自定义槽", () => {
  assert.match(workerSource, /onnx-community\/Kokoro-82M-v1\.1-zh-ONNX/);
  assert.match(workerSource, /510 \* 256/);
  assert.match(workerSource, /setVoiceData\(CUSTOM_VOICE_ID, mixed\)/);
  assert.match(workerSource, /parts\[partIndex\]\.weight\) \/ total/);
  assert.match(engineSource, /new root\.Worker/);
  assert.match(engineSource, /type: "module"/);
});

test("隐藏事件提供准确台词，动作与场景叙述不会被当成对白朗读", () => {
  assert.match(runtime, /"speech":"all and only the exact Chinese words Leith says aloud/);
  assert.match(runtime, /speech is the authoritative voice-output channel/);
  assert.match(app, /assistantMsg\._speech = parsedDesireReply\.rawEvent\.spoken_text \|\| ""/);
  assert.equal((app.match(/maybeAutoSpeak\?\.\(assistantMsg\)/g) || []).length, 3);
});

test("Kokoro 模块按正确顺序加载并由 Service Worker 管理小型入口", () => {
  const engineIndex = html.indexOf('src="kokoro-engine.js"');
  const voiceIndex = html.indexOf('src="voice-output.js"');
  const appIndex = html.indexOf('src="app.js"');
  assert.ok(engineIndex > 0 && engineIndex < voiceIndex && voiceIndex < appIndex);
  assert.match(serviceWorker, /"\.\/kokoro-engine\.js"/);
  assert.match(serviceWorker, /"\.\/kokoro-worker\.js"/);
  assert.match(serviceWorker, /isKokoroRuntime/);
  assert.doesNotMatch(serviceWorker.match(/const SHELL_FILES = \[[^;]+/s)?.[0] || "", /ort-wasm|kokoro\.web/);
  assert.match(serviceWorker, /key\.startsWith\("companion-shell-"\)/);
  assert.doesNotMatch(serviceWorker, /filter\(\(k\) => k !== CACHE_NAME\)/);
  assert.match(workerSource, /generationChain = generationChain\.catch/);
  assert.match(workerSource, /await cache\.delete\(url\)/);
});
