(function () {
  "use strict";

  const GLOBAL_KEY = "companion_api_key_v1";
  const ACTIVE_PROVIDER_KEY = "companion_active_provider_v1";
  const PROVIDERS_KEY = "companion_providers_v1";
  const PREFIX = "companion_api_key_provider_v1:";

  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;

  function providerId(storage) {
    const active = nativeGet.call(storage, ACTIVE_PROVIDER_KEY);
    if (active) return active;
    try {
      const providers = JSON.parse(nativeGet.call(storage, PROVIDERS_KEY) || "[]");
      if (Array.isArray(providers) && providers[0]?.id) return String(providers[0].id);
    } catch (_) {}
    return "anthropic-official";
  }

  function scopedKey(storage) {
    return `${PREFIX}${encodeURIComponent(providerId(storage))}`;
  }

  function syncKeyField() {
    queueMicrotask(() => {
      const input = document.querySelector?.("#apiKey");
      if (input) input.value = localStorage.getItem(GLOBAL_KEY) || "";
    });
  }

  Storage.prototype.getItem = function (key) {
    if (key !== GLOBAL_KEY) return nativeGet.call(this, key);
    const scoped = nativeGet.call(this, scopedKey(this));
    if (scoped !== null) return scoped;

    // One-time backwards compatible migration: the old global key belongs to
    // whichever provider was active at upgrade time.
    const legacy = nativeGet.call(this, GLOBAL_KEY);
    if (legacy !== null && legacy !== "") {
      nativeSet.call(this, scopedKey(this), legacy);
      nativeRemove.call(this, GLOBAL_KEY);
      return legacy;
    }
    return null;
  };

  Storage.prototype.setItem = function (key, value) {
    if (key === GLOBAL_KEY) {
      nativeSet.call(this, scopedKey(this), String(value));
      return;
    }
    nativeSet.call(this, key, String(value));
    if (key === ACTIVE_PROVIDER_KEY) syncKeyField();
  };

  Storage.prototype.removeItem = function (key) {
    if (key === GLOBAL_KEY) {
      nativeRemove.call(this, scopedKey(this));
      return;
    }
    nativeRemove.call(this, key);
    if (key === ACTIVE_PROVIDER_KEY) syncKeyField();
  };

  window.LeithProviderKeyStore = {
    currentProviderId: () => providerId(localStorage),
    currentStorageKey: () => scopedKey(localStorage)
  };
})();
