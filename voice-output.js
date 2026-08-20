(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LeithVoice = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (root) {
  "use strict";

  const STORAGE_KEY = "leith_voice_output_v1";
  const DEFAULTS = Object.freeze({
    autoSpeak: false,
    engine: "system",
    systemVoiceURI: "",
    rate: 0.94,
    pitch: 0.92,
    volume: 1,
    endpoint: "http://127.0.0.1:9880/tts",
    refAudioPath: "",
    promptText: "",
    textLang: "zh",
    promptLang: "zh"
  });

  let currentAudio = null;
  let currentObjectUrl = "";
  let currentAbort = null;
  let currentMessageId = "";

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function getSettings() {
    let saved = {};
    try { saved = JSON.parse(root.localStorage?.getItem(STORAGE_KEY) || "{}"); } catch (_) {}
    return {
      ...DEFAULTS,
      ...saved,
      autoSpeak: saved.autoSpeak === true,
      engine: saved.engine === "gpt-sovits" ? "gpt-sovits" : "system",
      rate: clamp(saved.rate, 0.65, 1.35, DEFAULTS.rate),
      pitch: clamp(saved.pitch, 0.65, 1.35, DEFAULTS.pitch),
      volume: clamp(saved.volume, 0, 1, DEFAULTS.volume)
    };
  }

  function saveSettings(next) {
    const settings = { ...getSettings(), ...(next || {}) };
    try { root.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    emit("settings", { settings });
    return settings;
  }

  function cleanSpokenText(value) {
    return String(value || "")
      .replace(/<leith-event>[\s\S]*?<\/leith-event>/gi, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[*_~`#>]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2400);
  }

  function extractSpokenText(visibleReply) {
    const source = String(visibleReply || "");
    const quoted = [];
    const patterns = [
      /“([^”]{1,600})”/g,
      /「([^」]{1,600})」/g,
      /『([^』]{1,600})』/g,
      /"([^"\n]{1,600})"/g
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) quoted.push(match[1]);
    }
    // Old messages do not have the structured `_speech` field. In that case we
    // only trust explicitly quoted dialogue. Reading nothing is safer than
    // speaking an action, thought or scene description aloud.
    return cleanSpokenText(quoted.join("。"));
  }

  function emit(state, detail) {
    if (!root.dispatchEvent || typeof root.CustomEvent !== "function") return;
    root.dispatchEvent(new root.CustomEvent("leith:voice-state", {
      detail: { state, messageId: currentMessageId, ...(detail || {}) }
    }));
  }

  function clearAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
      currentAudio = null;
    }
    if (currentObjectUrl && root.URL?.revokeObjectURL) root.URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = "";
  }

  function stop() {
    try { root.speechSynthesis?.cancel(); } catch (_) {}
    if (currentAbort) currentAbort.abort();
    currentAbort = null;
    clearAudio();
    const stoppedId = currentMessageId;
    currentMessageId = "";
    emit("idle", { messageId: stoppedId });
  }

  function getSystemVoices() {
    if (!root.speechSynthesis?.getVoices) return [];
    return root.speechSynthesis.getVoices().slice().sort((a, b) => {
      const aChinese = /^zh/i.test(a.lang) ? 0 : 1;
      const bChinese = /^zh/i.test(b.lang) ? 0 : 1;
      return aChinese - bChinese || a.name.localeCompare(b.name, "zh-CN");
    });
  }

  function speakWithSystem(text, settings, messageId) {
    if (!root.speechSynthesis || typeof root.SpeechSynthesisUtterance !== "function") {
      throw new Error("当前浏览器没有可用的系统朗读功能。");
    }
    const utterance = new root.SpeechSynthesisUtterance(text);
    const voices = getSystemVoices();
    utterance.voice = voices.find(item => item.voiceURI === settings.systemVoiceURI)
      || voices.find(item => /^zh[-_](CN|Hans)/i.test(item.lang))
      || voices.find(item => /^zh/i.test(item.lang))
      || null;
    utterance.lang = utterance.voice?.lang || "zh-CN";
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
    utterance.onstart = () => emit("playing", { messageId });
    utterance.onend = () => {
      if (currentMessageId === messageId) currentMessageId = "";
      emit("idle", { messageId });
    };
    utterance.onerror = event => {
      if (event.error === "canceled" || event.error === "interrupted") return;
      if (currentMessageId === messageId) currentMessageId = "";
      emit("error", { messageId, error: "系统语音播放失败。" });
    };
    root.speechSynthesis.speak(utterance);
  }

  function validateLocalEndpoint(value) {
    let url;
    try { url = new URL(String(value || "")); } catch (_) { throw new Error("本地语音地址格式不正确。"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("本地语音地址必须使用 http 或 https。");
    return url.toString();
  }

  async function speakWithGptSovits(text, settings, messageId) {
    if (!settings.refAudioPath.trim()) throw new Error("请先填写 Leith 参考声音在 GPT-SoVITS 服务中的路径。");
    if (!settings.promptText.trim()) throw new Error("请填写参考音频中实际说出的文字。");
    currentAbort = new AbortController();
    emit("loading", { messageId });
    const response = await root.fetch(validateLocalEndpoint(settings.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "audio/wav,audio/*" },
      signal: currentAbort.signal,
      body: JSON.stringify({
        text,
        text_lang: settings.textLang || "zh",
        ref_audio_path: settings.refAudioPath.trim(),
        prompt_text: settings.promptText.trim(),
        prompt_lang: settings.promptLang || "zh",
        text_split_method: "cut5",
        batch_size: 1,
        media_type: "wav",
        streaming_mode: false,
        speed_factor: settings.rate
      })
    });
    if (!response.ok) {
      const message = (await response.text().catch(() => "")).slice(0, 180);
      throw new Error(`GPT-SoVITS 返回 ${response.status}${message ? `：${message}` : ""}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("GPT-SoVITS 返回了空音频。");
    currentObjectUrl = root.URL.createObjectURL(blob);
    currentAudio = new root.Audio(currentObjectUrl);
    currentAudio.volume = settings.volume;
    currentAudio.onplay = () => emit("playing", { messageId });
    currentAudio.onended = () => {
      clearAudio();
      if (currentMessageId === messageId) currentMessageId = "";
      emit("idle", { messageId });
    };
    currentAudio.onerror = () => emit("error", { messageId, error:"生成的音频无法播放。" });
    await currentAudio.play();
  }

  async function speak(value, options) {
    const text = cleanSpokenText(value);
    if (!text) return false;
    const messageId = String(options?.messageId || "preview");
    stop();
    currentMessageId = messageId;
    const settings = getSettings();
    try {
      if (settings.engine === "gpt-sovits") await speakWithGptSovits(text, settings, messageId);
      else speakWithSystem(text, settings, messageId);
      return true;
    } catch (error) {
      if (error?.name === "AbortError") return false;
      currentMessageId = "";
      emit("error", { messageId, error:error.message || "语音播放失败。" });
      throw error;
    } finally {
      currentAbort = null;
    }
  }

  async function speakMessage(message, options) {
    const hasStructuredSpeech = Boolean(message && Object.prototype.hasOwnProperty.call(message, "_speech"));
    const spoken = hasStructuredSpeech
      ? cleanSpokenText(message._speech)
      : extractSpokenText(message?.content || "");
    if (!spoken) return false;
    return speak(spoken, { ...options, messageId:message?._id || options?.messageId });
  }

  async function maybeAutoSpeak(message) {
    if (!getSettings().autoSpeak) return false;
    return speakMessage(message, { auto:true });
  }

  function isSpeaking(messageId) {
    return Boolean(currentMessageId && (!messageId || currentMessageId === messageId));
  }

  return {
    DEFAULTS,
    getSettings,
    saveSettings,
    getSystemVoices,
    cleanSpokenText,
    extractSpokenText,
    speak,
    speakMessage,
    maybeAutoSpeak,
    stop,
    isSpeaking
  };
});
