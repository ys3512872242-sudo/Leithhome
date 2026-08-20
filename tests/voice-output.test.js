const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const Voice = require("../voice-output.js");
const voiceSource = fs.readFileSync(path.join(root, "voice-output.js"), "utf8");
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
  assert.doesNotMatch(voiceSource, /getUserMedia|SpeechRecognition|webkitSpeechRecognition/);
  assert.match(html, /只让 Leith 说话/);
  assert.match(html, /不读取麦克风，也没有语音输入/);
  assert.match(app, /maybeAutoSpeak/);
  assert.match(app, /createVoiceReplayButton/);
});

test("GPT-SoVITS 适配器使用官方本地 tts JSON 字段", () => {
  for (const field of ["text_lang", "ref_audio_path", "prompt_text", "prompt_lang", "streaming_mode", "media_type"]) {
    assert.match(voiceSource, new RegExp(field));
  }
  assert.match(html, /http:\/\/127\.0\.0\.1:9880\/tts/);
  assert.match(html, /GPT-SoVITS 本地克隆声音/);
});

test("隐藏事件提供准确台词，动作与场景叙述不会被当成对白朗读", () => {
  assert.match(runtime, /"speech":"all and only the exact Chinese words Leith says aloud/);
  assert.match(runtime, /speech is the authoritative voice-output channel/);
  assert.match(app, /assistantMsg\._speech = parsedDesireReply\.rawEvent\.spoken_text \|\| ""/);
});

test("语音模块在主应用之前加载", () => {
  assert.ok(html.indexOf('src="voice-output.js"') > 0);
  assert.ok(html.indexOf('src="voice-output.js"') < html.indexOf('src="app.js"'));
  assert.match(serviceWorker, /"\.\/voice-output\.js"/);
});
