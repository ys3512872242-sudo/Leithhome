import { env, KokoroTTS, setVoiceData } from "./vendor/kokoro/kokoro.web.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.1-zh-ONNX";
const MODEL_VOICE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/voices`;
const ASSET_CACHE = "leith-kokoro-voice-assets-v1";
const CUSTOM_VOICE_ID = "zm_custom";
const EXPECTED_VOICE_LENGTH = 510 * 256;

env.allowLocalModels = false;
env.wasmPaths = new URL("./vendor/kokoro/", self.location.href).href;

let tts = null;
let modelPromise = null;
let activeRequestId = "";
let generationChain = Promise.resolve();

function post(type, detail = {}, transfer = []) {
  self.postMessage({ type, ...detail }, transfer);
}

function progressCallback(info) {
  if (!info) return;
  const file = String(info.file || "");
  const isModel = file.endsWith(".onnx");
  const progress = Number.isFinite(Number(info.progress)) ? Number(info.progress) : 0;
  if (info.status === "progress" && isModel) {
    post("progress", { phase: "download", progress: Math.max(0, Math.min(100, progress)), file });
    return;
  }
  if (info.status === "done" && isModel) {
    post("progress", { phase: "initialize", progress: 99, file });
    return;
  }
  if (info.status === "initiate") {
    post("progress", { phase: isModel ? "download_start" : "metadata", progress: 0, file });
    return;
  }
  if (info.status === "done") {
    post("progress", { phase: "metadata", progress: 0, file });
  }
}

async function canUseWebGPU() {
  try { return Boolean(await self.navigator?.gpu?.requestAdapter?.()); }
  catch (_) { return false; }
}

async function createModel(preferWebGPU) {
  const useWebGPU = preferWebGPU && await canUseWebGPU();
  if (useWebGPU) {
    try {
      const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "fp32",
        device: "webgpu",
        model_file_name: "model_q4f16",
        progress_callback: progressCallback
      });
      return { instance, device: "WebGPU" };
    } catch (error) {
      post("progress", { phase: "fallback", progress: 0, file: "正在切换兼容模式" });
    }
  }
  const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: "fp32",
    device: "wasm",
    model_file_name: "model_uint8",
    progress_callback: progressCallback
  });
  return { instance, device: "WASM" };
}

async function ensureModel(preferWebGPU = true) {
  if (tts) return tts;
  if (!modelPromise) {
    modelPromise = createModel(preferWebGPU)
      .then(({ instance, device }) => {
        tts = instance;
        post("ready", { device });
        return tts;
      })
      .catch((error) => {
        modelPromise = null;
        post("error", { error: error?.message || String(error) });
        throw error;
      });
  }
  return modelPromise;
}

async function fetchVoice(voice) {
  const url = `${MODEL_VOICE_URL}/${encodeURIComponent(voice)}.bin`;
  let cache = null;
  try {
    cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(url);
    if (cached) {
      const values = new Float32Array(await cached.arrayBuffer());
      if (values.length === EXPECTED_VOICE_LENGTH) return values;
      await cache.delete(url);
    }
  } catch (_) {}

  const response = await fetch(url);
  if (!response.ok) throw new Error(`男声 ${voice.replace("zm_", "")} 下载失败（${response.status}）。`);
  const buffer = await response.arrayBuffer();
  const values = new Float32Array(buffer);
  if (values.length !== EXPECTED_VOICE_LENGTH) throw new Error("下载到的声线文件不完整，请重新试听。");
  if (cache) {
    try {
      await cache.put(url, new Response(buffer.slice(0), {
        headers: { "Content-Type": "application/octet-stream" }
      }));
    } catch (_) {}
  }
  return values;
}

async function buildVoice(profile) {
  const parts = (profile?.blend || []).filter(item => Number(item.weight) > 0);
  const total = parts.reduce((sum, item) => sum + Number(item.weight), 0);
  if (!(total > 0)) throw new Error("请至少给一个男声保留一点比例。");
  const arrays = await Promise.all(parts.map(item => fetchVoice(item.voice)));
  for (const values of arrays) {
    if (values.length !== EXPECTED_VOICE_LENGTH) throw new Error("下载到的声线文件不完整，请重新试听。");
  }
  const mixed = new Float32Array(EXPECTED_VOICE_LENGTH);
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const factor = Number(parts[partIndex].weight) / total;
    const values = arrays[partIndex];
    for (let index = 0; index < mixed.length; index++) mixed[index] += values[index] * factor;
  }
  setVoiceData(CUSTOM_VOICE_ID, mixed);
}

async function generate(message) {
  const requestId = message.requestId;
  if (activeRequestId !== requestId) return;
  try {
    const model = await ensureModel(true);
    if (activeRequestId !== requestId) return;
    await buildVoice(message.profile);
    if (activeRequestId !== requestId) return;
    for await (const chunk of model.stream(message.text, {
      voice: CUSTOM_VOICE_ID,
      speed: message.profile?.speed || 0.94,
      maxChunkLength: 120
    })) {
      if (activeRequestId !== requestId) return;
      const samples = chunk.audio.audio.slice();
      post("chunk", { requestId, samples: samples.buffer, sampleRate: 24000 }, [samples.buffer]);
    }
    if (activeRequestId === requestId) {
      post("complete", { requestId });
      activeRequestId = "";
    }
  } catch (error) {
    if (activeRequestId === requestId) post("error", { requestId, error: error?.message || String(error) });
  }
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "prepare") {
    ensureModel(message.preferWebGPU !== false).catch(() => {});
    return;
  }
  if (message.type === "stop") {
    if (!message.requestId || message.requestId === activeRequestId) activeRequestId = "";
    return;
  }
  if (message.type === "generate") {
    activeRequestId = message.requestId;
    generationChain = generationChain.catch(() => {}).then(() => generate(message));
  }
});
