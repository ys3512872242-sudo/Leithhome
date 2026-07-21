// 缓存版本号：每次发布新代码时，这里都要变化，Service Worker 才会清掉旧缓存、
// 换上新文件——用一个固定的时间戳当版本号，比手动记得改数字更不容易漏掉。
// 这个值本身不需要每次手动改：只要发布流程里有一步"替换成当前时间"就行；
// 如果发布流程是纯手动复制文件，那还是需要发布前手动改一下这一行。
const CACHE_NAME = "companion-shell-20260721-daily-diary-thinking-sky-v23";
const SHELL_FILES = ["./index.html", "./app.js", "./memory.js", "./manifest.webmanifest", "./icon-leith-v2-192.png", "./icon-leith-v2-512.png"];

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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")));
  if (!isShellFile) return;

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
