(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LeithKokoro = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (root) {
  "use strict";

  const MODEL_CACHE_FLAG = "leith_kokoro_model_ready_v1";
  const VOICE_IDS = Object.freeze([
    "zm_009", "zm_010", "zm_011", "zm_012", "zm_013", "zm_014", "zm_015", "zm_016",
    "zm_020", "zm_025", "zm_029", "zm_030", "zm_031", "zm_033", "zm_034", "zm_035",
    "zm_037", "zm_041", "zm_045", "zm_050", "zm_052", "zm_053", "zm_054", "zm_055",
    "zm_056", "zm_057", "zm_058", "zm_061", "zm_062", "zm_063", "zm_064", "zm_065",
    "zm_066", "zm_068", "zm_069", "zm_080", "zm_081", "zm_082", "zm_089", "zm_091",
    "zm_095", "zm_096", "zm_097", "zm_098", "zm_100"
  ]);
  const VOICE_SET = new Set(VOICE_IDS);
  const DEFAULT_PROFILE = Object.freeze({
    name: "Leith",
    blend: Object.freeze([
      Object.freeze({ voice: "zm_009", weight: 100 }),
      Object.freeze({ voice: "zm_033", weight: 0 }),
      Object.freeze({ voice: "zm_080", weight: 0 })
    ]),
    speed: 0.94,
    volume: 1
  });

  let worker = null;
  let workerReady = false;
  let preparePromise = null;
  let prepareResolve = null;
  let prepareReject = null;
  let prepareWatchdog = null;
  let audioContext = null;
  let gainNode = null;
  let audioPrimed = false;
  let activeSource = null;
  let audioQueue = [];
  let activeRequest = null;
  let requestSequence = 0;
  let synthesisGeneration = 0;
  let stateListener = null;
  let runtimeState = {
    status: safeStorageGet(MODEL_CACHE_FLAG) === "1" ? "cached" : "idle",
    progress: 0,
    device: "",
    phase: "",
    error: ""
  };

  function safeStorageGet(key) {
    try { return root.localStorage?.getItem(key) || ""; } catch (_) { return ""; }
  }

  function safeStorageSet(key, value) {
    try { root.localStorage?.setItem(key, value); } catch (_) {}
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeBlend(value) {
    const source = Array.isArray(value) ? value.slice(0, 3) : [];
    const slots = DEFAULT_PROFILE.blend.map((fallback, index) => {
      const item = source[index] || {};
      return {
        voice: VOICE_SET.has(item.voice) ? item.voice : fallback.voice,
        weight: clamp(item.weight, 0, 100, fallback.weight)
      };
    });
    const total = slots.reduce((sum, item) => sum + item.weight, 0);
    if (!(total > 0)) {
      slots[0].weight = 100;
      slots[1].weight = 0;
      slots[2].weight = 0;
    }
    return slots;
  }

  function normalizeProfile(value) {
    const input = value && typeof value === "object" ? value : {};
    return {
      name: String(input.name || DEFAULT_PROFILE.name).trim().slice(0, 30) || DEFAULT_PROFILE.name,
      blend: normalizeBlend(input.blend),
      speed: clamp(input.speed, 0.7, 1.25, DEFAULT_PROFILE.speed),
      volume: clamp(input.volume, 0, 1, DEFAULT_PROFILE.volume)
    };
  }

  function updateState(next) {
    runtimeState = { ...runtimeState, ...(next || {}) };
    if (typeof stateListener === "function") stateListener({ ...runtimeState });
  }

  function getState() {
    return { ...runtimeState };
  }

  function setStateListener(listener) {
    stateListener = typeof listener === "function" ? listener : null;
    if (stateListener) stateListener(getState());
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof root.Worker !== "function") throw new Error("当前浏览器不能运行 Kokoro 本地声音模型。");
    const workerUrl = new URL("kokoro-worker.js", root.document?.baseURI || root.location?.href || "");
    worker = new root.Worker(workerUrl, { type: "module", name: "leith-kokoro" });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Kokoro 声音模型启动失败。");
      workerReady = false;
      clearPrepareWatchdog();
      updateState({ status: "error", error: error.message });
      failPrepare(error);
      failActive(error);
      try { worker?.terminate?.(); } catch (_) {}
      worker = null;
    });
    return worker;
  }

  function clearPrepareWatchdog() {
    if (prepareWatchdog) root.clearTimeout(prepareWatchdog);
    prepareWatchdog = null;
  }

  function armPrepareWatchdog() {
    clearPrepareWatchdog();
    prepareWatchdog = root.setTimeout(() => {
      const error = new Error("声音模型长时间没有收到下载进展，请检查网络后点“重新下载”。");
      workerReady = false;
      try { worker?.terminate?.(); } catch (_) {}
      worker = null;
      updateState({ status: "error", phase: "", error: error.message });
      failPrepare(error);
    }, 120000);
  }

  function failPrepare(error) {
    clearPrepareWatchdog();
    if (prepareReject) prepareReject(error);
    preparePromise = null;
    prepareResolve = null;
    prepareReject = null;
  }

  function resolvePrepare() {
    clearPrepareWatchdog();
    if (prepareResolve) prepareResolve(getState());
    preparePromise = null;
    prepareResolve = null;
    prepareReject = null;
  }

  function makeAbortError() {
    try { return new root.DOMException("已停止", "AbortError"); }
    catch (_) { const error = new Error("已停止"); error.name = "AbortError"; return error; }
  }

  async function requestPersistentStorage() {
    try { return await root.navigator?.storage?.persist?.(); }
    catch (_) { return false; }
  }

  function prepare(options) {
    if (workerReady) return Promise.resolve(getState());
    if (preparePromise) return preparePromise;
    updateState({ status: "loading", progress: 0, phase: "starting", error: "" });
    preparePromise = new Promise((resolve, reject) => {
      prepareResolve = resolve;
      prepareReject = reject;
    });
    try {
      ensureWorker().postMessage({ type: "prepare", preferWebGPU: options?.preferWebGPU !== false });
      armPrepareWatchdog();
      requestPersistentStorage();
    } catch (error) {
      updateState({ status: "error", error: error.message || "Kokoro 启动失败。" });
      failPrepare(error);
    }
    return preparePromise;
  }

  async function unlockAudio() {
    const AudioContextClass = root.AudioContext || root.webkitAudioContext;
    if (!AudioContextClass) throw new Error("当前浏览器不能播放 Kokoro 生成的声音。");
    if (!audioContext || audioContext.state === "closed") {
      try { audioContext = new AudioContextClass({ sampleRate: 24000 }); }
      catch (_) { audioContext = new AudioContextClass(); }
      gainNode = audioContext.createGain();
      gainNode.connect(audioContext.destination);
      audioPrimed = false;
    }
    if (audioContext.state !== "running") {
      try { await audioContext.resume(); }
      catch (_) { throw new Error("声音还没有被手机允许播放，请先点一次声音工坊里的试听按钮。"); }
    }
    if (audioContext.state !== "running") {
      throw new Error("声音还没有被手机允许播放，请先点一次声音工坊里的试听按钮。");
    }
    if (!audioPrimed) {
      const silent = audioContext.createBuffer(1, 1, audioContext.sampleRate || 24000);
      const source = audioContext.createBufferSource();
      source.buffer = silent;
      source.connect(gainNode);
      source.onended = () => { try { source.disconnect(); } catch (_) {} };
      source.start();
      audioPrimed = true;
    }
    return true;
  }

  function clearPlayback() {
    if (activeSource) {
      try { activeSource.onended = null; activeSource.stop(); } catch (_) {}
      try { activeSource.disconnect(); } catch (_) {}
    }
    activeSource = null;
    audioQueue = [];
  }

  function finishActive() {
    if (!activeRequest || !activeRequest.workerComplete || activeSource || audioQueue.length) return;
    const done = activeRequest;
    activeRequest = null;
    done.resolve(true);
  }

  function failActive(error) {
    if (!activeRequest) return;
    const failed = activeRequest;
    activeRequest = null;
    clearPlayback();
    failed.reject(error);
  }

  function playNextChunk() {
    if (!activeRequest || activeSource || !audioQueue.length || !audioContext || !gainNode) {
      finishActive();
      return;
    }
    const chunk = audioQueue.shift();
    const buffer = audioContext.createBuffer(1, chunk.samples.length, chunk.sampleRate || 24000);
    buffer.copyToChannel(chunk.samples, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);
    activeSource = source;
    source.onended = () => {
      try { source.disconnect(); } catch (_) {}
      if (activeSource === source) activeSource = null;
      playNextChunk();
    };
    source.start();
  }

  function handleWorkerMessage(event) {
    const message = event.data || {};
    if (message.type === "progress") {
      armPrepareWatchdog();
      updateState({ status: "loading", progress: clamp(message.progress, 0, 100, 0), phase: message.phase || "starting", error: "" });
      return;
    }
    if (message.type === "ready") {
      workerReady = true;
      safeStorageSet(MODEL_CACHE_FLAG, "1");
      updateState({ status: "ready", progress: 100, phase: "ready", device: message.device || "", error: "" });
      resolvePrepare();
      return;
    }
    if (message.type === "chunk") {
      if (!activeRequest || message.requestId !== activeRequest.id) return;
      audioQueue.push({ samples: new Float32Array(message.samples), sampleRate: message.sampleRate || 24000 });
      activeRequest.onPlaying?.();
      playNextChunk();
      return;
    }
    if (message.type === "complete") {
      if (!activeRequest || message.requestId !== activeRequest.id) return;
      activeRequest.workerComplete = true;
      finishActive();
      return;
    }
    if (message.type === "error") {
      clearPrepareWatchdog();
      const error = new Error(message.error || "Kokoro 生成声音失败。");
      updateState({ status: workerReady ? "ready" : "error", error: error.message });
      if (!workerReady) failPrepare(error);
      if (activeRequest && (!message.requestId || message.requestId === activeRequest.id)) failActive(error);
    }
  }

  function stop() {
    synthesisGeneration += 1;
    const request = activeRequest;
    if (request && worker) worker.postMessage({ type: "stop", requestId: request.id });
    clearPlayback();
    if (request) {
      activeRequest = null;
      request.reject(makeAbortError());
    }
  }

  async function synthesize(text, profile, options) {
    const spoken = String(text || "").trim();
    if (!spoken) return false;
    stop();
    const generation = synthesisGeneration;
    await unlockAudio();
    if (generation !== synthesisGeneration) throw makeAbortError();
    await prepare();
    if (generation !== synthesisGeneration) throw makeAbortError();
    const normalized = normalizeProfile(profile);
    if (gainNode) gainNode.gain.value = normalized.volume;
    const requestId = `kokoro-${Date.now()}-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      activeRequest = {
        id: requestId,
        resolve,
        reject,
        workerComplete: false,
        onPlaying: options?.onPlaying
      };
      updateState({ status: "ready", error: "" });
      worker.postMessage({ type: "generate", requestId, text: spoken, profile: normalized });
    });
  }

  return {
    MODEL_CACHE_FLAG,
    VOICE_IDS,
    DEFAULT_PROFILE,
    normalizeBlend,
    normalizeProfile,
    getState,
    setStateListener,
    prepare,
    unlockAudio,
    synthesize,
    stop
  };
});
