(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LeithVoice = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (root) {
  "use strict";

  const STORAGE_KEY = "leith_voice_output_v1";
  const DEFAULT_BLEND = Object.freeze([
    Object.freeze({ voice: "zm_009", weight: 100 }),
    Object.freeze({ voice: "zm_033", weight: 0 }),
    Object.freeze({ voice: "zm_080", weight: 0 })
  ]);
  const DEFAULTS = Object.freeze({
    autoSpeak: false,
    engine: "kokoro",
    profileName: "Leith",
    blend: DEFAULT_BLEND,
    rate: 0.94,
    volume: 1
  });

  let currentMessageId = "";

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeBlend(value) {
    if (root.LeithKokoro?.normalizeBlend) return root.LeithKokoro.normalizeBlend(value);
    const source = Array.isArray(value) ? value.slice(0, 3) : [];
    const slots = DEFAULT_BLEND.map((fallback, index) => ({
      voice: /^zm_\d{3}$/.test(source[index]?.voice || "") ? source[index].voice : fallback.voice,
      weight: clamp(source[index]?.weight, 0, 100, fallback.weight)
    }));
    if (!slots.some(item => item.weight > 0)) slots[0].weight = 100;
    return slots;
  }

  function getSettings() {
    let saved = {};
    try { saved = JSON.parse(root.localStorage?.getItem(STORAGE_KEY) || "{}"); } catch (_) {}
    // Fields from both older engines intentionally do not survive migration:
    // Kokoro is now the only voice engine.
    return {
      ...DEFAULTS,
      autoSpeak: saved.autoSpeak === true,
      engine: "kokoro",
      profileName: String(saved.profileName || DEFAULTS.profileName).trim().slice(0, 30) || DEFAULTS.profileName,
      blend: normalizeBlend(saved.blend),
      rate: clamp(saved.rate, 0.7, 1.25, DEFAULTS.rate),
      volume: clamp(saved.volume, 0, 1, DEFAULTS.volume)
    };
  }

  function saveSettings(next) {
    const merged = { ...getSettings(), ...(next || {}), engine: "kokoro" };
    const settings = {
      autoSpeak: merged.autoSpeak === true,
      engine: "kokoro",
      profileName: String(merged.profileName || DEFAULTS.profileName).trim().slice(0, 30) || DEFAULTS.profileName,
      blend: normalizeBlend(merged.blend),
      rate: clamp(merged.rate, 0.7, 1.25, DEFAULTS.rate),
      volume: clamp(merged.volume, 0, 1, DEFAULTS.volume)
    };
    try { root.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    emit("settings", { settings });
    return settings;
  }

  function getProfile(settings) {
    const source = settings || getSettings();
    return {
      name: source.profileName,
      blend: source.blend,
      speed: source.rate,
      volume: source.volume
    };
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
    // Old messages have no structured `_speech` field. Only explicitly quoted
    // dialogue is safe to read; actions and scene prose remain silent.
    return cleanSpokenText(quoted.join("。"));
  }

  function emit(state, detail) {
    if (!root.dispatchEvent || typeof root.CustomEvent !== "function") return;
    root.dispatchEvent(new root.CustomEvent("leith:voice-state", {
      detail: { state, messageId: currentMessageId, ...(detail || {}) }
    }));
  }

  function stop() {
    try { root.LeithKokoro?.stop?.(); } catch (_) {}
    const stoppedId = currentMessageId;
    currentMessageId = "";
    emit("idle", { messageId: stoppedId });
  }

  async function speak(value, options) {
    const text = cleanSpokenText(value);
    if (!text) return false;
    const engine = root.LeithKokoro;
    if (!engine?.synthesize) throw new Error("Kokoro 声音模块没有加载，请刷新后重试。");
    const messageId = String(options?.messageId || "preview");
    stop();
    currentMessageId = messageId;
    emit("loading", { messageId });
    try {
      await engine.synthesize(text, getProfile(), {
        onPlaying: () => emit("playing", { messageId })
      });
      if (currentMessageId === messageId) currentMessageId = "";
      emit("idle", { messageId });
      return true;
    } catch (error) {
      if (error?.name === "AbortError") {
        if (currentMessageId === messageId) {
          currentMessageId = "";
          emit("idle", { messageId });
        }
        return false;
      }
      if (currentMessageId === messageId) currentMessageId = "";
      emit("error", { messageId, error: error?.message || "Kokoro 语音播放失败。" });
      throw error;
    }
  }

  async function speakMessage(message, options) {
    const hasStructuredSpeech = Boolean(message && Object.prototype.hasOwnProperty.call(message, "_speech"));
    const spoken = hasStructuredSpeech
      ? cleanSpokenText(message._speech)
      : extractSpokenText(message?.content || "");
    if (!spoken) return false;
    return speak(spoken, { ...options, messageId: message?._id || options?.messageId });
  }

  async function maybeAutoSpeak(message) {
    if (!getSettings().autoSpeak) return false;
    return speakMessage(message, { auto: true });
  }

  function isSpeaking(messageId) {
    return Boolean(currentMessageId && (!messageId || currentMessageId === messageId));
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    getSettings,
    saveSettings,
    getProfile,
    cleanSpokenText,
    extractSpokenText,
    speak,
    speakMessage,
    maybeAutoSpeak,
    stop,
    isSpeaking
  };
});
