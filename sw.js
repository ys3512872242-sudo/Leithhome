const CACHE_NAME = "companion-shell-v5";
const SHELL_FILES = ["./index.html", "./app.js", "./memory.js", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 网络优先：standalone 模式下每次都尝试拿最新文件，只有断网时才回退到缓存。
// 之前用的是"缓存优先"，会导致已安装到主屏幕的 App 长期停留在旧版本，
// 即使 GitHub 上的文件已经更新、缓存版本号也升级了，也不会立刻生效。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")));
  if (!isShellFile) return; // 不拦截 API 请求

  event.respondWith(
    fetch(event.request)
      .then((networkResp) => {
        const clone = networkResp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return networkResp;
      })
      .catch(() => caches.match(event.request))
  );
});
