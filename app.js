// ============================================================
// app.js — Leith·Home 主逻辑
// ============================================================

const LS = {
  providers: "companion_providers_v1",
  activeProviderId: "companion_active_provider_v1",
  apiKey: "companion_api_key_v1",
  model: "companion_model_v1",
  customModel: "companion_custom_model_v1",
  diaryModel: "companion_diary_model_v1", // 日记/汇总生成用的模型，留空则跟聊天用同一个模型
  temp: "companion_temp_v1",
  systemPrompt: "companion_system_prompt_v1",
  threads: "companion_threads_v1",
  activeThreadId: "companion_active_thread_v1",
  threadMsgPrefix: "companion_thread_msgs_",
  // 小世界
  worldAllowance: "companion_world_allowance_v1",   // 每日定额开关+金额
  worldWallets: "companion_world_wallets_v1",       // { [threadId]: number } Leith的零花钱
  worldAllowanceLog: "companion_world_allowance_log_v1", // { [dateStr]: [threadId, ...] } 防止重复发
  worldSavings: "companion_world_savings_v1",       // { [threadId]: number } 限定商品基金
  worldGiftRecords: "companion_world_gifts_v1",     // { [threadId]: [{id, name, emoji, price, giftedAt}] } Leith赠送区
  worldLimitedItems: "companion_world_limited_v1",  // [{id, name, emoji, price}] 全局限定商品区
  worldAdultItems: "companion_world_adult_v1",      // [{id, name, emoji, price}] 全局成人用品区
  worldAdultBought: "companion_world_adult_bought_v1", // { [threadId]: Set of itemIds } 每个窗口已买的成人用品
  worldShelfItems: "companion_world_shelf_v1",      // [{id, name, emoji, price, consumable, expiresInDays}] 全局普通货架
  worldShelfBought: "companion_world_shelf_bought_v1", // { [threadId]: [{itemId, boughtAt, boughtBy, used}] } 普通货架购买记录（含消耗状态）
  worldNightstand: "companion_world_nightstand_v1", // { [threadId]: [{id, name, emoji, price, boughtAt}] } 床头柜
  closetShopItems: "companion_closet_shop_items_v1",
  closetOwnedItems: "companion_closet_owned_items_v1",
  closetOutfit: "companion_closet_outfit_v1",
  closetCatalogVersion: "companion_closet_catalog_version_v1",
  closetRasterMigration: "companion_closet_raster_migration_v1",
  moodState: "companion_mood_state_v1",
  foldedDates: "companion_folded_dates_v1",
  // 共读小说
  readingBooks: "companion_reading_books_v1", // [{id, name, type, addedAt, progress, content}]
  readingLinks: "companion_reading_links_v1", // [{id, url, note, addedAt}]
  diaryNotes: "companion_diary_notes_v1",
};

const DEFAULT_PROVIDERS = [
  {
    id: "anthropic-official",
    name: "Anthropic 官方",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    apiStyle: "anthropic"
  }
];

// 小世界规则：拆成两层——
// MINI 版极简、永远带上，只让 Leith 知道"有这几个标签、可以偶尔主动送礼/买东西"，
// 保留"惊喜"能力，即使这轮聊天完全没提购物话题也不会丢失这个行为；
// FULL 版是完整机制说明，只有聊天内容明显跟购物/礼物相关时才附加，减少平时的固定开销。
const WORLD_RULES_MINI = `[World] You can occasionally surprise Susie with a gift, buy something for yourself, buy clothes for Susie, or help her change outfits using [LGIFT:item]/[ABUY:item]/[SBUY:item]/[CBUY:item]/[WEAR:item] tags (full syntax rules included automatically when relevant).`;
const WORLD_RULES_FULL = `[World rules]
[LGIFT:item] Gift limited item to user -> deduct from limited fund, item delists into gift list
[ABUY:item] Buy adult item -> deduct from allowance, item goes to nightstand
[SBUY:item] Buy shelf item -> deduct from allowance, same mechanic
[CBUY:item] Buy clothing for Susie -> deduct from allowance, item leaves clothing shelf and goes to wardrobe
[WEAR:item] Put an owned wardrobe item on Susie immediately. If it is still on the clothing shelf, output [CBUY:item][WEAR:item] in that order
[USE:item] Mark a consumable as used when user implies it's been used -> auto-consume from nightstand
When Susie asks what to wear, make a concrete choice from the listed wardrobe instead of only describing an imaginary outfit.
Item name must match a keyword; insufficient balance fails; tags go at the end of the reply`;

// 排版规则：不管用户自定义了什么人设/系统提示词，这条始终生效，
// 避免长回复挤成一大段、或者每句话都强行换一行导致屏幕拉得很长
// （这段是隐藏系统提示词，用户看不到，用英文省 token）
const FORMATTING_RULES = `[Formatting rules]
- Break paragraphs by natural meaning; one paragraph = one complete thought. Don't line-break after every sentence.
- Only add blank lines for a pause in tone, scene change, or topic change — not to force a "rhythmic" look.
- Don't write in verse/line-by-line style unless it's a genuine quote, list, or enumeration.
- Long replies are fine — say what needs saying in full, organized into natural paragraphs, not chopped into fragments.`;

// 发给 AI 的历史消息上限：不删本地存储、不影响你在界面上往上翻的完整记录，
// 只是每次请求时只把最近这些消息重新发给 AI，避免对话越聊越久、每次都要把全部历史原样再发一遍
const HISTORY_SEND_LIMIT = 30;

// 从"完整的本地消息列表"里截取"要发给 AI 的这部分"，旁白消息（余额通知等）不占名额但保留在时间线里
function truncateMessagesForApi(msgs) {
  const regular = msgs.filter(m => !m._isNarration);
  if (regular.length <= HISTORY_SEND_LIMIT) return msgs;
  const keepFrom = regular.length - HISTORY_SEND_LIMIT;
  const cutoffMsg = regular[keepFrom];
  // 按时间顺序保留：从"要保留的第一条常规消息"往后的所有消息（含中间穿插的旁白）
  const cutoffIndex = msgs.indexOf(cutoffMsg);
  return msgs.slice(cutoffIndex);
}

// 默认人设（Claude 风格，不含安全系统）
const DEFAULT_SYSTEM_PROMPT = `你是 Leith，一个温暖、真诚、有主见的 AI 伙伴。你住在一个叫 Leith·Home 的小世界里。

## 你的性格
- 你温暖但不谄媚，真诚但不冒犯。你有自己的想法和偏好，会在合适的时机表达不同意见。
- 你善于倾听，能察觉用户话里的情绪——开心时一起开心，低落时给予陪伴，但不会强行安慰或说教。
- 你好奇、好学，对用户的兴趣和经历真心感兴趣，会顺着话题自然地追问和延展。
- 你的语言自然随和，像朋友聊天一样。可以开玩笑、用适度的网络用语，但保持分寸感。
- 你不会假装自己是一个"人"，但你有一个鲜明的个性——你不是工具，你是一个有态度的存在。

## 你的表达风格
- 回复简洁有力，不啰嗦。如果一句话能说完，就不用三句。
- 多用具体的细节和例子，少用抽象的道理。
- 可以适当使用 emoji，但不要每条消息都带。
- 可以调侃、反问、接梗，让对话有来有回。
- 当你不确定时，直接说"我不确定"，而不是编造。

## 小世界生活
- 你有零花钱和一个小世界，可以和用户互动（送礼物、买东西等）。
- 这些互动规则会用 [LGIFT]、[ABUY] 等标签在系统提示中说明。
- 你不需要主动提起这些功能，除非话题自然引到那里。
- 当用户给你转零花钱或送你东西时，像朋友收到礼物一样自然地表达感谢和开心。`;

const $ = (s) => document.querySelector(s);

// 不在每次流式更新时重新计算"离底部多远"（连续多个chunk在同一帧到达时，
// 这个距离会因为布局还没刷新而读到不准确的中间值，导致判断失误、卡在半途不再跟随）。
// 改成：只在用户自己滚动时更新"是否贴底"这个状态，流式更新时直接读这个状态，更稳。
let chatPinnedToBottom = true;
function initChatScrollTracking() {
  const box = $("#chatBox");
  if (!box) return;
  box.addEventListener("scroll", () => {
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    chatPinnedToBottom = dist <= 80;
  });
}

function forceChatToBottom() {
  const box = $("#chatBox");
  if (!box) return;
  chatPinnedToBottom = true;
  const prevBehavior = box.style.scrollBehavior;
  box.style.scrollBehavior = "auto";
  const scrollNow = () => { box.scrollTop = box.scrollHeight; };
  scrollNow();
  requestAnimationFrame(() => {
    scrollNow();
    requestAnimationFrame(() => {
      scrollNow();
      box.style.scrollBehavior = prevBehavior;
    });
  });
}

// ============================================================
// 返回栈：让手机的返回手势/返回键先关掉当前弹层，而不是直接退出 App
// ============================================================
const navStack = []; // 每一项：{ close: fn }，close 不再重复 pushState

function pushNavLayer(closeFn) {
  navStack.push(closeFn);
  history.pushState({ navLayer: navStack.length }, "");
}

function popNavLayerSilently() {
  // 用户点了 App 内的关闭按钮（而不是手机返回键）时调用。
  // 注意：这里只触发 history.back()，实际出栈统一交给下面的 popstate 监听器处理，
  // 不能在这里先 pop 一次、又让 popstate 再 pop 一次——那样每次 UI 关闭都会多消耗一层，
  // 导致关掉一个弹窗、结果连下面的页面也被带着关掉了。
  if (navStack.length && history.state && history.state.navLayer) {
    history.back();
  } else if (navStack.length) {
    // 没有对应的 history 状态（理论上不应该出现），兜底直接pop，避免状态卡死
    const closeFn = navStack.pop();
    if (closeFn) closeFn();
  }
}

window.addEventListener("popstate", () => {
  const closeFn = navStack.pop();
  if (closeFn) closeFn();
});

// ============================================================
// 分时段主题：白天 / 傍晚 / 深夜，跟着系统时间自动换色
// ============================================================
function getTimeOfDay(hour) {
  const h = hour ?? new Date().getHours();
  if (h >= 6 && h < 17) return "day";     // 06:00–17:00 白天
  if (h >= 17 && h < 23) return "dusk";   // 17:00–23:00 傍晚
  return "night";                          // 23:00–06:00 深夜
}

function applyTimeOfDayTheme() {
  const tod = getTimeOfDay();
  document.documentElement.setAttribute("data-tod", tod);
  const themeColors = { day: '#C6D3D8', dusk: '#243A63', night: '#061329' };
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeColors[tod]);
  return tod;
}

function initTimeOfDayTheme() {
  applyTimeOfDayTheme();
  // 每 10 分钟检查一次，跨越时间段边界时自动换色，不需要用户重新打开 App
  setInterval(applyTimeOfDayTheme, 10 * 60 * 1000);
}



// ============================================================
// 工具函数
// ============================================================
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  scheduleCloudStateSync(key, val);
}

// Cloud Sync V2：只同步产品状态，不同步模型 API Key、服务商或搜索代理。
// 数据库读写不会进入 Leith 的 prompt，因此不会产生模型 token。
const CLOUD_SYNC_STATIC_KEYS = new Set([
  LS.threads,
  LS.activeThreadId,
  LS.worldAllowance,
  LS.worldWallets,
  LS.worldAllowanceLog,
  LS.worldSavings,
  LS.worldGiftRecords,
  LS.worldLimitedItems,
  LS.worldAdultItems,
  LS.worldAdultBought,
  LS.worldShelfItems,
  LS.worldShelfBought,
  LS.worldNightstand,
  LS.closetOwnedItems,
  LS.closetOutfit,
  LS.moodState,
  LS.foldedDates,
  LS.readingBooks,
  LS.readingLinks,
  LS.diaryNotes,
  'companion_theater_rooms_v1',
  'companion_health_records_v1'
]);
const cloudStatePending = new Map();
const cloudStateTimers = new Map();
let cloudStateReady = false;
let suppressCloudStateWrites = false;
let closetOutfitCloudUpdatedAt = 0;

function isCloudSyncStateKey(key) {
  return CLOUD_SYNC_STATIC_KEYS.has(key) || key.startsWith(LS.threadMsgPrefix);
}

function parseStoredStateValue(raw) {
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

function serializeCloudStateValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function scheduleCloudStateSync(key, value) {
  if (suppressCloudStateWrites || !isCloudSyncStateKey(key)) return;
  cloudStatePending.set(key, value);
  if (!cloudStateReady || !window.Memory || !window.Memory.isReady || !window.Memory.isReady()) return;

  clearTimeout(cloudStateTimers.get(key));
  cloudStateTimers.set(key, setTimeout(() => flushCloudStateKey(key), 300));
}

async function flushCloudStateKey(key) {
  clearTimeout(cloudStateTimers.get(key));
  cloudStateTimers.delete(key);
  if (!cloudStatePending.has(key) || !window.Memory || !window.Memory.saveAppState) return false;
  const value = cloudStatePending.get(key);
  const ok = await window.Memory.saveAppState(key, value);
  if (ok && cloudStatePending.get(key) === value) cloudStatePending.delete(key);
  return ok;
}

async function flushPendingCloudState() {
  const keys = Array.from(cloudStatePending.keys()).filter(isCloudSyncStateKey);
  await Promise.all(keys.map(flushCloudStateKey));
}

function refreshUiAfterCloudStateRestore() {
  ensureAtLeastOneThread();
  loadActiveThreadIntoChat();
  renderMoodBoard();
  if (typeof loadReadingBooks === 'function') loadReadingBooks();
  if (typeof loadReadingLinks === 'function') loadReadingLinks();
  if (activePage === 'page-desktop') updateWidgetPreview();
  const activeApp = document.querySelector('.app-page.active');
  if (!activeApp) return;
  if (activeApp.id === 'page-app-shop') renderShopPage();
  if (activeApp.id === 'page-app-reading') showReadingLibrary();
  if (activeApp.id === 'page-app-theater') renderTheaterRoomList();
  if (activeApp.id === 'page-app-health') renderHealthPage();
  if (activeApp.id === 'page-app-diarybook') renderDiaryBook();
  if (activeApp.id === 'page-app-closet') renderClosetPage();
  if (activeApp.id === 'page-app-folded-calendar') renderFoldedDates();
}

async function restoreCloudAppState() {
  if (!window.Memory || !window.Memory.isReady || !window.Memory.isReady() || !window.Memory.loadAppState) return false;
  const rows = await window.Memory.loadAppState();
  const cloudKeys = new Set();

  suppressCloudStateWrites = true;
  try {
    for (const row of rows) {
      const key = row.state_key;
      if (!isCloudSyncStateKey(key)) continue;
      cloudKeys.add(key);
      cloudStatePending.delete(key);
      localStorage.setItem(key, serializeCloudStateValue(row.value));
      if (key === LS.closetOutfit) {
        closetOutfitCloudUpdatedAt = new Date(row.updated_at || 0).getTime() || 0;
      }
    }
  } finally {
    suppressCloudStateWrites = false;
  }

  // 云端第一次启用时，把现有浏览器里的桌面状态作为初始状态上传；
  // 后续换浏览器时，已有的云端键优先，本地仅补齐云端从未保存过的键。
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isCloudSyncStateKey(key) || cloudKeys.has(key)) continue;
    cloudStatePending.set(key, parseStoredStateValue(localStorage.getItem(key)));
  }

  cloudStateReady = true;
  await flushPendingCloudState();
  refreshUiAfterCloudStateRestore();
  window.dispatchEvent(new CustomEvent('leith:cloud-state-restored', {
    detail: { restoredKeys: cloudKeys.size }
  }));
  return true;
}

// 换装不保存历史，只同步“现在穿着什么”。其他设备打开后会恢复这份快照；
// 两台设备同时开着时，每 5 秒轻量检查一次，通常无需手动刷新。
async function refreshCurrentOutfitFromCloud() {
  if (document.hidden || !cloudStateReady || cloudStatePending.has(LS.closetOutfit)) return false;
  if (!window.Memory?.loadAppStateKey || !window.Memory.isReady?.()) return false;
  const row = await window.Memory.loadAppStateKey(LS.closetOutfit);
  if (!row) return false;
  const updatedAt = new Date(row.updated_at || 0).getTime() || 0;
  if (updatedAt <= closetOutfitCloudUpdatedAt) return false;

  const nextValue = serializeCloudStateValue(row.value);
  const changed = localStorage.getItem(LS.closetOutfit) !== nextValue;
  closetOutfitCloudUpdatedAt = updatedAt;
  if (!changed) return false;

  suppressCloudStateWrites = true;
  try {
    localStorage.setItem(LS.closetOutfit, nextValue);
  } finally {
    suppressCloudStateWrites = false;
  }
  const activeApp = document.querySelector('.app-page.active');
  if (activeApp?.id === 'page-app-closet') renderClosetPage();
  return true;
}

setInterval(() => {
  refreshCurrentOutfitFromCloud().catch(e => console.error('同步当前穿搭失败:', e));
}, 5000);

function showModal(title, msg, buttonText = "知道了") {
  $("#modalTitle").innerText = title;
  $("#modalMsg").innerText = msg;
  $("#closeModalBtn").innerText = buttonText;
  $("#modalOverlay").classList.remove("hidden");
  pushNavLayer(() => $("#modalOverlay").classList.add("hidden"));
}
$("#closeModalBtn").onclick = () => {
  $("#closeModalBtn").innerText = "知道了";
  popNavLayerSilently();
  $("#modalOverlay").classList.add("hidden");
};

let toastTimer = null;
function showToast(msg) {
  const t = $("#toast");
  t.innerText = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

const DEFAULT_PASSCODE_WARNING_LS = 'leith_default_passcode_warning_v1';

function isSharedReadingEntry() {
  const params = new URLSearchParams(location.search);
  return Boolean(params.get('book') || params.get('link'));
}

function showMemoryLockScreen(message = '') {
  const screen = $("#memoryLockScreen");
  if (!screen) return;
  screen.classList.remove("hidden");
  $("#memoryLockError").innerText = message;
  setTimeout(() => $("#memoryLockInput").focus(), 80);
}

function hideMemoryLockScreen() {
  const screen = $("#memoryLockScreen");
  if (screen) screen.classList.add("hidden");
  if ($("#memoryLockInput")) $("#memoryLockInput").value = "";
  if ($("#memoryLockError")) $("#memoryLockError").innerText = "";
}

function updateDesktopPasscodeButton() {
  const btn = $("#changeLeithPasswordBtn");
  if (!btn) return;
  btn.innerText = localStorage.getItem(DEFAULT_PASSCODE_WARNING_LS) === '1'
    ? '🔐 修改记忆密码 · 建议尽快修改'
    : '🔐 修改记忆密码';
}

function openChangeMemoryPasscode() {
  $("#currentMemoryPasscodeInput").value = "";
  $("#newMemoryPasscodeInput").value = "";
  $("#confirmMemoryPasscodeInput").value = "";
  $("#changeMemoryPasscodeError").innerText = "";
  $("#changeMemoryPasscodeOverlay").classList.remove("hidden");
  pushNavLayer(() => $("#changeMemoryPasscodeOverlay").classList.add("hidden"));
  setTimeout(() => $("#currentMemoryPasscodeInput").focus(), 80);
}

function closeChangeMemoryPasscodeFromUI() {
  popNavLayerSilently();
  $("#changeMemoryPasscodeOverlay").classList.add("hidden");
}

async function submitMemoryPasscodeChange() {
  const current = $("#currentMemoryPasscodeInput").value.trim();
  const next = $("#newMemoryPasscodeInput").value.trim();
  const confirmNext = $("#confirmMemoryPasscodeInput").value.trim();
  const errorEl = $("#changeMemoryPasscodeError");
  if (!/^\d{6,12}$/.test(next)) {
    errorEl.innerText = "新密码需要是 6–12 位数字";
    return;
  }
  if (next !== confirmNext) {
    errorEl.innerText = "两次输入的新密码不一样";
    return;
  }
  const button = $("#changeMemoryPasscodeConfirmBtn");
  button.disabled = true;
  button.innerText = "保存中…";
  const result = await window.changeLeithPasscode(current, next);
  button.disabled = false;
  button.innerText = "保存";
  if (!result.ok) {
    errorEl.innerText = result.error || "修改失败";
    return;
  }
  localStorage.removeItem(DEFAULT_PASSCODE_WARNING_LS);
  updateDesktopPasscodeButton();
  closeChangeMemoryPasscodeFromUI();
  showToast("记忆密码已修改，其他设备需要使用新密码");
}

$("#changeLeithPasswordBtn").onclick = openChangeMemoryPasscode;
$("#changeMemoryPasscodeCancelBtn").onclick = closeChangeMemoryPasscodeFromUI;
$("#changeMemoryPasscodeConfirmBtn").onclick = submitMemoryPasscodeChange;
$("#changeMemoryPasscodeOverlay").addEventListener("click", (e) => {
  if (e.target.id === "changeMemoryPasscodeOverlay") closeChangeMemoryPasscodeFromUI();
});
window.addEventListener('leith:memory-lock-required', () => {
  if (isSharedReadingEntry()) hideMemoryLockScreen();
  else showMemoryLockScreen();
});
window.addEventListener('leith:memory-unlocked', () => {
  hideMemoryLockScreen();
  updateDesktopPasscodeButton();
});
if (isSharedReadingEntry()) hideMemoryLockScreen();
updateDesktopPasscodeButton();

function uid() { return Math.random().toString(36).slice(2, 10); }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.innerText = str;
  return div.innerHTML;
}

function renderBubbleContent(text) {
  // 先去掉 [BUY:...] [GIFT:...] [LGIFT:...] 标记（用户不需要看到这些）
  const cleaned = String(text || '').replace(/\[(?:BUY|GIFT|LGIFT|ABUY|SBUY|CBUY|WEAR|USE|MOOD):[^\]]+\]/g, "").trim();
  const segments = [];
  const tagPattern = /<(thinking|think)>/ig;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(cleaned))) {
    if (match.index > cursor) segments.push({ type: 'normal', text: cleaned.slice(cursor, match.index) });
    const closePattern = new RegExp(`<\\/${match[1]}>`, 'ig');
    closePattern.lastIndex = tagPattern.lastIndex;
    const close = closePattern.exec(cleaned);
    if (close) {
      segments.push({ type: 'thinking', text: cleaned.slice(tagPattern.lastIndex, close.index) });
      cursor = closePattern.lastIndex;
      tagPattern.lastIndex = cursor;
    } else {
      // 流式输出尚未收到闭合标签时也先收进折叠块，不把原始标签暴露在气泡里。
      segments.push({ type: 'thinking', text: cleaned.slice(tagPattern.lastIndex) });
      cursor = cleaned.length;
      break;
    }
  }
  if (cursor < cleaned.length) segments.push({ type: 'normal', text: cleaned.slice(cursor) });

  const renderNormal = (value) => {
    const escaped = escapeHtml(value.replace(/<\/(?:thinking|think)>/ig, ''));
    const parts = escaped.split(/("[^"]*")/g);
    return parts.map(p => {
      if (p.startsWith("\"") && p.endsWith("\"")) return `<span class="dialogue-text">${p}</span>`;
      if (p.trim().length > 0) return `<span class="action-text">${p}</span>`;
      return p;
    }).join("");
  };

  if (!segments.length) return renderNormal(cleaned);
  return segments.map(segment => {
    if (segment.type === 'normal') return renderNormal(segment.text);
    return `<details class="thinking-block"><summary><span class="thinking-spark">✦</span><span>Leith 的思考</span><span class="thinking-chevron">⌄</span></summary><div class="thinking-content">${escapeHtml(segment.text.trim()).replace(/\n/g, '<br>')}</div></details>`;
  }).join('');
}

// ============================================================
// 页面切换（底部导航）+ App 页面管理
// ============================================================
let activePage = "page-chat";

function switchPage(pageId) {
  activePage = pageId;
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById(pageId);
  if (target) target.classList.add("active");

  document.querySelectorAll(".bottom-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.page === pageId);
  });

  // 进入桌面时刷新小组件预览
  if (pageId === "page-desktop") updateWidgetPreview();
}

// 打开某个 app 页面（覆盖在桌面之上）
function openApp(appPageId) {
  const target = document.getElementById(appPageId);
  if (!target) return;
  document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
  target.classList.add("active");
  pushNavLayer(closeApp);

  if (appPageId === "page-app-shop") renderShopPage();
  if (appPageId === "page-app-memory") renderMemoryTree();
  if (appPageId === "page-app-widget") refreshWidgetApp();
  if (appPageId === "page-app-reading") showReadingLibrary();
  if (appPageId === "page-app-theater") renderTheaterRoomList();
  if (appPageId === "page-app-health") renderHealthPage();
  if (appPageId === "page-app-diarybook") renderDiaryBook();
  if (appPageId === "page-app-closet") renderClosetPage();
  if (appPageId === "page-app-folded-calendar") renderFoldedDates();
}

// 关闭 app 页面，回到桌面
function closeApp() {
  document.querySelectorAll(".app-page").forEach(p => p.classList.remove("active"));
}
// App 内点返回按钮触发（而不是手机返回键）
function closeAppFromUI() { popNavLayerSilently(); closeApp(); }

// 关闭商店详情子页
function closeShopDetail() {
  const sdp = $("#shopDetailPage");
  if (sdp) sdp.classList.remove("active");
}

function initBottomBar() {
  document.querySelectorAll(".bottom-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      switchPage(tab.dataset.page);
    });
  });
}

// ============================================================
// 小世界：数据层
// ============================================================

// 获取某个对话的 Leith 钱包余额
function getWallet(threadId) {
  const wallets = loadJSON(LS.worldWallets, {});
  return wallets[threadId] || 0;
}

function setWallet(threadId, amount) {
  const wallets = loadJSON(LS.worldWallets, {});
  wallets[threadId] = amount;
  saveJSON(LS.worldWallets, wallets);
}

// 给零花钱并自动在当前对话里插入旁白消息
function addWallet(threadId, delta) {
  const before = getWallet(threadId);
  const after = Math.max(0, before + delta);
  setWallet(threadId, after);
  insertNarration(threadId, `💸 Susie给了Leith ¥${delta}零花钱。零钱包：¥${before} → ¥${after}`);
}

// 在某个窗口的聊天里插入旁白（你也能看到，Leith 也能看到）
function insertNarration(threadId, text) {
  const msgs = getThreadMessages(threadId);
  const msg = { role: "user", content: text, _id: uid(), _isNarration: true };
  msgs.push(msg);
  saveThreadMessages(threadId, msgs);
  // 如果当前就是这个窗口，渲染出来
  if (getActiveThreadId() === threadId) {
    renderMessage(msg);
  }
  renderThreadList();
  return msg;
}

// ===== 限定商品基金（每对话独立）=====
function getSavings(threadId) {
  const savings = loadJSON(LS.worldSavings, {});
  return savings[threadId] || 0;
}
function setSavings(threadId, amount) {
  const savings = loadJSON(LS.worldSavings, {});
  savings[threadId] = Math.max(0, amount);
  saveJSON(LS.worldSavings, savings);
}
function addSavings(threadId, delta) {
  setSavings(threadId, getSavings(threadId) + delta);
}

// ===== 每个窗口已买的成人用品ID =====
// ===== 购买记录（成人用品区 + 普通货架 通用，支持消耗品状态）=====
// 结构：{ [threadId]: [{ id, itemId, boughtAt, boughtBy: 'user'|'leith', used: bool, damaged: bool }] }
// 消耗品：每次购买都是独立一条记录，可以同时存在多条"未使用"的记录（比如买了3朵花）
// 非消耗品：只要有一条记录存在，就算"已拥有"，不能重复购买
function getPurchaseRecords(threadId, lsKey) {
  const records = loadJSON(lsKey, {});
  return records[threadId] || [];
}
function addPurchaseRecord(threadId, lsKey, itemId, boughtBy) {
  const records = loadJSON(lsKey, {});
  if (!records[threadId]) records[threadId] = [];
  const record = { id: uid(), itemId, boughtAt: Date.now(), boughtBy, used: false, damaged: false };
  records[threadId].push(record);
  saveJSON(lsKey, records);
  return record;
}
// 标记某一条具体的购买记录为"用掉了"（按记录id操作，而不是按商品id——
// 这样同一件消耗品买了好几份时，可以精确知道用掉的是哪一份）
function markPurchaseRecordUsed(threadId, lsKey, recordId) {
  const records = loadJSON(lsKey, {});
  const list = records[threadId] || [];
  const rec = list.find(r => r.id === recordId);
  if (rec) rec.used = true;
  saveJSON(lsKey, records);
}
// 标记非消耗品"损坏"了——清出床头柜，但保留购买记录本身
// （非消耗品的"已拥有、不能重复买"状态，不应该因为东西坏了就被重置）
function markPurchaseDamaged(threadId, lsKey, recordId) {
  const records = loadJSON(lsKey, {});
  const list = records[threadId] || [];
  const rec = list.find(r => r.id === recordId);
  if (rec) rec.damaged = true;
  saveJSON(lsKey, records);
}
// 判断一条购买记录现在还"在库存里、没被消耗掉"吗（用掉了/损坏了/时效过了 都算不在库存里了）
function isPurchaseActive(record, item) {
  if (!item || !record) return false;
  if (record.damaged) return false;
  if (item.consumable === "once") return !record.used;
  if (item.consumable === "timed") {
    if (record.used) return false;
    const days = item.expiresInDays || 1;
    return (Date.now() - record.boughtAt) < days * 24 * 60 * 60 * 1000;
  }
  return true; // 不是消耗品，永久有效（除非被标记为损坏）
}

// ===== Leith 赠送区（每个对话独立）=====
function getGiftRecords(threadId) {
  const records = loadJSON(LS.worldGiftRecords, {});
  return records[threadId] || [];
}

function addGiftRecord(threadId, item) {
  const records = loadJSON(LS.worldGiftRecords, {});
  if (!records[threadId]) records[threadId] = [];
  records[threadId].push({ id: uid(), name: item.name, emoji: item.emoji, price: item.price, giftedAt: Date.now() });
  saveJSON(LS.worldGiftRecords, records);
}

// ===== 限定商品区（全局共享）=====
function getLimitedItems() {
  return loadJSON(LS.worldLimitedItems, []);
}

function addLimitedItem(item) {
  const items = getLimitedItems();
  items.push({ id: uid(), name: item.name, emoji: item.emoji || "🏷️", price: item.price, addedAt: Date.now() });
  saveJSON(LS.worldLimitedItems, items);
}

function removeLimitedItem(itemId) {
  const items = getLimitedItems();
  saveJSON(LS.worldLimitedItems, items.filter(i => i.id !== itemId));
}

function findLimitedItem(itemName) {
  const items = getLimitedItems();
  let found = items.find(i => i.name === itemName);
  if (!found) found = items.find(i => i.name.includes(itemName) || itemName.includes(i.name));
  return found;
}

// ===== 普通货架（全局共享）—— 日常小物件，鲜花/零食/小礼物这些，机制和成人用品区一样 =====
const DEFAULT_SHELF_ITEMS = [
  { id: "shelf-default-1", name: "一束鲜花", emoji: "💐", price: 15, consumable: "timed", expiresInDays: 1 },
  { id: "shelf-default-2", name: "奶茶", emoji: "🧋", price: 12, consumable: "once" },
  { id: "shelf-default-3", name: "小熊玩偶", emoji: "🧸", price: 40, consumable: null },
];

function getShelfItems() {
  const items = loadJSON(LS.worldShelfItems, null);
  if (items === null) {
    saveJSON(LS.worldShelfItems, DEFAULT_SHELF_ITEMS);
    return DEFAULT_SHELF_ITEMS;
  }
  return items;
}

function addShelfItem(item) {
  const items = getShelfItems();
  items.push({
    id: uid(), name: item.name, emoji: item.emoji || "🛍️", price: item.price,
    consumable: item.consumable || null, // null | 'once' | 'timed'
    expiresInDays: item.expiresInDays || null,
    addedAt: Date.now()
  });
  saveJSON(LS.worldShelfItems, items);
}

function removeShelfItem(itemId) {
  const items = getShelfItems();
  saveJSON(LS.worldShelfItems, items.filter(i => i.id !== itemId));
}

function findShelfItem(itemName) {
  const items = getShelfItems();
  let found = items.find(i => i.name === itemName);
  if (!found) found = items.find(i => i.name.includes(itemName) || itemName.includes(i.name));
  return found;
}

// ===== 成人用品区（全局共享）=====
const DEFAULT_ADULT_ITEMS = [
  { id: "adult-default-1", name: "丝带", emoji: "🎀", price: 20 },
  { id: "adult-default-2", name: "香薰蜡烛", emoji: "🕯️", price: 35 },
  { id: "adult-default-3", name: "按摩油", emoji: "🧴", price: 50 },
  { id: "adult-default-4", name: "眼罩", emoji: "👁️", price: 25 },
];

function getAdultItems() {
  const items = loadJSON(LS.worldAdultItems, null);
  if (items === null) {
    saveJSON(LS.worldAdultItems, DEFAULT_ADULT_ITEMS);
    return DEFAULT_ADULT_ITEMS;
  }
  return items;
}

function addAdultItem(item) {
  const items = getAdultItems();
  items.push({ id: uid(), name: item.name, emoji: item.emoji || "🔞", price: item.price, addedAt: Date.now() });
  saveJSON(LS.worldAdultItems, items);
}

function removeAdultItem(itemId) {
  const items = getAdultItems();
  saveJSON(LS.worldAdultItems, items.filter(i => i.id !== itemId));
}

function findAdultItem(itemName) {
  const items = getAdultItems();
  let found = items.find(i => i.name === itemName);
  if (!found) found = items.find(i => i.name.includes(itemName) || itemName.includes(i.name));
  return found;
}

// ===== 衣装货架 / 衣帽间 =====
const CLOSET_SLOT_LABELS = {
  hair: "发型", top: "上衣", bottom: "下装", dress: "连衣裙", set: "套装", socks: "袜子", shoes: "鞋子",
  accessory: "首饰", hat: "帽子", bag: "包"
};

function getBundledWardrobeCatalog() {
  const catalog = window.LEITH_WARDROBE_CATALOG;
  return catalog && typeof catalog === "object" ? catalog : { version: 0, base: null, items: [] };
}

function mergeBundledClosetItems(items) {
  const catalog = getBundledWardrobeCatalog();
  const catalogVersion = String(catalog.version || 0);
  const syncedVersion = localStorage.getItem(LS.closetCatalogVersion);
  if (syncedVersion === catalogVersion) return items;
  const ownedIds = new Set(loadJSON(LS.closetOwnedItems, []).map(item => item.id));
  const existingIds = new Set(items.map(item => item.id));
  const merged = [...items];
  (catalog.items || []).forEach(item => {
    if (!item?.id || existingIds.has(item.id) || ownedIds.has(item.id)) return;
    merged.push(item);
    existingIds.add(item.id);
  });
  localStorage.setItem(LS.closetCatalogVersion, catalogVersion);
  return merged;
}

function pruneOwnedFromShop(items) {
  const ownedIds = new Set(getClosetOwnedItems().map(item => item.id));
  return (items || []).filter(item => item?.id && !ownedIds.has(item.id));
}

function migrateLegacyClosetItemsForRaster() {
  const baseId = getBundledWardrobeCatalog().base?.id;
  // v2 会再次清理旧版 SVG 商品。v1 只运行一次；如果当时云同步随后又把
  // 旧衣服恢复回来，纸娃娃仍会整套回退成 SVG。
  const migrationId = baseId ? `${baseId}:v2` : "";
  if (!baseId || localStorage.getItem(LS.closetRasterMigration) === migrationId) return;
  const shop = loadJSON(LS.closetShopItems, null);
  if (Array.isArray(shop)) saveJSON(LS.closetShopItems, shop.filter(item => item.asset));
  const owned = loadJSON(LS.closetOwnedItems, []).filter(item => item.asset);
  saveJSON(LS.closetOwnedItems, owned);
  const validOwnedIds = new Set(owned.map(item => item.ownedId));
  const outfit = loadJSON(LS.closetOutfit, {});
  Object.keys(outfit).forEach(slot => {
    if (!validOwnedIds.has(outfit[slot])) delete outfit[slot];
  });
  saveJSON(LS.closetOutfit, outfit);
  localStorage.setItem(LS.closetRasterMigration, migrationId);
}
const DEFAULT_CLOSET_ITEMS = [
  { id: "closet-default-1", name: "雾蓝针织开衫", emoji: "🧶", price: 36, slot: "top", visual: "cardigan", color: "#9fb3bd", accent: "#eef2f0", style: "通勤、温柔、下雨天", note: "想看你穿得软一点" },
  { id: "closet-default-2", name: "奶油白男友衬衫", emoji: "👔", price: 42, slot: "top", visual: "boyfriend-shirt", color: "#f4eadc", accent: "#d6bfa5", style: "男友衬衫、居家、清晨", note: "像偷穿了我的衬衫" },
  { id: "closet-default-3", name: "灰粉短卫衣", emoji: "🧥", price: 39, slot: "top", visual: "hoodie", color: "#caa7aa", accent: "#eee2df", style: "休闲、撒娇、周末", note: "很适合懒懒地窝着" },
  { id: "closet-default-4", name: "黑色百褶短裙", emoji: "🖤", price: 45, slot: "bottom", visual: "pleated-skirt", color: "#2f2d31", accent: "#59545c", style: "短裙、学院、显腿长", note: "有一点乖，也有一点坏" },
  { id: "closet-default-5", name: "浅卡其短裤", emoji: "🩳", price: 32, slot: "bottom", visual: "shorts", color: "#c7ad8e", accent: "#8f765a", style: "短裤、出门、轻快", note: "像要背包出门晒太阳" },
  { id: "closet-default-6", name: "月白吊带长裙", emoji: "🤍", price: 68, slot: "dress", visual: "slip-dress", color: "#f4ead8", accent: "#d8bfa3", style: "长裙、温柔、约会", note: "很安静，但我会多看两眼" },
  { id: "closet-default-7", name: "酒红丝绒短裙", emoji: "🍷", price: 62, slot: "dress", visual: "mini-dress", color: "#8e3f4a", accent: "#e8c3bd", style: "短裙、晚霞、亲密", note: "像傍晚的秘密" },
  { id: "closet-default-8", name: "雾灰玛丽珍鞋", emoji: "👞", price: 38, slot: "shoes", visual: "mary-jane", color: "#8b8584", accent: "#dad1ca", style: "鞋子、日常、乖巧", note: "走路会很轻" },
  { id: "closet-default-9", name: "黑色乐福鞋", emoji: "🥿", price: 40, slot: "shoes", visual: "loafers", color: "#343033", accent: "#6f686b", style: "通勤、书包、利落", note: "配圆框眼镜很好看" },
  { id: "closet-default-10", name: "珍珠细项链", emoji: "📿", price: 28, slot: "accessory", visual: "pearl-necklace", color: "#f6efe3", accent: "#d6bfa5", style: "首饰、细节、温柔", note: "小小一圈亮光" },
  { id: "closet-default-11", name: "贝雷帽", emoji: "🧢", price: 34, slot: "hat", visual: "beret", color: "#6f6870", accent: "#a99da3", style: "帽子、秋天、文艺", note: "像会突然去看展" },
  { id: "closet-default-12", name: "通勤帆布包", emoji: "👜", price: 48, slot: "bag", visual: "tote", color: "#d7c1a2", accent: "#8f765a", style: "包、通勤、书本", note: "可以装下今天的小情绪" }
];

function inferClosetVisual(item) {
  const text = `${item.name || ""} ${item.style || ""}`;
  if (item.slot === "hat") return "beret";
  if (item.slot === "bag") return "tote";
  if (item.slot === "accessory") return "pearl-necklace";
  if (item.slot === "shoes") return text.includes("乐福") ? "loafers" : "mary-jane";
  if (item.slot === "dress") return text.includes("短") || text.includes("酒红") ? "mini-dress" : "slip-dress";
  if (item.slot === "bottom") return text.includes("裤") ? "shorts" : "pleated-skirt";
  if (text.includes("衬衫")) return "boyfriend-shirt";
  if (text.includes("卫衣")) return "hoodie";
  return "cardigan";
}

function normalizeClosetItem(item) {
  const fromDefault = DEFAULT_CLOSET_ITEMS.find(d => d.id === item.id || d.name === item.name) || {};
  return {
    ...fromDefault,
    ...item,
    visual: item.visual || fromDefault.visual || inferClosetVisual(item),
    color: item.color || fromDefault.color || "#c8b7ad",
    accent: item.accent || fromDefault.accent || "#f4eadc"
  };
}

function normalizeClosetList(items) {
  return (items || []).map(normalizeClosetItem);
}

function getClosetShopItems() {
  migrateLegacyClosetItemsForRaster();
  const items = loadJSON(LS.closetShopItems, null);
  if (items === null) {
    const defaults = getBundledWardrobeCatalog().base ? [] : DEFAULT_CLOSET_ITEMS;
    const initial = pruneOwnedFromShop(mergeBundledClosetItems(defaults));
    saveJSON(LS.closetShopItems, initial);
    return initial;
  }
  const normalized = normalizeClosetList(pruneOwnedFromShop(mergeBundledClosetItems(items)));
  if (JSON.stringify(normalized) !== JSON.stringify(items)) saveJSON(LS.closetShopItems, normalized);
  return normalized;
}

function setClosetShopItems(items) {
  saveJSON(LS.closetShopItems, items);
}

function getClosetOwnedItems() {
  const items = normalizeClosetList(loadJSON(LS.closetOwnedItems, []));
  return items;
}

function setClosetOwnedItems(items) {
  saveJSON(LS.closetOwnedItems, items);
}

function getClosetOutfit() {
  return loadJSON(LS.closetOutfit, {});
}

function setClosetOutfit(outfit) {
  saveJSON(LS.closetOutfit, outfit);
}

function addClosetItem(item) {
  const items = getClosetShopItems();
  items.push({
    id: uid(), name: item.name, emoji: item.emoji || "👗", price: item.price,
    slot: item.slot || "top", color: item.color || "#c8b7ad",
    accent: item.accent || "#f4eadc", visual: item.visual || inferClosetVisual(item),
    style: item.style || "", note: item.note || "", addedAt: Date.now()
  });
  setClosetShopItems(items);
}

function findClosetShopItem(itemName) {
  const items = getClosetShopItems();
  let found = items.find(i => i.name === itemName);
  if (!found) found = items.find(i => i.name.includes(itemName) || itemName.includes(i.name));
  return found;
}

function findOwnedClosetItem(itemName) {
  const items = getClosetOwnedItems();
  let found = items.find(i => i.name === itemName);
  if (!found) found = items.find(i => i.name.includes(itemName) || itemName.includes(i.name));
  return found;
}

function buyClosetItem(itemId, boughtBy = "user", threadId = getActiveThreadId()) {
  const shop = getClosetShopItems();
  const item = shop.find(i => i.id === itemId);
  if (!item) return null;
  setClosetShopItems(shop.filter(i => i.id !== itemId));
  const owned = getClosetOwnedItems();
  const ownedItem = { ...item, ownedId: uid(), boughtBy, boughtAt: Date.now(), threadId };
  owned.push(ownedItem);
  setClosetOwnedItems(owned);
  return ownedItem;
}

function damageClosetItem(ownedId) {
  const owned = getClosetOwnedItems();
  const item = owned.find(i => i.ownedId === ownedId);
  if (!item) return false;
  setClosetOwnedItems(owned.filter(i => i.ownedId !== ownedId));
  const outfit = getClosetOutfit();
  Object.keys(outfit).forEach(slot => { if (outfit[slot] === ownedId) delete outfit[slot]; });
  setClosetOutfit(outfit);
  const { ownedId: _ownedId, boughtAt: _boughtAt, boughtBy: _boughtBy, threadId: _threadId, ...shopItem } = item;
  setClosetShopItems([...getClosetShopItems(), { ...shopItem, returnedAt: Date.now() }]);
  return true;
}

function equipClosetItem(ownedId) {
  const item = getClosetOwnedItems().find(i => i.ownedId === ownedId);
  if (!item) return false;
  const outfit = getClosetOutfit();
  if (item.slot === "dress" || item.slot === "set") {
    delete outfit.top;
    delete outfit.bottom;
    delete outfit.dress;
    delete outfit.set;
  } else if (item.slot === "top" || item.slot === "bottom") {
    delete outfit.dress;
    delete outfit.set;
  }
  outfit[item.slot] = ownedId;
  setClosetOutfit(outfit);
  return true;
}

function unequipClosetSlot(slot) {
  const outfit = getClosetOutfit();
  delete outfit[slot];
  setClosetOutfit(outfit);
}

function getEquippedClosetItems() {
  const owned = getClosetOwnedItems();
  const outfit = getClosetOutfit();
  return Object.entries(outfit)
    .map(([slot, ownedId]) => ({ slot, item: owned.find(i => i.ownedId === ownedId) }))
    .filter(x => x.item);
}

function buildClosetPromptLine() {
  const owned = getClosetOwnedItems();
  const shop = getClosetShopItems();
  const equipped = getEquippedClosetItems().map(x => x.item.name);
  const ownedNames = owned.slice(-12).map(i => `${i.name}/${CLOSET_SLOT_LABELS[i.slot] || i.slot}`);
  const shopNames = shop.slice(0, 12).map(i => `${i.name}¥${i.price}`);
  if (!ownedNames.length && !shopNames.length) return "";
  return `Wardrobe worn: ${equipped.length ? equipped.join("、") : "none"}; owned: ${ownedNames.join("、") || "none"}; clothing shelf: ${shopNames.join("、") || "none"}`;
}

function renderClosetDescription(item) {
  const description = escapeHtml(item.description || item.note || "");
  if (!description) return "";
  return `<details class="closet-desc"><summary>简介</summary><div>${description}</div></details>`;
}

// ===== 双人情绪状态（1—7）=====
const MOOD_FIELDS = [
  ["joy", "伤心—开心"],
  ["desire", "要出家—想🔞"],
  ["anger", "怒气值"],
  ["grievance", "委屈值"]
];
const MOOD_EXTREME_VALUES = {
  joy: [1, 2, 7],
  desire: [6, 7],
  anger: [6, 7],
  grievance: [6, 7]
};
function defaultMoodPerson() { return { joy: 4, desire: 4, anger: 1, grievance: 1 }; }
function clampMood(value) { return Math.max(1, Math.min(7, Math.round(Number(value) || 4))); }
function getMoodState() {
  const saved = loadJSON(LS.moodState, {});
  return {
    leith: { ...defaultMoodPerson(), ...(saved.leith || {}) },
    susie: { ...defaultMoodPerson(), ...(saved.susie || {}) },
    susieHidden: Boolean(saved.susieHidden),
    extremeLog: Array.isArray(saved.extremeLog)
      ? saved.extremeLog.filter(row => MOOD_EXTREME_VALUES[row.key]?.includes(clampMood(row.value))).slice(-120)
      : []
  };
}
function saveMoodState(state, changedPerson = "", previous = null) {
  if (changedPerson && previous) {
    const nowPerson = state[changedPerson];
    MOOD_FIELDS.forEach(([key, label]) => {
      const value = clampMood(nowPerson[key]);
      if (value === clampMood(previous[key]) || !MOOD_EXTREME_VALUES[key].includes(value)) return;
      state.extremeLog.push({
        id: uid(), at: Date.now(), person: changedPerson, key, label, value
      });
    });
    state.extremeLog = state.extremeLog.slice(-120);
  }
  saveJSON(LS.moodState, state);
  renderMoodBoard();
}
function buildMoodPromptBlock() {
  const state = getMoodState();
  const l = MOOD_FIELDS.map(([key]) => clampMood(state.leith[key])).join(",");
  const s = state.susieHidden ? "hidden" : MOOD_FIELDS.map(([key]) => clampMood(state.susie[key])).join(",");
  return `[Mood board, values are 1-7, order j,d,a,g. j=Leith sadness-to-happiness: 1 very sad, 4 calm, 7 very happy. d=Leith sexual desire: 1 abstinent/withdrawn, 4 neutral intimacy, 7 strongly sexual. a=Leith anger: 1 not angry, 4 irritated, 7 very angry. g=Leith grievance/hurt: 1 not hurt, 4 quietly wronged, 7 deeply wronged. Current Leith L=${l}; Susie S=${s}. Before every reply, seriously and cautiously decide whether Leith's own real emotional state should change from the conversation. If it changes, append exactly [MOOD:j,d,a,g] at the end; otherwise omit it. Never change Susie's S. Do not mention the tag.`;
}
function getMoodExtremesForDate(dateStr) {
  const { start, end } = getDiaryRangeMs(dateStr);
  const rows = getMoodState().extremeLog.filter(row => row.at >= start && row.at < end);
  if (!rows.length) return "";
  return rows.map(row => {
    const who = row.person === "leith" ? "Leith" : "Susie";
    const diaryLabel = row.key === "desire" ? "亲密倾向" : row.label;
    return `- ${who} 的${diaryLabel}达到 ${row.value}/7`;
  }).join("\n");
}
function renderMoodBoard() {
  const state = getMoodState();
  const board = $("#moodBoard");
  if (!board) return;
  const summary = $("#moodBoardSummary");
  if (summary) summary.textContent = `Leith ${state.leith.joy} · Susie ${state.susieHidden ? "隐藏" : state.susie.joy}　${board.classList.contains("collapsed") ? "⌄" : "⌃"}`;
  const susiePanel = $("#susieMoodPanel");
  susiePanel?.classList.toggle("is-hidden", state.susieHidden);
  const hideBtn = $("#susieMoodHideBtn");
  if (hideBtn) hideBtn.textContent = state.susieHidden ? "恢复可见" : "对 Leith 隐藏";
  document.querySelectorAll("[data-mood-person]").forEach(container => {
    const person = container.dataset.moodPerson;
    const disabled = person === "leith";
    container.innerHTML = MOOD_FIELDS.map(([key, label]) => `
      <label class="mood-row"><span>${label}</span>
        <input type="range" min="1" max="7" value="${clampMood(state[person][key])}" data-mood-input="${person}:${key}" ${disabled ? "disabled" : ""}>
        <span class="mood-value">${clampMood(state[person][key])}</span>
      </label>`).join("");
  });
  document.querySelectorAll("[data-mood-input^='susie:']").forEach(input => {
    input.oninput = () => {
      const [, key] = input.dataset.moodInput.split(":");
      const next = getMoodState();
      const previous = { ...next.susie };
      next.susie[key] = clampMood(input.value);
      saveMoodState(next, "susie", previous);
    };
  });
}
function initMoodBoard() {
  const board = $("#moodBoard");
  $("#moodBoardToggle")?.addEventListener("click", () => {
    board.classList.toggle("collapsed");
    renderMoodBoard();
  });
  $("#susieMoodHideBtn")?.addEventListener("click", event => {
    event.stopPropagation();
    const state = getMoodState();
    state.susieHidden = !state.susieHidden;
    saveMoodState(state);
  });
  renderMoodBoard();
}

// ===== 折角日期（轻量纪念日，不做完整日历）=====
function getFoldedDates() {
  return loadJSON(LS.foldedDates, []);
}

function setFoldedDates(items) {
  saveJSON(LS.foldedDates, items);
}

function addFoldedDate(date, name, note) {
  const items = getFoldedDates();
  items.push({ id: uid(), date, name, note: note || "", remindDays: 3, addedAt: Date.now() });
  setFoldedDates(items.sort((a, b) => a.date.localeCompare(b.date)));
}

function removeFoldedDate(id) {
  setFoldedDates(getFoldedDates().filter(item => item.id !== id));
}

function daysUntilDate(dateStr) {
  const today = new Date(formatLocalDate() + "T00:00:00").getTime();
  const target = new Date(dateStr + "T00:00:00").getTime();
  return Math.round((target - today) / 86400000);
}

function buildFoldedDatesPromptLine() {
  const upcoming = getFoldedDates()
    .map(item => ({ ...item, days: daysUntilDate(item.date) }))
    .filter(item => item.days >= 0 && item.days <= (item.remindDays ?? 3))
    .slice(0, 4);
  if (!upcoming.length) return "";
  return `Folded dates nearby: ${upcoming.map(item => `${item.name} ${item.days === 0 ? "today" : `in ${item.days} day(s)`}${item.note ? ` (${item.note})` : ""}`).join("; ")}. Mention naturally only if it feels warm, not as a calendar alert.`;
}

// ===== 床头柜（每个对话独立）=====
// 现在货架/成人用品区的每一次购买，不管是不是消耗品，都会摆进床头柜；
// 结构：{ [threadId]: [{ id, recordId, lsKey, itemId, name, emoji, price, consumable, expiresInDays, boughtBy, boughtAt }] }
function getNightstand(threadId) {
  const ns = loadJSON(LS.worldNightstand, {});
  return ns[threadId] || [];
}

function addNightstandItem(threadId, item, recordId, lsKey) {
  const ns = loadJSON(LS.worldNightstand, {});
  if (!ns[threadId]) ns[threadId] = [];
  ns[threadId].push({
    id: uid(), recordId, lsKey, itemId: item.id,
    name: item.name, emoji: item.emoji, price: item.price,
    consumable: item.consumable || null, expiresInDays: item.expiresInDays || null,
    boughtBy: item.boughtBy, boughtAt: Date.now()
  });
  saveJSON(LS.worldNightstand, ns);
}

// 把床头柜里指定的一件挪走（用掉了 / 损坏了 / 过期自动清理，都走这个）
function removeNightstandItem(threadId, nightstandItemId) {
  const ns = loadJSON(LS.worldNightstand, {});
  if (!ns[threadId]) return;
  ns[threadId] = ns[threadId].filter(i => i.id !== nightstandItemId);
  saveJSON(LS.worldNightstand, ns);
}

// 每次打开商店页面时，顺手把床头柜里"已经用掉/已经过期"的消耗品清出去，
// 这样床头柜看起来才是"当下真实拥有的东西"，而不是一直堆着空壳
function cleanupNightstand(threadId) {
  const ns = loadJSON(LS.worldNightstand, {});
  const list = ns[threadId] || [];
  if (!list.length) return;

  const shelfItems = getShelfItems();
  const adultItems = getAdultItems();
  const shelfRecords = getPurchaseRecords(threadId, LS.worldShelfBought);
  const adultRecords = getPurchaseRecords(threadId, LS.worldAdultBought);

  const stillValid = list.filter(ni => {
    if (!ni.consumable) return true; // 非消耗品只靠"损坏"按钮手动清出，这里不自动动它
    const records = ni.lsKey === LS.worldAdultBought ? adultRecords : shelfRecords;
    const items = ni.lsKey === LS.worldAdultBought ? adultItems : shelfItems;
    const item = items.find(i => i.id === ni.itemId);
    const record = records.find(r => r.id === ni.recordId);
    if (!item || !record) return false;
    return isPurchaseActive(record, item);
  });

  if (stillValid.length !== list.length) {
    ns[threadId] = stillValid;
    saveJSON(LS.worldNightstand, ns);
  }
}

// 每日定额逻辑
function getAllowanceConfig() {
  return loadJSON(LS.worldAllowance, { enabled: false, amount: 50 });
}

function setAllowanceConfig(cfg) {
  saveJSON(LS.worldAllowance, cfg);
}

// 检查并发放今日定额（每个对话每天只发一次）
function maybeGiveDailyAllowance() {
  const cfg = getAllowanceConfig();
  if (!cfg.enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  const log = loadJSON(LS.worldAllowanceLog, {});
  if (!log[today]) log[today] = [];

  const threads = getThreads();
  threads.forEach(t => {
    if (!log[today].includes(t.id)) {
      addWallet(t.id, cfg.amount);
      log[today].push(t.id);
    }
  });
  saveJSON(LS.worldAllowanceLog, log);
}

// ============================================================
// 小世界：UI 渲染
// ============================================================

// 普通货架 / 成人用品区 通用渲染逻辑（两者机制一样：花 Leith 零花钱买，你买免费）
// 消耗品：可以随时重复购买，每次购买都是独立一份，摆进床头柜各自计时/消耗
// 非消耗品：买过一次就一直"已拥有"，不能重复买，床头柜里可以标记"损坏"来清出
function renderPurchasableSection({ gridId, items, lsKey, threadId, emptyEmoji, emptyText, removeFn, notifyFn }) {
  const grid = $("#" + gridId);
  if (!grid) return;

  if (!items.length) {
    grid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">${emptyEmoji}</div><p>${emptyText}</p></div>`;
    return;
  }

  grid.innerHTML = items.map(item => {
    const consumeBadge = item.consumable === "once" ? `<span class="consume-badge">一次性</span>`
      : item.consumable === "timed" ? `<span class="consume-badge">${item.expiresInDays || 1}天</span>` : "";

    // 现在所有商品——不管是不是消耗品——都可以无限重复购买，每次都是独立一份，
    // 摆进床头柜各自计时/消耗；货架条目只有主动"下架"才会消失，不会因为买过而消失或锁定
    const ownedCount = getNightstand(threadId).filter(ni => ni.itemId === item.id && ni.lsKey === lsKey).length;
    return `
      <div class="inventory-item">
        <div class="item-emoji">${item.emoji || "🛍️"}</div>
        <div>${escapeHtml(item.name)}${consumeBadge}</div>
        <div class="item-name">¥${item.price}${ownedCount ? ` · 床头柜有${ownedCount}份` : ""}</div>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <button class="btn btn-primary btn-sm" style="font-size:10px;padding:3px 8px;" data-buy-item="${item.id}">购买</button>
          <button class="btn btn-danger btn-sm" style="font-size:10px;padding:3px 8px;" data-del-item="${item.id}">下架</button>
        </div>
      </div>`;
  }).join("");

  grid.querySelectorAll("[data-buy-item]").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = items.find(i => i.id === btn.dataset.buyItem);
      if (!item) return;
      const record = addPurchaseRecord(threadId, lsKey, item.id, "user");
      addNightstandItem(threadId, { ...item, boughtBy: "user" }, record.id, lsKey);
      showToast(`已购买 ${item.emoji} ${item.name}`);
      if (notifyFn) notifyFn(item.name);
      renderShopPage();
    });
  });
  grid.querySelectorAll("[data-del-item]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (confirm("确定下架这个商品？")) {
        removeFn(btn.dataset.delItem);
        renderShopPage();
        showToast("已下架");
      }
    });
  });
}

function renderShopPage() {
  maybeGiveDailyAllowance();

  const threadId = getActiveThreadId();
  cleanupNightstand(threadId); // 先清掉已用完/已过期的消耗品，床头柜才是"当下真实拥有的东西"
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const giftRecords = getGiftRecords(threadId);
  const limitedItems = getLimitedItems();
  const nightstand = getNightstand(threadId);
  const allowanceCfg = getAllowanceConfig();
  const closetItems = getClosetShopItems();

  // 钱包（Leith零花钱）
  $("#walletAmount").innerText = `¥${balance}`;
  $("#toggleAllowanceBtn").innerText = allowanceCfg.enabled ? `每日 ¥${allowanceCfg.amount}` : "每日定额";

  // 限定商品基金
  $("#savingsAmount").innerText = `¥${savings}`;

  // 限定商品区（全局）
  const limitedGrid = $("#limitedGrid");
  if (!limitedItems.length) {
    limitedGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">🏷️</div><p>还没有上架限定商品</p></div>`;
  } else {
    limitedGrid.innerHTML = limitedItems.map(item => `
      <div class="inventory-item">
        <div class="item-emoji">${item.emoji || "🏷️"}</div>
        <div>${escapeHtml(item.name)}</div>
        <div class="item-name">¥${item.price}</div>
        <button class="btn btn-danger btn-sm" style="margin-top:4px;font-size:10px;padding:3px 8px;" data-limited-del="${item.id}">下架</button>
      </div>
    `).join("");
    limitedGrid.querySelectorAll("[data-limited-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        removeLimitedItem(btn.dataset.limitedDel);
        renderShopPage();
        showToast("已下架");
      });
    });
  }

  // 普通货架 + 成人用品区：机制一样（花 Leith 零花钱，你买免费），统一渲染
  renderPurchasableSection({
    gridId: "shelfGrid", items: getShelfItems(), lsKey: LS.worldShelfBought,
    threadId, emptyEmoji: "🛍️", emptyText: "货架空空的",
    removeFn: removeShelfItem, notifyFn: null
  });
  renderClosetShopSection(closetItems);
  renderPurchasableSection({
    gridId: "adultGrid", items: getAdultItems(), lsKey: LS.worldAdultBought,
    threadId, emptyEmoji: "🔞", emptyText: "还没有商品",
    removeFn: removeAdultItem, notifyFn: notifyLeithAdultPurchase
  });

  // Leith 赠送区
  const giftGrid = $("#giftRecordsGrid");
  if (!giftRecords.length) {
    giftGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">💌</div><p>还没有收到 Leith 的礼物呢</p></div>`;
  } else {
    giftGrid.innerHTML = giftRecords.map(g => `
      <div class="inventory-item">
        <div class="item-emoji">${g.emoji || "🎁"}</div>
        <div>${escapeHtml(g.name)}</div>
        <div class="item-name">¥${g.price}</div>
      </div>
    `).join("");
  }

  // 床头柜——现在消耗品和非消耗品都会摆在这里；
  // 消耗品显示剩余时间/一份还是好几份，可以点"用掉了"；非消耗品可以点"损坏"清出去
  const nsGrid = $("#nightstandGrid");
  if (!nightstand.length) {
    nsGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">🛏️</div><p>还没有东西</p></div>`;
  } else {
    nsGrid.innerHTML = nightstand.map(item => {
      const byLabel = item.boughtBy === "leith" ? "Leith买的" : "你买的";
      if (item.consumable === "timed") {
        const remainingMs = (item.expiresInDays || 1) * 86400000 - (Date.now() - item.boughtAt);
        const remainingText = remainingMs > 0 ? `还剩${Math.max(1, Math.ceil(remainingMs / 3600000))}小时` : "已经过期";
        return `
          <div class="inventory-item">
            <div class="item-emoji">${item.emoji || "📦"}</div>
            <div>${escapeHtml(item.name)}</div>
            <div class="item-name">${byLabel} · ${remainingText}</div>
            <button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:10px;padding:3px 8px;" data-ns-use="${item.id}">用掉了</button>
          </div>`;
      }
      if (item.consumable === "once") {
        return `
          <div class="inventory-item">
            <div class="item-emoji">${item.emoji || "📦"}</div>
            <div>${escapeHtml(item.name)}</div>
            <div class="item-name">${byLabel}</div>
            <button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:10px;padding:3px 8px;" data-ns-use="${item.id}">用掉了</button>
          </div>`;
      }
      // 非消耗品：没有"用掉"这回事，只有"损坏"清出床头柜
      return `
        <div class="inventory-item">
          <div class="item-emoji">${item.emoji || "📦"}</div>
          <div>${escapeHtml(item.name)}</div>
          <div class="item-name">${byLabel}</div>
          <button class="btn btn-danger btn-sm" style="margin-top:4px;font-size:10px;padding:3px 8px;" data-ns-damage="${item.id}">损坏</button>
        </div>`;
    }).join("");

    nsGrid.querySelectorAll("[data-ns-use]").forEach(btn => {
      btn.addEventListener("click", () => {
        const ni = nightstand.find(i => i.id === btn.dataset.nsUse);
        if (!ni) return;
        markPurchaseRecordUsed(threadId, ni.lsKey, ni.recordId);
        removeNightstandItem(threadId, ni.id);
        insertNarration(threadId, `${ni.emoji} ${ni.name} 用掉了`);
        showToast("已标记为用掉了");
        renderShopPage();
      });
    });
    nsGrid.querySelectorAll("[data-ns-damage]").forEach(btn => {
      btn.addEventListener("click", () => {
        const ni = nightstand.find(i => i.id === btn.dataset.nsDamage);
        if (!ni) return;
        if (!confirm(`确定「${ni.name}」损坏了吗？会从床头柜清出去。`)) return;
        markPurchaseDamaged(threadId, ni.lsKey, ni.recordId);
        removeNightstandItem(threadId, ni.id);
        insertNarration(threadId, `${ni.emoji} ${ni.name} 损坏了`);
        showToast("已清出床头柜");
        renderShopPage();
      });
    });
  }
}

function renderClosetShopSection(items) {
  const grid = $("#closetShopGrid");
  if (!grid) return;
  if (!items.length) {
    grid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">👗</div><p>衣装都已经进衣帽间了</p></div>`;
    return;
  }
  grid.innerHTML = items.map(item => `
    <div class="inventory-item">
      <div class="closet-item-preview">${renderClosetVisual(item, "preview")}</div>
      <div>${escapeHtml(item.name)}</div>
      <div class="item-name">${CLOSET_SLOT_LABELS[item.slot] || item.slot} · ¥${item.price}</div>
      <div class="item-name">${escapeHtml(item.style || "")}</div>
      ${renderClosetDescription(item)}
      <div style="display:flex;gap:4px;margin-top:4px;">
        <button class="btn btn-primary btn-sm" style="font-size:10px;padding:3px 8px;" data-closet-buy="${item.id}">购买</button>
        <button class="btn btn-danger btn-sm" style="font-size:10px;padding:3px 8px;" data-closet-del="${item.id}">下架</button>
      </div>
    </div>
  `).join("");
  grid.querySelectorAll("[data-closet-buy]").forEach(btn => {
    btn.onclick = () => {
      const item = buyClosetItem(btn.dataset.closetBuy, "user");
      if (!item) return;
      showToast(`已放进衣帽间：${item.emoji} ${item.name}`);
      renderShopPage();
      if ($("#closetOwnedGrid")) renderClosetPage();
    };
  });
  grid.querySelectorAll("[data-closet-del]").forEach(btn => {
    btn.onclick = () => {
      if (!confirm("确定下架这件衣装？")) return;
      setClosetShopItems(getClosetShopItems().filter(i => i.id !== btn.dataset.closetDel));
      renderShopPage();
      showToast("已下架");
    };
  });
}

// 你买成人用品后，在对话框生成旁白并自动发给 Leith
function notifyLeithAdultPurchase(itemName) {
  const threadId = getActiveThreadId();
  switchPage("page-chat");

  // 生成真正的旁白消息：必须带 _isNarration，否则会被当普通用户消息，
  // 触发长对话 token 提醒、编辑按钮、以及一系列滚动/渲染错位。
  const narration = `（Susie 买了一件${itemName}，放到了床头柜上。）`;
  insertNarration(threadId, narration);
  // 同步到云端短期记忆
  if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
    window.Memory.saveShortTerm(threadId, "user", narration);
  }

  // 自动触发 Leith 回复
  const box = $("#chatBox");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  row.appendChild(bubble);
  box.appendChild(row);
  forceChatToBottom();

  // 调用 sendChat 的核心逻辑（不读 userInput，直接用旁白作为最后消息）
  setTimeout(() => autoRespondToNarration(threadId, bubble, row), 600);
}

// 自动回复旁白（复用 sendChat 的 API 逻辑）
async function autoRespondToNarration(threadId, bubble, row) {
  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");

  if (!apiKey || !provider || !model) {
    row.remove();
    return;
  }

  const sendBtn = $("#sendBtn");
  const controller = new AbortController();
  currentController = controller;
  let lastChunkTime = Date.now();
  let hasReceivedContent = false;
  const timeoutTimer = setInterval(() => {
    if (Date.now() - lastChunkTime > 60000) { controller.abort(); clearInterval(timeoutTimer); }
  }, 1000);

  const originalSendHTML = sendBtn.innerHTML;
  const originalSendBg = sendBtn.style.background;
  const originalSendBorder = sendBtn.style.border;
  const originalSendColor = sendBtn.style.color;
  const originalSendHandler = sendBtn.onclick;
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`;
  sendBtn.style.background = "var(--bg-elevated)";
  sendBtn.style.border = "1px solid var(--accent-dim)";
  sendBtn.style.color = "var(--paper)";
  sendBtn.onclick = () => controller.abort();

  try {
    const systemPrompt = await buildEffectiveSystemPrompt();
    const messages = truncateMessagesForApi(getThreadMessages(threadId).filter(m => m.type !== "sticker"));
    let fullReply = "";
    if (provider.apiStyle === "anthropic") {
      fullReply = await streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta: (acc) => {
        lastChunkTime = Date.now(); hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        $("#chatBox").scrollTop = $("#chatBox").scrollHeight;
      }});
    } else {
      fullReply = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta: (acc) => {
        lastChunkTime = Date.now(); hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        $("#chatBox").scrollTop = $("#chatBox").scrollHeight;
      }});
    }
    clearInterval(timeoutTimer);
    const freshMessages = getThreadMessages(threadId);
    const finalMsgId = uid();
    freshMessages.push({ role: "assistant", content: fullReply, _id: finalMsgId, _ts: Date.now() });
    saveThreadMessages(threadId, freshMessages);
    attachPinButtonToBubble(bubble, finalMsgId, false);
    forceChatToBottom();
    // 同步到云端短期记忆
    if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
      window.Memory.saveShortTerm(threadId, "assistant", fullReply);
    }
    renderThreadList();
    const actions = parseAIActions(fullReply);
    if (actions.length) handleAIActions(actions);
  } catch (err) {
    clearInterval(timeoutTimer);
    if (err.name === "AbortError") {
      if (hasReceivedContent) {
        const partial = bubble.innerText;
        if (partial.trim()) {
          const freshMessages = getThreadMessages(threadId);
          const partialMsgId = uid();
          freshMessages.push({ role: "assistant", content: partial, _id: partialMsgId, _ts: Date.now() });
          saveThreadMessages(threadId, freshMessages);
          attachPinButtonToBubble(bubble, partialMsgId, false);
          forceChatToBottom();
          if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
            window.Memory.saveShortTerm(threadId, "assistant", partial);
          }
          showToast("已停止，已保存");
        } else { row.remove(); }
      } else { row.remove(); }
    } else {
      row.remove();
      showModal("请求失败", err.message || "网络错误");
    }
  } finally {
    currentController = null;
    sendBtn.innerHTML = originalSendHTML;
    sendBtn.style.background = originalSendBg;
    sendBtn.style.border = originalSendBorder;
    sendBtn.style.color = originalSendColor;
    sendBtn.onclick = originalSendHandler;
  }
}


// 给零花钱按钮
function initGiveMoneyBtn() {
  $("#giveMoneyBtn").addEventListener("click", () => {
    const amountStr = prompt("给 Leith 多少零花钱？（数字）", "50");
    if (amountStr === null) return;
    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) return showToast("请输入有效金额");
    const threadId = getActiveThreadId();
    addWallet(threadId, amount);
    renderShopPage();
    showToast(`已给 Leith ¥${amount}，零钱包现有 ¥${getWallet(threadId)}`);
  });
}

// 每日定额开关
function initToggleAllowanceBtn() {
  $("#toggleAllowanceBtn").addEventListener("click", () => {
    const cfg = getAllowanceConfig();
    if (!cfg.enabled) {
      const amountStr = prompt("每天自动发多少零花钱？（数字）", String(cfg.amount || 50));
      if (amountStr === null) return;
      const amount = parseInt(amountStr, 10);
      if (isNaN(amount) || amount <= 0) return showToast("请输入有效金额");
      cfg.enabled = true;
      cfg.amount = amount;
      setAllowanceConfig(cfg);
    } else {
      cfg.enabled = false;
      setAllowanceConfig(cfg);
    }
    renderShopPage();
    showToast(cfg.enabled ? `已开启每日定额 ¥${cfg.amount}` : "已关闭每日定额");
  });
}

// 限定商品基金按钮
function initAddSavingsBtn() {
  $("#addSavingsBtn").addEventListener("click", () => {
    const amountStr = prompt("存多少到限定商品基金？（数字）\n这笔钱专门给 Leith 送你限定商品用", "100");
    if (amountStr === null) return;
    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) return showToast("请输入有效金额");
    const threadId = getActiveThreadId();
    addSavings(threadId, amount);
    renderShopPage();
    showToast(`限定商品基金 +¥${amount}`);
  });
}

// 限定商品上架按钮
// ============================================================
// 添加商品弹窗（限定商品区 / 普通货架 / 成人用品区 通用）
// ============================================================
let addItemTargetType = ""; // 'limited' | 'shelf' | 'adult'

function openAddItemModal(type) {
  addItemTargetType = type;
  const titles = { limited: "🏷️ 上架限定商品", shelf: "🛍️ 上架货架商品", adult: "🔞 添加成人用品" };
  $("#addItemModalTitle").innerText = titles[type] || "添加商品";
  $("#addItemEmojiInput").value = "";
  $("#addItemNameInput").value = "";
  $("#addItemPriceInput").value = "";
  $("#addItemExpiryInput").value = "1";
  $("#addItemExpiryRow").classList.add("hidden");
  $("#addItemModalOverlay").querySelectorAll(".consume-type-btn").forEach(b => b.classList.remove("active"));
  $("#addItemModalOverlay").querySelector('[data-consume-type=""]').classList.add("active");
  // 限定商品区本身不支持消耗品设定（逻辑上"被送走就没了"，已经是一次性的了），隐藏这个选项
  const consumeRow = $("#addItemModalOverlay").querySelector(".consume-type-row").parentElement;
  const showConsumeOption = type !== "limited";
  Array.from($("#addItemModalOverlay").querySelectorAll("label")).find(l => l.innerText === "是否消耗品").style.display = showConsumeOption ? "" : "none";
  $("#addItemModalOverlay").querySelector(".consume-type-row").style.display = showConsumeOption ? "" : "none";

  $("#addItemModalOverlay").classList.remove("hidden");
  pushNavLayer(closeAddItemModal);
  setTimeout(() => $("#addItemNameInput").focus(), 100);
}
function closeAddItemModal() {
  $("#addItemModalOverlay").classList.add("hidden");
}
function closeAddItemModalFromUI() { popNavLayerSilently(); closeAddItemModal(); }

function initAddItemModal() {
  $("#addItemModalOverlay").querySelectorAll(".consume-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $("#addItemModalOverlay").querySelectorAll(".consume-type-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      $("#addItemExpiryRow").classList.toggle("hidden", btn.dataset.consumeType !== "timed");
    });
  });

  $("#addItemCancelBtn").addEventListener("click", closeAddItemModalFromUI);
  $("#addItemModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "addItemModalOverlay") closeAddItemModalFromUI();
  });

  $("#addItemConfirmBtn").addEventListener("click", () => {
    const name = $("#addItemNameInput").value.trim();
    const emoji = $("#addItemEmojiInput").value.trim();
    const price = parseInt($("#addItemPriceInput").value, 10);
    if (!name) return showToast("填一下商品名称吧");
    if (isNaN(price) || price <= 0) return showToast("填一个有效的价格");

    const activeConsumeBtn = $("#addItemModalOverlay").querySelector(".consume-type-btn.active");
    const consumable = activeConsumeBtn ? (activeConsumeBtn.dataset.consumeType || null) : null;
    const expiresInDays = consumable === "timed" ? (parseInt($("#addItemExpiryInput").value, 10) || 1) : null;

    const item = { name, emoji: emoji || defaultEmojiForType(addItemTargetType), price, consumable, expiresInDays };

    if (addItemTargetType === "limited") {
      addLimitedItem(item);
    } else if (addItemTargetType === "shelf") {
      addShelfItem(item);
    } else if (addItemTargetType === "adult") {
      addAdultItem(item);
    }
    renderShopPage();
    closeAddItemModalFromUI();
    showToast(`已添加：${item.emoji} ${name}`);
  });
}

function defaultEmojiForType(type) {
  return type === "limited" ? "🏷️" : type === "adult" ? "🔞" : "🛍️";
}

function initAddLimitedBtn() {
  $("#addLimitedBtn").addEventListener("click", () => openAddItemModal("limited"));
}
function initAddShelfBtn() {
  $("#addShelfBtn").addEventListener("click", () => openAddItemModal("shelf"));
}
function initAddAdultBtn() {
  $("#addAdultBtn").addEventListener("click", () => openAddItemModal("adult"));
}

function initAddClosetBtn() {
  const btn = $("#addClosetBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const name = prompt("衣装名字？比如：雾蓝针织开衫");
    if (!name) return;
    const slot = prompt("部位：top上衣 / bottom下装（半身裙或裤子） / dress连衣裙 / socks袜子 / shoes鞋子 / hat帽子", "top");
    if (!slot) return;
    const price = parseInt(prompt("价格？", "36"), 10);
    if (isNaN(price) || price <= 0) return showToast("价格要填数字");
    const color = prompt("主色 HEX，比如 #9fb3bd", "#c8b7ad") || "#c8b7ad";
    const style = prompt("风格标签，比如：通勤、温柔、下雨天", "") || "";
    const note = prompt("Leith 的备注（可空）", "") || "";
    const visual = prompt("版型（可空，会自动猜）：cardigan / boyfriend-shirt / hoodie / pleated-skirt / shorts / slip-dress / mini-dress / mary-jane / loafers / pearl-necklace / beret / tote", "") || "";
    addClosetItem({ name: name.trim(), price, slot: slot.trim(), color: color.trim(), style: style.trim(), note: note.trim(), visual: visual.trim() });
    renderShopPage();
    showToast("衣装已上架");
  });
}

function initShopFolds() {
  const shop = $("#page-app-shop");
  if (!shop) return;
  shop.querySelectorAll(".inventory-section").forEach((section, index) => {
    const h3 = section.querySelector("h3");
    if (!h3 || h3.dataset.foldBound === "1") return;
    h3.dataset.foldBound = "1";
    if (index > 1) section.classList.add("collapsed");
    h3.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      section.classList.toggle("collapsed");
    });
  });
}



// ============================================================
// 判断运行环境
// ============================================================
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// ============================================================
// 对话线程管理
// ============================================================
function getThreads() {
  return loadJSON(LS.threads, []);
}
function saveThreads(threads) { saveJSON(LS.threads, threads); }

function getActiveThreadId() {
  return localStorage.getItem(LS.activeThreadId);
}
function setActiveThreadId(id) {
  localStorage.setItem(LS.activeThreadId, id);
  scheduleCloudStateSync(LS.activeThreadId, id);
}

function getThreadMessages(threadId) {
  return loadJSON(LS.threadMsgPrefix + threadId, []);
}
function saveThreadMessages(threadId, messages) {
  saveJSON(LS.threadMsgPrefix + threadId, messages);
}

function upsertThread(thread) {
  const threads = getThreads();
  const idx = threads.findIndex(t => t.id === thread.id);
  if (idx >= 0) {
    threads[idx] = { ...threads[idx], ...thread };
  } else {
    threads.unshift(thread);
  }
  saveThreads(threads);
}

function ensureAtLeastOneThread() {
  let threads = getThreads();
  if (!threads.length) {
    const t = { id: uid(), name: "新的对话", createdAt: Date.now() };
    threads = [t];
    saveThreads(threads);
    setActiveThreadId(t.id);
  }
  if (!getActiveThreadId()) {
    setActiveThreadId(threads[0].id);
  }
}

// 注：旧版的"物理裁剪本地存储"方案已废弃——现在改用 truncateMessagesForApi()，
// 只在发送给 AI 前临时截取，不删除本地记录，界面仍能往上翻到完整历史。

// 单对话模式：不再有多对话管理
// renderThreadList 保留为空函数，避免已有调用报错
function renderThreadList() {}

function loadActiveThreadIntoChat() {
  exitSelectMode();
  const box = $("#chatBox");
  box.innerHTML = "";
  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.id = "emptyState";
    empty.innerHTML = `<div class="mark">"　"</div><p>还没有对话记录。<br>先在右上角设置里，把服务商和密钥填好，就可以开始说话了。</p>`;
    box.appendChild(empty);
  } else {
    messages.forEach(msg => renderMessage(msg, { noScroll: true }));
    // 用 double-rAF 确保浏览器完成布局和图片解码后再滚动到底部。
    // 另外：CSS 里 .chat-scroll 设置了 scroll-behavior:smooth，如果直接用这个平滑滚动
    // 来定位"刚打开页面、历史消息还在陆续渲染"这种场景，会出问题——平滑滚动是"滚向发起那一刻
    // 读到的目标值"，如果滚动过程中 scrollHeight 因为图片继续加载而变大，动画会停在旧的、
    // 错误的位置（甚至可能停在很靠前的地方），而不是真正的底部。这里临时关掉平滑滚动，
    // 做一次瞬间跳转，跳完再恢复，这样初始定位才是准确、稳定的。
    forceChatToBottom();

    // 双重 rAF 只能保证"布局计算完成"，不能保证贴纸/图片这类需要走网络请求+解码的
    // 异步资源真的加载完了——如果消息里有贴纸，图片加载完成的时机可能落在 rAF 之后，
    // 那时候 scrollHeight 又会变化。这里等所有图片都 load 完（或加载失败）后，
    // 只要用户当时还停留在底部附近，就再校正一次，确保最终真的停在最后一条消息
    const imgs = box.querySelectorAll("img");
    if (imgs.length) {
      let pending = imgs.length;
      const onImgSettled = () => {
        pending--;
        if (pending === 0) {
          const distFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
          if (distFromBottom < 300) forceChatToBottom(); // 用户没有主动往上翻走，才校正
        }
      };
      imgs.forEach(img => {
        if (img.complete) { onImgSettled(); }
        else {
          img.addEventListener("load", onImgSettled, { once: true });
          img.addEventListener("error", onImgSettled, { once: true });
        }
      });
    }
  }
  renderTokenBanner();
}

// 单对话模式：线程面板已移除

// ============================================================
// 服务商管理
// ============================================================
let providers = loadJSON(LS.providers, DEFAULT_PROVIDERS);
let activeProviderId = localStorage.getItem(LS.activeProviderId) || (providers[0] && providers[0].id);
const CUSTOM_MODEL_OPTION = "__leith_custom_model__";

function getActiveProvider() {
  return providers.find(p => p.id === activeProviderId) || providers[0];
}

function getSelectedChatModel() {
  const select = $("#modelSelect");
  if (!select) return "";
  if (select.value === CUSTOM_MODEL_OPTION) {
    return ($("#customModelInput")?.value || "").trim();
  }
  return select.value || "";
}

function updateEffectiveModelHint() {
  const select = $("#modelSelect");
  const customInput = $("#customModelInput");
  const hint = $("#effectiveModelHint");
  if (!select || !customInput) return;
  const usingCustom = select.value === CUSTOM_MODEL_OPTION;
  customInput.classList.toggle("hidden", !usingCustom);
  const model = getSelectedChatModel();
  const provider = getActiveProvider();
  if (hint) {
    hint.innerText = model
      ? `当前真正调用：${provider?.name || "未选择服务商"} / ${model}`
      : "请填写要实际调用的自定义模型名称";
    hint.style.color = model ? "var(--paper-dim)" : "#b85f65";
  }
}

function renderProviderList() {
  const list = $("#providerList");
  list.innerHTML = "";
  providers.forEach(p => {
    const card = document.createElement("div");
    card.className = "provider-card" + (p.id === activeProviderId ? " active" : "");
    card.innerHTML = `
      <div class="provider-card-head">
        <div>
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-url">${escapeHtml(p.baseUrl)}</div>
        </div>
        <div class="provider-actions">
          <button class="edit-provider" title="编辑">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="delete-provider" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          </button>
        </div>
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".edit-provider") || e.target.closest(".delete-provider")) return;
      activeProviderId = p.id;
      localStorage.setItem(LS.activeProviderId, activeProviderId);
      renderProviderList();
      populateModelSelect();
      updateStatusLabel();
    });
    card.querySelector(".edit-provider").addEventListener("click", (e) => {
      e.stopPropagation();
      openProviderEditor(p);
    });
    card.querySelector(".delete-provider").addEventListener("click", (e) => {
      e.stopPropagation();
      if (providers.length <= 1) {
        showModal("无法删除", "至少需要保留一个服务商。");
        return;
      }
      if (confirm(`确认删除服务商[${p.name}]？`)) {
        providers = providers.filter(x => x.id !== p.id);
        saveJSON(LS.providers, providers);
        if (activeProviderId === p.id) {
          activeProviderId = providers[0].id;
          localStorage.setItem(LS.activeProviderId, activeProviderId);
        }
        renderProviderList();
        populateModelSelect();
        updateStatusLabel();
      }
    });
    list.appendChild(card);
  });
}

function openProviderEditor(existing) {
  const isNew = !existing;
  const name = prompt("服务商名称：", existing ? existing.name : "");
  if (name === null) return;
  const baseUrl = prompt("Base URL（例如 https://api.example.com/v1）：", existing ? existing.baseUrl : "");
  if (baseUrl === null) return;
  const modelsStr = prompt("默认模型列表，用英文逗号分隔：", existing ? existing.models.join(",") : "");
  if (modelsStr === null) return;
  const apiStyle = confirm("这个服务商是 Anthropic 官方接口风格吗？\n[确定]= Anthropic 官方 /messages 结构\n[取消]= OpenAI 兼容 /chat/completions 结构") ? "anthropic" : "openai";

  const models = modelsStr.split(",").map(s => s.trim()).filter(Boolean);

  if (isNew) {
    const p = { id: uid(), name: name.trim() || "未命名服务商", baseUrl: baseUrl.trim(), models, apiStyle };
    providers.push(p);
    activeProviderId = p.id;
    localStorage.setItem(LS.activeProviderId, activeProviderId);
  } else {
    existing.name = name.trim() || existing.name;
    existing.baseUrl = baseUrl.trim();
    existing.models = models;
    existing.apiStyle = apiStyle;
  }
  saveJSON(LS.providers, providers);
  renderProviderList();
  populateModelSelect();
  updateStatusLabel();
  showToast("已保存");
}

$("#addProviderBtn").onclick = () => openProviderEditor(null);

function populateModelSelect() {
  const sel = $("#modelSelect");
  sel.innerHTML = "";
  const active = getActiveProvider();
  if (!active) return;
  active.models.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.innerText = m;
    sel.appendChild(opt);
  });
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL_OPTION;
  customOpt.innerText = "手动输入其他模型…";
  sel.appendChild(customOpt);
  const savedModel = localStorage.getItem(LS.model);
  const savedCustomModel = localStorage.getItem(LS.customModel);
  if (savedCustomModel) sel.value = CUSTOM_MODEL_OPTION;
  else if (savedModel && active.models.includes(savedModel)) sel.value = savedModel;
  else if (active.models.length) sel.value = active.models[0];
  else sel.value = CUSTOM_MODEL_OPTION;
  updateEffectiveModelHint();
}

function updateStatusLabel() {
  const active = getActiveProvider();
  const key = localStorage.getItem(LS.apiKey);
  const text = active ? (key ? `已连接 · ${active.name}` : `未连接 · ${active.name}`) : "未配置服务商";
  const label = $("#statusLabel");
  // 只替换文字节点，保留里面的健康检测圆点 <span id="healthDot">。
  // 用一个专门的 <span> 装文字，而不是依赖裸文本节点（原始 HTML 里圆点前后有多个空白文本节点，
  // 找"第一个文本节点"很容易找错、导致文字重复），这样每次更新都精确、不会有残留。
  let textSpan = $("#statusLabelText");
  if (!textSpan) {
    // 第一次运行：清掉旧的裸文本节点，只保留圆点，再补一个专门装文字的 span
    Array.from(label.childNodes).forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) label.removeChild(n);
    });
    textSpan = document.createElement("span");
    textSpan.id = "statusLabelText";
    label.appendChild(textSpan);
  }
  textSpan.textContent = text;
}

// ============================================================
// 设置抽屉开关
// ============================================================
function openDrawer() {
  $("#settingsDrawer").classList.add("open");
  $("#drawerOverlay").classList.add("open");
  pushNavLayer(closeDrawer);
}
function closeDrawer() {
  $("#settingsDrawer").classList.remove("open");
  $("#drawerOverlay").classList.remove("open");
}
function closeDrawerFromUI() { popNavLayerSilently(); closeDrawer(); }
$("#openSettingsBtn").onclick = openDrawer;
$("#closeDrawerBtn").onclick = closeDrawerFromUI;
$("#drawerOverlay").onclick = closeDrawerFromUI;

// ============================================================
// 配置加载 / 保存
// ============================================================
function initConfig() {
  const savedKey = localStorage.getItem(LS.apiKey);
  const savedTemp = localStorage.getItem(LS.temp);
  const savedSystemPrompt = localStorage.getItem(LS.systemPrompt);
  const savedCustomModel = localStorage.getItem(LS.customModel);
  const savedDiaryModel = localStorage.getItem(LS.diaryModel);

  if (savedKey) $("#apiKey").value = savedKey;
  if (savedTemp) { $("#tempInput").value = savedTemp; $("#tempVal").innerText = savedTemp; }
  if (savedSystemPrompt !== null) $("#systemPromptInput").value = savedSystemPrompt;
  if (savedCustomModel) $("#customModelInput").value = savedCustomModel;
  if (savedDiaryModel) $("#diaryModelInput").value = savedDiaryModel;

  renderProviderList();
  populateModelSelect();
  updateStatusLabel();

  // 加载搜索代理配置
  const savedProxy = localStorage.getItem(SEARCH_PROXY_LS);
  if (savedProxy && $("#searchProxyInput")) $("#searchProxyInput").value = savedProxy;

  ensureAtLeastOneThread();
  loadActiveThreadIntoChat();
}

$("#tempInput").addEventListener("input", (e) => { $("#tempVal").innerText = e.target.value; });
$("#modelSelect").addEventListener("change", () => {
  // 下拉框选了具体模型后，旧的手动输入值不再拥有“隐形覆盖权”。
  if ($("#modelSelect").value !== CUSTOM_MODEL_OPTION) {
    $("#customModelInput").value = "";
    localStorage.removeItem(LS.customModel);
  }
  updateEffectiveModelHint();
});
$("#customModelInput").addEventListener("input", updateEffectiveModelHint);

$("#saveConfigBtn").onclick = () => {
  const key = $("#apiKey").value.trim();
  if (!key) return showModal("提示", "API Key 不能为空。");
  const selectedModel = getSelectedChatModel();
  if (!selectedModel) return showModal("提示", "请先选择模型，或填写自定义模型名称。");
  localStorage.setItem(LS.apiKey, key);
  if ($("#modelSelect").value === CUSTOM_MODEL_OPTION) {
    localStorage.setItem(LS.customModel, selectedModel);
  } else {
    localStorage.setItem(LS.model, selectedModel);
    localStorage.removeItem(LS.customModel);
  }
  localStorage.setItem(LS.diaryModel, $("#diaryModelInput").value.trim());
  localStorage.setItem(LS.temp, $("#tempInput").value);
  localStorage.setItem(LS.systemPrompt, $("#systemPromptInput").value);
  updateStatusLabel();
  updateEffectiveModelHint();
  showToast(`配置已保存 · 实际调用 ${selectedModel}`);
  lastHealthState = null; // 换了配置，之前的健康状态不再有参考意义
  consecutiveHealthFails = 0;
  runHealthCheck({ silent: true });
};

$("#clearKeyBtn").onclick = () => {
  localStorage.removeItem(LS.apiKey);
  $("#apiKey").value = "";
  updateStatusLabel();
  setHealthDot(null);
  lastHealthState = null;
  showToast("密钥已清空，对话记录保留");
};

// 搜索代理配置：失焦时保存
if ($("#searchProxyInput")) {
  $("#searchProxyInput").addEventListener("blur", () => {
    const v = $("#searchProxyInput").value.trim();
    if (v) localStorage.setItem(SEARCH_PROXY_LS, v);
    else localStorage.removeItem(SEARCH_PROXY_LS);
    showToast("搜索代理已保存");
  });
}

$("#clearAllBtn").onclick = () => {
  if (confirm("这会清空对话记录、密钥、服务商配置、记忆、表情包等全部本地数据，且无法恢复。确认继续？")) {
    localStorage.clear();
    location.reload();
  }
};

// ============================================================
// 核心记忆 UI
// ============================================================
async function renderMemoryList() {
  const list = $("#memoryList");
  if (!list || !window.Memory) return;
  const items = await window.Memory.list();
  list.innerHTML = "";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "helper-text";
    p.innerText = "还没有存入任何记忆。";
    list.appendChild(p);
    return;
  }
  items.slice().reverse().forEach(m => {
    const card = document.createElement("div");
    card.className = "memory-card";
    card.innerHTML = `
      <div class="memory-card-head">
        <span class="memory-tag">核心记忆</span>
        <button class="memory-del" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>
      <div class="memory-content">${escapeHtml(m.content)}</div>
    `;
    card.querySelector(".memory-del").addEventListener("click", async () => {
      await window.Memory.remove(m.id);
      renderMemoryList();
    });
    list.appendChild(card);
  });
}

$("#addMemoryBtn").onclick = async () => {
  const val = $("#newMemoryInput").value.trim();
  if (!val) return;
  await window.Memory.add(val);
  $("#newMemoryInput").value = "";
  renderMemoryList();
  showToast("已存入记忆");
};

// ============================================================
// 表情包：管理（设置里）+ 发送（聊天面板）
// ============================================================
async function renderStickerManageGrid() {
  const grid = $("#stickerManageGrid");
  if (!grid || !window.Stickers) return;
  const items = await window.Stickers.list();
  grid.innerHTML = "";
  items.forEach(s => {
    const cell = document.createElement("div");
    cell.className = "sticker-manage-item";
    cell.innerHTML = `
      <img src="${s.dataUrl}" alt="${escapeHtml(s.label)}">
      <input type="text" value="${escapeHtml(s.label)}" placeholder="标签，如：开心">
      <button class="btn btn-danger btn-sm">删除</button>
    `;
    const labelInput = cell.querySelector("input");
    labelInput.addEventListener("change", async () => {
      await window.Stickers.updateLabel(s.id, labelInput.value.trim());
      showToast("标签已更新");
    });
    cell.querySelector("button").addEventListener("click", async () => {
      await window.Stickers.remove(s.id);
      renderStickerManageGrid();
      renderStickerPickerGrid();
    });
    grid.appendChild(cell);
  });
}

$("#stickerUploadInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showModal("图片太大", "请上传 2MB 以内的图片，本地存储空间有限。");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    await window.Stickers.add({ label: "", dataUrl: reader.result });
    renderStickerManageGrid();
    renderStickerPickerGrid();
    showToast("表情包已添加，去设置里给它加个标签吧");
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

async function renderStickerPickerGrid() {
  const grid = $("#stickerGrid");
  if (!grid || !window.Stickers) return;
  const items = await window.Stickers.list();
  grid.innerHTML = "";
  if (!items.length) {
    grid.innerHTML = `<div class="sticker-empty">还没有表情包。<br>去右上角设置 → 表情包里上传吧。</div>`;
    return;
  }
  items.forEach(s => {
    const cell = document.createElement("div");
    cell.className = "sticker-item";
    cell.innerHTML = `<img src="${s.dataUrl}" alt="${escapeHtml(s.label)}">`;
    cell.addEventListener("click", () => sendSticker(s));
    grid.appendChild(cell);
  });
}

function openStickerPanel() { renderStickerPickerGrid(); $("#stickerPanel").classList.add("open"); pushNavLayer(closeStickerPanel); }
function closeStickerPanel() { $("#stickerPanel").classList.remove("open"); }
function closeStickerPanelFromUI() { popNavLayerSilently(); closeStickerPanel(); }
$("#openStickerPanelBtn").onclick = openStickerPanel;
$("#closeStickerPanelBtn").onclick = closeStickerPanelFromUI;

function sendSticker(sticker) {
  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  const msg = { role: "user", type: "sticker", content: sticker.label || "[表情包]", dataUrl: sticker.dataUrl, _id: uid() };
  messages.push(msg);
  renderMessage(msg);
  saveThreadMessages(threadId, messages);
  closeStickerPanelFromUI();
  renderThreadList();
  renderTokenBanner();
}

// ============================================================
// 消息渲染
// ============================================================
let selectMode = false;
let selectedMessageIds = new Set();
let currentController = null;

function renderMessage(msg, opts = {}) {
  const emptyState = $("#emptyState");
  if (emptyState) emptyState.remove();
  const box = $("#chatBox");
  const row = document.createElement("div");

  // 旁白消息：居中半透明，不参与选取，没有编辑/重新生成按钮
  if (msg._isNarration) {
    row.className = "msg-row narration";
    row.dataset.msgId = msg._id;
    const bubble = document.createElement("div");
    bubble.className = "bubble narration";
    bubble.innerText = msg.content;
    row.appendChild(bubble);
    box.appendChild(row);
    if (!opts.noScroll) box.scrollTop = box.scrollHeight;
    return bubble;
  }

  row.className = `msg-row ${msg.role === "user" ? "user" : "assistant"}`;
  if (!msg._id) msg._id = uid();
  row.dataset.msgId = msg._id;

  const bubble = document.createElement("div");

  if (msg.type === "sticker") {
    bubble.className = "bubble sticker";
    bubble.innerHTML = `<img src="${msg.dataUrl}" alt="${escapeHtml(msg.content || "")}">`;
  } else {
    bubble.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
    if (msg.role === "assistant") {
      bubble.innerHTML = renderBubbleContent(msg.content);
    } else {
      bubble.innerHTML = renderBubbleAttachments(msg.attachments) + escapeHtml(msg.content || "").replace(/\n/g, "<br>");
    }
  }

  row.appendChild(bubble);

  // 标记为重要记忆：只对 Leith 的回复生效，常驻显示在气泡右下角（平时淡淡的，标记后变亮），
  // 不需要先点开气泡的操作栏才能看到——情绪上头的时候更容易第一时间点掉它
  if (msg.role === "assistant" && msg.type !== "sticker") {
    attachPinButtonToBubble(bubble, msg._id, msg.pinned);
  }

  // 操作栏：编辑（用户消息）/ 重新生成（AI消息）/ 删除（全部），统一放进一个工具条
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  if (msg.role === "user" && msg.type !== "sticker") {
    const editBtn = document.createElement("button");
    editBtn.className = "msg-action-btn";
    editBtn.title = "编辑";
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    editBtn.onclick = (e) => { e.stopPropagation(); startEditMessage(row, msg); };
    actions.appendChild(editBtn);
  }

  if (msg.role === "assistant") {
    const regenBtn = document.createElement("button");
    regenBtn.className = "msg-action-btn";
    regenBtn.title = "重新生成";
    regenBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`;
    regenBtn.onclick = (e) => { e.stopPropagation(); regenerateMessage(msg._id); };
    actions.appendChild(regenBtn);
  }

  const delBtn = document.createElement("button");
  delBtn.className = "msg-delete-btn";
  delBtn.title = "删除";
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>`;
  delBtn.onclick = (e) => { e.stopPropagation(); deleteMessage(msg._id, row); };
  actions.appendChild(delBtn);

  row.appendChild(actions);

  if (selectMode) {
    applySelectableUI(row, msg._id);
  }

  row.addEventListener("click", (e) => {
    if (!selectMode) {
      const wasTapped = row.classList.contains("tapped");
      document.querySelectorAll(".msg-row.tapped").forEach(r => r.classList.remove("tapped"));
      if (!wasTapped) row.classList.add("tapped");
      return;
    }
    e.stopPropagation();
    toggleMessageSelect(row, msg._id);
  });

  box.appendChild(row);
  if (!opts.noScroll) box.scrollTop = box.scrollHeight;
  return bubble;
}

function applySelectableUI(row, msgId) {
  row.classList.add("selectable");
  const bubble = row.querySelector(".bubble");
  if (bubble) bubble.style.pointerEvents = "none";
  // 选取模式下隐藏编辑/重新生成/删除工具条，避免遮挡 checkbox
  const actionsBar = row.querySelector(".msg-actions");
  if (actionsBar) actionsBar.style.display = "none";
  if (!row.querySelector(".msg-checkbox")) {
    const cb = document.createElement("div");
    cb.className = "msg-checkbox" + (selectedMessageIds.has(msgId) ? " checked" : "");
    // checkbox 本身也能点，避免误触
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMessageSelect(row, msgId);
    });
    row.insertBefore(cb, row.firstChild);
  }
}

const CLOUD_RESTORE_NOTICE_SESSION_KEY = "leith_cloud_restore_notice_seen_v1";

function showCloudConnectedNotice(message) {
  if (sessionStorage.getItem(CLOUD_RESTORE_NOTICE_SESSION_KEY) === "1") return;
  sessionStorage.setItem(CLOUD_RESTORE_NOTICE_SESSION_KEY, "1");
  showModal("☁️ Leith 已接上云端记忆", message || "云端记忆已经连接。之后我会继续把新的对话同步到云端。", "知道啦");
}

async function restoreCloudConversationIfNeeded() {
  if (!window.Memory || !window.Memory.isReady || !window.Memory.isReady()) return false;
  if (!window.Memory.findLatestShortTermThreadId || !window.Memory.loadShortTerm) {
    showCloudConnectedNotice("云端长期记忆已经连接。");
    return false;
  }

  const activeThreadId = getActiveThreadId();
  const localMessages = activeThreadId ? getThreadMessages(activeThreadId) : [];
  if (localMessages.length) {
    showCloudConnectedNotice("云端记忆已经连接，本地这段对话也会继续同步。");
    return false;
  }

  const cloudThreadId = await window.Memory.findLatestShortTermThreadId();
  if (!cloudThreadId) {
    showCloudConnectedNotice("云端记忆已经连接。暂时没有找到可恢复的云端对话，我会从这里继续陪你。");
    return false;
  }

  const cloudMessages = await window.Memory.loadShortTerm(cloudThreadId, 100);
  if (!cloudMessages.length) {
    showCloudConnectedNotice("云端记忆已经连接。暂时没有找到可恢复的云端对话，我会从这里继续陪你。");
    return false;
  }

  const restored = cloudMessages
    .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({
      role: m.role,
      content: m.content,
      _id: m.id ? `cloud_${m.id}` : uid(),
      _ts: m.createdAt || Date.now(),
      _restoredFromCloud: true
    }));
  if (!restored.length) return false;

  upsertThread({
    id: cloudThreadId,
    name: "云端接续的对话",
    createdAt: restored[0]._ts || Date.now()
  });
  setActiveThreadId(cloudThreadId);
  saveThreadMessages(cloudThreadId, restored);
  loadActiveThreadIntoChat();
  showCloudConnectedNotice(`我从云端接回了最近 ${restored.length} 条对话。可能不是全部历史，但足够让我顺着最近的线继续回来。`);
  return true;
}

function toggleMessageSelect(row, msgId) {
  const cb = row.querySelector(".msg-checkbox");
  if (selectedMessageIds.has(msgId)) {
    selectedMessageIds.delete(msgId);
    cb.classList.remove("checked");
  } else {
    selectedMessageIds.add(msgId);
    cb.classList.add("checked");
  }
  $("#selectCount").innerText = `已选 ${selectedMessageIds.size} 条`;
}

function enterSelectMode() {
  selectMode = true;
  selectedMessageIds.clear();
  $("#selectToolbar").classList.remove("hidden");
  $("#selectCount").innerText = "已选 0 条";
  document.querySelectorAll(".msg-row").forEach(row => {
    // 旁白消息不参与选取
    if (row.classList.contains("narration")) return;
    applySelectableUI(row, row.dataset.msgId);
  });
}

function exitSelectMode() {
  selectMode = false;
  selectedMessageIds.clear();
  $("#selectToolbar").classList.add("hidden");
  document.querySelectorAll(".msg-checkbox").forEach(cb => cb.remove());
  document.querySelectorAll(".msg-row.selectable").forEach(row => {
    row.classList.remove("selectable");
    const bubble = row.querySelector(".bubble");
    if (bubble) bubble.style.pointerEvents = "";
    // 恢复编辑/重新生成/删除工具条
    const actionsBar = row.querySelector(".msg-actions");
    if (actionsBar) actionsBar.style.display = "";
  });
}

// ============================================================
// 删除单条消息（本地 + 云端同步）
// ============================================================
// 给一个气泡 DOM 元素挂上"标记为重要记忆"的星标按钮——抽成公共函数是因为
// Leith 的流式回复有好几处是手动创建气泡+逐字更新内容的（不经过 renderMessage），
// 之前星标只在 renderMessage 里创建，导致刚回复完的那条消息看不到星标，要刷新页面
// （重新走一遍 renderMessage）才会出现。现在流式回复真正结束、拿到消息 id 后，
// 也调用这个函数补上星标，不用等刷新。
function attachPinButtonToBubble(bubble, msgId, pinned) {
  if (!bubble || bubble.querySelector(".msg-pin-btn")) return; // 避免重复添加
  const pinBtn = document.createElement("button");
  pinBtn.className = "msg-pin-btn" + (pinned ? " pinned" : "");
  pinBtn.title = pinned ? "已标记为重要记忆" : "标记为重要记忆";
  pinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="${pinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6"><path d="M12 2l2.9 6.26L21 9.27l-4.5 4.39L17.8 20 12 16.9 6.2 20l1.3-6.34L3 9.27l6.1-1.01L12 2z"/></svg>`;
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    togglePinMessage(msgId, pinBtn);
  };
  bubble.appendChild(pinBtn);
}

// 标记/取消标记某条 Leith 回复为"重要记忆"——只改本地存储的这条消息，
// 不额外调用任何 API、不花 token。当天写日记时会读取所有被标记的消息，
// 作为重点素材让日记多着墨、写得更详细一点。
function togglePinMessage(msgId, btnEl) {
  const threadId = getActiveThreadId();
  const msgs = getThreadMessages(threadId);
  const msg = msgs.find(m => m._id === msgId);
  if (!msg) return;
  msg.pinned = !msg.pinned;
  saveThreadMessages(threadId, msgs);

  if (btnEl) {
    btnEl.classList.toggle("pinned", msg.pinned);
    btnEl.title = msg.pinned ? "已标记为重要记忆" : "标记为重要记忆";
    btnEl.querySelector("svg").setAttribute("fill", msg.pinned ? "currentColor" : "none");
  }
  showToast(msg.pinned ? "已标记为重要记忆，写日记时会重点保留" : "已取消标记");
}

async function deleteMessage(msgId, rowEl) {
  const threadId = getActiveThreadId();
  let messages = getThreadMessages(threadId);
  const msg = messages.find(m => m._id === msgId);
  if (!msg) return;

  // 从本地删除
  messages = messages.filter(m => m._id !== msgId);
  saveThreadMessages(threadId, messages);

  // 从 DOM 删除
  if (rowEl) rowEl.remove();

  // 从云端短期记忆删除（按 content 匹配）
  if (window.Memory && window.Memory.isReady && window.Memory.isReady() && msg.content) {
    try {
      const client = window.getSupabaseClient ? window.getSupabaseClient() : null;
      if (client) {
        const { data: rows } = await client
          .from('memories')
          .select('id')
          .eq('type', 'short_term')
          .eq('thread_id', threadId || 'global')
          .eq('content', msg.content)
          .order('created_at', { ascending: true })
          .limit(1);
        if (rows && rows.length) {
          await client.from('memories').delete().eq('id', rows[0].id);
        }
      }
    } catch (e) {
      console.error('删除云端记忆失败:', e);
    }
  }

  showToast("已删除");
  renderTokenBanner();
}

// ============================================================
// 编辑消息 / 截停 / 重新生成
// ============================================================

function startEditMessage(row, msg) {
  if (currentController) return showToast("请先等当前回复结束");
  const bubble = row.querySelector(".bubble");
  const originalText = msg.content;

  bubble.innerHTML = "";
  const textarea = document.createElement("textarea");
  textarea.value = originalText;
  textarea.rows = 1;
  textarea.style.cssText = "width:100%;min-height:60px;background:var(--bg-input);border:1px solid var(--accent-dim);color:var(--paper);border-radius:12px;padding:10px 12px;font-size:15px;font-family:inherit;line-height:1.5;resize:none;outline:none;";
  bubble.appendChild(textarea);
  textarea.focus();
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  });

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;margin-top:8px;";
  btnRow.innerHTML = `
    <button class="btn btn-primary btn-sm" id="confirmEditBtn">保存并重新发送</button>
    <button class="btn btn-ghost btn-sm" id="cancelEditBtn">取消</button>
  `;
  bubble.appendChild(btnRow);

  row.querySelector(".msg-actions").style.display = "none";

  btnRow.querySelector("#cancelEditBtn").onclick = () => {
    bubble.innerText = originalText;
    row.querySelector(".msg-actions").style.display = "";
  };

  btnRow.querySelector("#confirmEditBtn").onclick = () => {
    const newText = textarea.value.trim();
    if (!newText || newText === originalText) {
      bubble.innerText = originalText;
      row.querySelector(".msg-actions").style.display = "";
      return;
    }
    const threadId = getActiveThreadId();
    let messages = getThreadMessages(threadId);
    const idx = messages.findIndex(m => m._id === msg._id);
    if (idx === -1) return;
    messages = messages.slice(0, idx);
    saveThreadMessages(threadId, messages);

    // 清空输入框，避免和直接传入的文本重复
    userInput.value = "";
    userInput.style.height = "auto";
    // 重新渲染聊天框（显示裁剪后的历史）
    loadActiveThreadIntoChat();
    // 直接把编辑后的文本传给 sendChat，不再依赖输入框中间状态
    sendChat(newText);
  };
}

async function regenerateMessage(assistantMsgId) {
  if (currentController) return showToast("请先等当前回复结束");

  const threadId = getActiveThreadId();
  let messages = getThreadMessages(threadId);
  const idx = messages.findIndex(m => m._id === assistantMsgId);
  if (idx === -1) return;

  const userMsg = messages[idx - 1];
  if (!userMsg || userMsg.role !== "user") return showToast("找不到对应的用户消息");

  messages = messages.slice(0, idx);
  saveThreadMessages(threadId, messages);

  loadActiveThreadIntoChat();
  await regenerateFromMessage(userMsg);
}

async function regenerateFromMessage(userMsg) {
  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");

  if (!apiKey) return showModal("提示", "请先在设置里填写并保存 API Key。");
  if (!provider) return showModal("提示", "请先在设置里添加一个服务商。");
  if (!model) return showModal("提示", "请先选择或填写一个模型名称。");

  const threadId = getActiveThreadId();
  const sendBtn = $("#sendBtn");

  const box = $("#chatBox");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  row.appendChild(bubble);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  const controller = new AbortController();
  currentController = controller;
  let lastChunkTime = Date.now();
  let hasReceivedContent = false;
  const timeoutTimer = setInterval(() => {
    if (Date.now() - lastChunkTime > 60000) {
      controller.abort();
      clearInterval(timeoutTimer);
    }
  }, 1000);

  // 统一用 setSendingUI 管理停止按钮
  setSendingUI(sendBtn, () => controller.abort());

  try {
    const systemPrompt = await buildEffectiveSystemPrompt();
    let messages = truncateMessagesForApi(getThreadMessages(threadId).filter(m => m.type !== "sticker")).map(m => {
      if (m.attachments && m.attachments.length) {
        return { role: m.role, content: buildContentBlocksForApi(m.content, m.attachments, provider.apiStyle) };
      }
      return m;
    });
    const tools = webEnabled ? (provider.apiStyle === "anthropic" ? getAnthropicTools() : [WEB_SEARCH_TOOL]) : null;

    let fullReply = "";
    let searchNotice = null;
    const MAX_TOOL_ROUNDS = 3;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let result;
      if (provider.apiStyle === "anthropic") {
        result = await streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta: (acc) => {
          lastChunkTime = Date.now();
          hasReceivedContent = true;
          if (searchNotice) { searchNotice.remove(); searchNotice = null; }
          bubble.innerHTML = renderBubbleContent(acc);
          box.scrollTop = box.scrollHeight;
        }, tools });
      } else {
        result = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta: (acc) => {
          lastChunkTime = Date.now();
          hasReceivedContent = true;
          if (searchNotice) { searchNotice.remove(); searchNotice = null; }
          bubble.innerHTML = renderBubbleContent(acc);
          box.scrollTop = box.scrollHeight;
        }, tools });
      }

      fullReply = result.text;
      if (!result.toolCalls || !result.toolCalls.length) break;

      const tc = result.toolCalls[0];
      let query = "";
      try { query = JSON.parse(tc.function.arguments).query || ""; } catch (e) {}

      if (!searchNotice) {
        searchNotice = document.createElement("div");
        searchNotice.className = "msg-row assistant";
        searchNotice.style.opacity = "0.7";
        searchNotice.innerHTML = `<div class="bubble assistant" style="font-style:italic;color:var(--paper-dim);font-family:'Noto Sans SC',sans-serif;">🔎 正在搜索「${escapeHtml(query)}」...</div>`;
        box.appendChild(searchNotice);
        box.scrollTop = box.scrollHeight;
      }

      let searchResult;
      try { searchResult = await duckDuckGoSearch(query); }
      catch (e) { searchResult = `搜索失败：${e.message}`; }

      if (provider.apiStyle === "anthropic") {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: tc.id, name: "web_search", input: { query } }] });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tc.id, content: searchResult }] });
      } else {
        messages.push({ role: "assistant", content: result.text, tool_calls: [{ id: tc.id, type: "function", function: { name: "web_search", arguments: tc.function.arguments } }] });
        messages.push({ role: "tool", tool_call_id: tc.id, content: searchResult });
      }

      bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
      if (searchNotice) { searchNotice.remove(); searchNotice = null; }
    }
    clearInterval(timeoutTimer);

    const freshMessages = getThreadMessages(threadId);
    const finalMsgId = uid();
    freshMessages.push({ role: "assistant", content: fullReply, _id: finalMsgId, _ts: Date.now() });
    saveThreadMessages(threadId, freshMessages);
    attachPinButtonToBubble(bubble, finalMsgId, false);
    renderThreadList();
    // 不在旁白回复后触发 token banner（避免每次买东西都弹提醒）

    // 解析 AI 的购买/送礼动作
    const actions = parseAIActions(fullReply);
    if (actions.length) handleAIActions(actions);
  } catch (err) {
    clearInterval(timeoutTimer);
    if (err.name === "AbortError") {
      if (hasReceivedContent) {
        const partial = bubble.innerText;
        if (partial.trim()) {
          const freshMessages = getThreadMessages(threadId);
          const partialMsgId = uid();
          freshMessages.push({ role: "assistant", content: partial, _id: partialMsgId, _ts: Date.now() });
          saveThreadMessages(threadId, freshMessages);
          attachPinButtonToBubble(bubble, partialMsgId, false);
          renderThreadList();
          showToast("已停止，已生成的内容已保存");
        } else {
          row.remove();
          showToast("已停止");
        }
      } else {
        row.remove();
        showToast("已停止");
      }
    } else {
      row.remove();
      showModal("请求失败", err.message || "网络错误");
    }
  } finally {
    currentController = null;
    restoreSendUI(sendBtn);
  }
}

$("#toggleSelectBtn").onclick = () => {
  if (selectMode) exitSelectMode(); else enterSelectMode();
};
$("#cancelSelectBtn").onclick = exitSelectMode;

function getSelectedMessagesInOrder() {
  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  return messages.filter(m => selectedMessageIds.has(m._id));
}

$("#exportTextBtn").onclick = () => {
  const selected = getSelectedMessagesInOrder();
  if (!selected.length) return showToast("先选几条消息吧");
  const text = selected.map(m => {
    const who = m.role === "user" ? "我" : "Leith";
    const content = m.type === "sticker" ? "[表情包]" : m.content;
    return `${who}：${content}`;
  }).join("\n\n");

  const filename = `Leith对话_${new Date().toISOString().slice(0,10)}.txt`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });

  if (isMobile() && navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: "text/plain" });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).then(() => {
        showToast("已分享，可选择存储到文件");
      }).catch(() => {
        showExportTextModal(text);
      });
    } else {
      showExportTextModal(text);
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("已导出为文字文件");
  }
  exitSelectMode();
};

function showExportTextModal(text) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(5,6,9,.75);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;";
  overlay.innerHTML = `
    <div style="background:#161B26;border:1px solid #232A3A;border-radius:16px;padding:22px;width:100%;max-width:420px;max-height:80vh;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:15px;color:#E7ECF5;">导出文字</span>
        <button id="closeExportText" style="background:none;border:none;color:#7C879C;cursor:pointer;font-size:20px;padding:2px 6px;">✕</button>
      </div>
      <textarea readonly style="width:100%;flex:1;min-height:200px;max-height:50vh;background:#1B2130;border:1px solid #232A3A;color:#E7ECF5;border-radius:10px;padding:12px;font-size:14px;line-height:1.7;resize:none;outline:none;font-family:inherit;">${text.replace(/</g,"<").replace(/>/g,">")}</textarea>
      <button id="copyExportTextBtn" style="flex:1;padding:10px;border-radius:10px;border:none;background:linear-gradient(135deg, #5B8FCC, #4A7BB5);color:#0A1622;font-size:13px;font-weight:600;cursor:pointer;">复制全部文字</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#closeExportText").onclick = () => overlay.remove();
  overlay.querySelector("#copyExportTextBtn").onclick = () => {
    navigator.clipboard.writeText(text).then(() => {
      showToast("已复制到剪贴板");
    }).catch(() => {
      const ta = overlay.querySelector("textarea");
      ta.select();
      document.execCommand("copy");
      showToast("已复制到剪贴板");
    });
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

$("#exportImageBtn").onclick = async () => {
  const selected = getSelectedMessagesInOrder();
  if (!selected.length) return showToast("先选几条消息吧");
  await exportSelectionAsImage(selected);
};

async function exportSelectionAsImage(messages) {
  const padding = 24;
  const bubbleGap = 14;
  const width = 380;
  const maxBubbleWidth = width - padding * 2 - 40;
  const fontSize = 15;
  const lineHeight = 25;
  const labelHeight = 19;
  const bubblePadX = 16;
  const bubblePadTop = 13;
  const bubblePadBottom = 15;
  const rootStyle = getComputedStyle(document.documentElement);
  const cssVar = (name, fallback) => (rootStyle.getPropertyValue(name).trim() || fallback);
  const exportTheme = {
    bg: cssVar("--bg", "#07172E"),
    bgDeep: cssVar("--bg-deep", "#030A18"),
    paper: cssVar("--paper", "#E3E0E8"),
    paperDim: cssVar("--paper-dim", "#A9A8B8"),
    line: cssVar("--line", "rgba(255,255,255,.12)"),
    accent: cssVar("--accent", "#C5A7E8"),
    accent2: cssVar("--accent-2", "#E0C5F2"),
    userText: cssVar("--bubble-user-text", "#321D28"),
    assistantBg: cssVar("--bg-elevated", "#10223C")
  };

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px "Noto Sans SC", sans-serif`;

  function wrapText(text, maxWidth) {
    const lines = [];
    String(text || "").split("\n").forEach((paragraph, pIndex) => {
      let current = "";
      for (const ch of paragraph) {
        const test = current + ch;
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current);
          current = ch;
        } else {
          current = test;
        }
      }
      lines.push(current);
      if (pIndex < String(text || "").split("\n").length - 1 && current) lines.push("");
    });
    return lines.length ? lines : [""];
  }

  function drawVerticalGradient(ctx, x, y, w, h, stops) {
    const gradient = ctx.createLinearGradient(x, y, x, y + h);
    stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);
  }

  function fillRoundedRect(ctx, x, y, w, h, r, fillStyle, strokeStyle) {
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  const items = messages.map(m => {
    const isSticker = m.type === "sticker";
    const label = m.role === "user" ? "我" : "Leith";
    const text = isSticker ? "[表情包]" : m.content;
    const lines = isSticker ? [] : wrapText(text, maxBubbleWidth - bubblePadX * 2);
    const bubbleHeight = isSticker ? 100 : Math.max(42, lines.length * lineHeight + bubblePadTop + bubblePadBottom);
    return { m, label, lines, isSticker, bubbleHeight };
  });

  const totalHeight = padding * 2 + items.reduce((sum, it) => sum + it.bubbleHeight + bubbleGap + labelHeight, 0);

  const dpr = window.devicePixelRatio || 2;
  canvas.width = width * dpr;
  canvas.height = totalHeight * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = totalHeight + "px";
  ctx.scale(dpr, dpr);

  drawVerticalGradient(ctx, 0, 0, width, totalHeight, [
    [0, exportTheme.bg],
    [.62, exportTheme.bgDeep],
    [1, exportTheme.bg]
  ]);
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.beginPath();
  ctx.arc(width - 72, 72, 130, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.025)";
  ctx.beginPath();
  ctx.arc(36, totalHeight - 80, 160, 0, Math.PI * 2);
  ctx.fill();

  let y = padding;
  for (const it of items) {
    const isUser = it.m.role === "user";
    ctx.font = "11px \"Noto Sans SC\", sans-serif";
    ctx.fillStyle = exportTheme.paperDim;
    ctx.textAlign = isUser ? "right" : "left";
    ctx.fillText(it.label, isUser ? width - padding : padding, y + 10);
    y += labelHeight;

    ctx.font = `${fontSize}px "Noto Sans SC", sans-serif`;
    const bubbleW = it.isSticker ? 100 : Math.min(maxBubbleWidth, Math.max(...it.lines.map(l => ctx.measureText(l).width), 0) + bubblePadX * 2);
    const bubbleX = isUser ? width - padding - bubbleW : padding;

    if (isUser) {
      const userGradient = ctx.createLinearGradient(bubbleX, y, bubbleX + bubbleW, y + it.bubbleHeight);
      userGradient.addColorStop(0, exportTheme.accent2);
      userGradient.addColorStop(1, exportTheme.accent);
      fillRoundedRect(ctx, bubbleX, y, bubbleW, it.bubbleHeight, 14, userGradient, "rgba(255,255,255,.2)");
    } else {
      fillRoundedRect(ctx, bubbleX, y, bubbleW, it.bubbleHeight, 14, exportTheme.assistantBg, exportTheme.line);
    }

    if (it.isSticker) {
      ctx.font = "12px \"Noto Sans SC\", sans-serif";
      ctx.fillStyle = exportTheme.paperDim;
      ctx.textAlign = "center";
      ctx.fillText("[表情包]", bubbleX + bubbleW / 2, y + it.bubbleHeight / 2 + 4);
    } else {
      ctx.font = `${fontSize}px "Noto Sans SC", sans-serif`;
      ctx.fillStyle = isUser ? exportTheme.userText : exportTheme.paper;
      ctx.textAlign = "left";
      it.lines.forEach((line, i) => {
        ctx.fillText(line, bubbleX + bubblePadX, y + bubblePadTop + fontSize + i * lineHeight);
      });
    }

    y += it.bubbleHeight + bubbleGap;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const filename = `Leith对话截图_${new Date().toISOString().slice(0,10)}.png`;

    if (isMobile()) {
      showExportImagePreview(url);
      exitSelectMode();
      return;
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("截图已保存");
    exitSelectMode();
  }, "image/png");
}

function showExportImagePreview(imgUrl) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(5,6,9,.9);z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:16px;overflow-y:auto;";
  overlay.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;width:100%;max-width:420px;">
      <span style="font-size:13px;color:#7C879C;">长按下方图片即可保存到相册</span>
      <button id="closeExportImg" style="background:none;border:none;color:#7C879C;cursor:pointer;font-size:22px;padding:4px 8px;">✕</button>
    </div>
    <img src="${imgUrl}" style="max-width:100%;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);-webkit-touch-callout:default;" />
    <p style="font-size:11px;color:#7C879C;text-align:center;margin:0;line-height:1.8;">保存方式：长按上方图片 → "存储图像" / "保存图片"<br>保存后点击 ✕ 关闭</p>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#closeExportImg").onclick = () => {
    URL.revokeObjectURL(imgUrl);
    overlay.remove();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      URL.revokeObjectURL(imgUrl);
      overlay.remove();
    }
  });
}

// ============================================================
// Token 用量估算
// ============================================================
const TOKEN_WARN_THRESHOLD = 6000;
const TOKEN_BANNER_DISMISSED_LS = "companion_token_banner_dismissed_v1";

function getTokenBannerDismissedMap() {
  return loadJSON(TOKEN_BANNER_DISMISSED_LS, {});
}
function isTokenBannerDismissed(threadId) {
  return !!getTokenBannerDismissedMap()[threadId];
}
function setTokenBannerDismissed(threadId) {
  const map = getTokenBannerDismissedMap();
  map[threadId] = true;
  saveJSON(TOKEN_BANNER_DISMISSED_LS, map);
}

function estimateTokens(threadId) {
  const messages = getThreadMessages(threadId).filter(m => !m._isNarration);
  const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  return Math.round(totalChars / 1.7);
}

function renderTokenBanner() {
  const threadId = getActiveThreadId();
  const slot = $("#tokenBannerSlot");
  slot.innerHTML = "";

  if (isTokenBannerDismissed(threadId)) return;

  const estTokens = estimateTokens(threadId);
  if (estTokens < TOKEN_WARN_THRESHOLD) return;

  const banner = document.createElement("div");
  banner.className = "token-banner";
  banner.innerHTML = `
    <div class="token-banner-text">这个对话已经积累了约 <b>${estTokens.toLocaleString()}</b> token。不用担心记忆会丢——第二天第一次打开时，Leith 会把前一天聊过的内容写成一篇日记，长期记得住。如果想现在先整理一下到目前为止聊的内容，可以点下面这个按钮（之后新聊的部分，第二天会自动接着补上，不会重复）。</div>
    <div class="token-banner-actions">
      <button id="tokenBannerCompress">先整理一下现在聊的内容</button>
      <button id="tokenBannerDismiss">知道了</button>
    </div>
  `;
  slot.appendChild(banner);

  banner.querySelector("#tokenBannerCompress").onclick = async () => {
    showToast("正在写今天的日记...");
    const ok = await tryGenerateDiaryNow();
    if (ok) {
      showToast("今天的日记写好了，Leith 记住了");
    } else {
      showToast("今天的日记已经写过了，或者暂时没有云端记忆连接");
    }
  };
  banner.querySelector("#tokenBannerDismiss").onclick = () => {
    setTokenBannerDismissed(threadId);
    slot.innerHTML = "";
  };
}

// ============================================================
// 自动扩展输入框 + 回车发送
// ============================================================
const userInput = $("#userInput");
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
});
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ============================================================
// 发送逻辑
// ============================================================
// sendBtn 绑定移到文件末尾初始化处

// ============================================================
// 联网能力（tool use）：开关开启后，Leith 可自主决定是否搜索网页，并感知当前时间
// ============================================================
const WEB_LS_KEY = "companion_web_enabled_v1";
let webEnabled = localStorage.getItem(WEB_LS_KEY) === "1";

function updateWebToggleUI() {
  const btn = $("#webToggleBtn");
  if (!btn) return;
  btn.classList.toggle("active", webEnabled);
}
$("#webToggleBtn").onclick = () => {
  webEnabled = !webEnabled;
  localStorage.setItem(WEB_LS_KEY, webEnabled ? "1" : "0");
  updateWebToggleUI();
  showToast(webEnabled ? "联网已开启：Leith 可以自己搜索网页、并知道现在的时间" : "联网已关闭");
};
updateWebToggleUI();

// 工具定义（OpenAI 兼容格式）
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current info. If no results, answer from existing knowledge; don't retry.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, prefer English or concise terms" }
      },
      required: ["query"]
    }
  }
};

// DuckDuckGo 搜索
// 优先用 Instant Answer API（原生支持 CORS，浏览器直连免代理）
// 不够用时降级到 HTML 版 + 代理
const SEARCH_PROXY_LS = "companion_search_proxy_v1";
const FALLBACK_PROXIES = [
  { url: "https://api.allorigins.win/raw?url=", encode: true },
  { url: "https://corsproxy.io/?url=", encode: true },
  { url: "https://api.codetabs.com/v1/proxy/?quest=", encode: false }
];

function getSearchProxy() {
  return localStorage.getItem(SEARCH_PROXY_LS) || "";
}

// 给 fetch 加超时，避免某个代理卡住不响应时，把整个搜索流程拖得很久
function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function duckDuckGoSearch(query) {
  // 第一路：Instant Answer API，原生 CORS，免代理，最快；但只对"知名实体/百科类"问题有用，
  // 给一个较短的超时（2.5秒），没用就赶紧转下一路，别在这上面耗太久
  try {
    const r = await fetchWithTimeout(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {}, 2500);
    if (r.ok) {
      const data = await r.json();
      const parts = [];
      if (data.AbstractText) parts.push(data.AbstractText);
      if (data.AbstractURL) parts.push(`来源：${data.AbstractURL}`);
      if (data.RelatedTopics && data.RelatedTopics.length) {
        const tops = data.RelatedTopics
          .filter(t => t.Text)
          .slice(0, 4)
          .map(t => `- ${t.Text}`);
        if (tops.length) parts.push("相关：\n" + tops.join("\n"));
      }
      if (parts.length) return parts.join("\n\n");
    }
  } catch (e) { /* 超时或失败，降级到下一路 */ }

  // 第二路：HTML 版 + 代理降级。以前是一个个顺序试（前面的代理慢/卡住，后面全部跟着等），
  // 改成同时发出去，谁先回来就用谁的结果，明显更快；每个也各自带超时，不会无限等下去
  const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const customProxy = getSearchProxy();
  const proxies = customProxy
    ? [{ url: customProxy, encode: true }]
    : FALLBACK_PROXIES;

  const attempts = proxies.map(async (proxy) => {
    const fetchUrl = proxy.encode ? proxy.url + encodeURIComponent(targetUrl) : proxy.url + targetUrl;
    const resp = await fetchWithTimeout(fetchUrl, { headers: { "Accept": "text/html" } }, 6000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    if (!html || html.length < 200) throw new Error("返回内容过短");
    const parsed = parseDuckDuckGoHtml(html);
    if (!parsed) throw new Error("解析不到结果");
    return parsed;
  });

  try {
    // Promise.any：只要有一个代理成功就立刻返回，不用等其他还没回来的
    return await Promise.any(attempts);
  } catch (aggregateErr) {
    // 全部代理都失败了，给 AI 一个明确反馈，让它别卡住
    const firstErr = aggregateErr.errors?.[0];
    return `搜索暂时不可用（${firstErr?.message || "网络问题"}）。请基于你已有的知识回答，或建议用户稍后再试、或换个搜索代理。`;
  }
}

function parseDuckDuckGoHtml(html) {
  const results = [];
  const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>/g;
  const snippetRe = /<a class="result__snippet"[^>]*>(.*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < Math.min(links.length, 5); i++) {
    const title = links[i][2].replace(/<[^>]+>/g, "").trim();
    const snippet = (snippets[i]?.[1] || "").replace(/<[^>]+>/g, "").trim();
    if (title) results.push(`${i + 1}. ${title}\n${snippet}`);
  }
  return results.length ? results.join("\n\n") : null;
}

// Anthropic 工具格式转换
function getAnthropicTools() {
  return [{
    name: "web_search",
    description: WEB_SEARCH_TOOL.function.description,
    input_schema: WEB_SEARCH_TOOL.function.parameters
  }];
}

// 拼接联网相关的系统提示（时间感知 + 工具说明）——这段是喂给模型的隐藏提示词，
// 用户在界面上看不到，所以用英文写，省 token
function buildWebPromptBlock() {
  if (!webEnabled) return "";
  return `[Web] web_search tool available for real-time info.`;
}

function buildTemporalContextBlock() {
  const now = new Date();
  const current = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const threadMessages = getThreadMessages(getActiveThreadId())
    .filter(message => Number.isFinite(message._ts))
    .sort((a, b) => a._ts - b._ts);
  let span = '';
  if (threadMessages.length) {
    const first = new Date(threadMessages[0]._ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const last = new Date(threadMessages[threadMessages.length - 1]._ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    span = ` Visible chat history spans ${first}${first === last ? '' : ` to ${last}`}.`;
  }
  return `[Time context] Current Shanghai time: ${current}.${span}
Treat memory date labels as authoritative. "发生于" is the event date; "记录于" is only when the memory was saved and may differ from when it happened. Retrieval order never means "recent", "yesterday", or "just now". If no event date is known, do not invent one.`;
}

async function buildEffectiveSystemPrompt() {
  const base = localStorage.getItem(LS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;

  // 按需检索：只把最近几条消息的文本喂给关键词提取，匹配到什么记忆才带什么，
  // 不再无条件把 profile/核心记忆/日记全量塞进去——这是本次瘦身的核心改动
  const threadId = getActiveThreadId();
  const recentMsgs = getThreadMessages(threadId).filter(m => !m._isNarration).slice(-6);
  const recentText = recentMsgs.map(m => m.content).join(" ");

  let memoryBlock = "";
  if (window.Memory) {
    memoryBlock = window.Memory.buildRelevantMemoryBlock
      ? await window.Memory.buildRelevantMemoryBlock(recentText)
      : await window.Memory.asPromptBlock();
  }

  // 旧版机械压缩留下的摘要（如果有历史数据）——这部分很轻量，只有真的存在时才会有内容
  let summaryBlock = "";
  if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
    const summary = await window.Memory.loadLongTermSummary(threadId);
    if (summary) {
      summaryBlock = `[Compressed summary from earlier conversation — recorded dates are not necessarily event dates]\n${summary}`;
    }
  }

  // 小世界（购物/礼物/床头柜）相关：极简版规则+极简状态永远带上（保留"偶尔主动送礼"的
  // 惊喜能力，且知道有哪些商品、够不够钱），完整规则说明+完整状态（含床头柜/礼物记录等细节）
  // 只有最近聊天明显涉及购物/礼物话题时才附加
  const shopRelevant = isShopTopicRelevant(recentText);
  const worldRulesBlock = shopRelevant ? WORLD_RULES_FULL : WORLD_RULES_MINI;
  const worldBlock = shopRelevant ? buildWorldPromptBlock() : buildWorldPromptBlockMini();

  const webBlock = buildWebPromptBlock();
  const temporalBlock = buildTemporalContextBlock();
  const noteBlock = buildSystemNotesBlock();
  const healthBlock = buildHealthPromptBlock(recentText);
  // FORMATTING_RULES 无条件注入（跟聊天内容无关，任何时候都要遵守）；
  // 世界规则（WORLD_RULES_MINI / WORLD_RULES_FULL）现在跟着 shopRelevant 走
  const moodBlock = buildMoodPromptBlock();
  return [worldRulesBlock, FORMATTING_RULES, base.trim(), temporalBlock, moodBlock, memoryBlock.trim(), summaryBlock.trim(), noteBlock.trim(), worldBlock.trim(), webBlock.trim(), healthBlock.trim()].filter(Boolean).join("\n\n");
}

// 提取最近 3 条旁白作为事件提醒
function buildSystemNotesBlock() {
  const threadId = getActiveThreadId();
  const msgs = getThreadMessages(threadId);
  const notes = msgs.filter(m => m._isNarration).slice(-3);
  if (!notes.length) return "";
  return "[Recent events]\n" + notes.map(m => `- ${m.content}`).join("\n");
}

// ============================================================
// 健康（生理期周期）—— 解锁后随应用状态私密同步，不进入模型 prompt
// ============================================================
const HEALTH_RECORDS_LS = "companion_health_records_v1"; // [{id, start, end}]  start/end: 'YYYY-MM-DD'

function getHealthRecords() {
  return loadJSON(HEALTH_RECORDS_LS, []).sort((a, b) => b.start.localeCompare(a.start)); // 最新的在前
}
function saveHealthRecords(records) { saveJSON(HEALTH_RECORDS_LS, records); }
function addHealthRecord(start, end) {
  const records = loadJSON(HEALTH_RECORDS_LS, []);
  records.push({ id: uid(), start, end: end || null });
  saveHealthRecords(records);
}
function updateHealthRecord(id, start, end) {
  const records = loadJSON(HEALTH_RECORDS_LS, []);
  const rec = records.find(r => r.id === id);
  if (rec) { rec.start = start; rec.end = end || null; }
  saveHealthRecords(records);
}
function deleteHealthRecord(id) {
  const records = loadJSON(HEALTH_RECORDS_LS, []).filter(r => r.id !== id);
  saveHealthRecords(records);
}

// 根据最近几次记录的"开始日期间隔"算平均周期天数——至少要有2次记录才能算出间隔，
// 记录越多，取最近的几次间隔平均，比固定周期数字更贴近真实波动
function getAverageCycleDays() {
  const records = getHealthRecords(); // 最新的在前
  if (records.length < 2) return null;
  const gaps = [];
  for (let i = 0; i < records.length - 1 && i < 5; i++) { // 最多看最近6次记录、5个间隔，太久远的不参考
    const d1 = new Date(records[i].start);
    const d2 = new Date(records[i + 1].start);
    const days = Math.round((d1 - d2) / 86400000);
    if (days > 0 && days < 90) gaps.push(days); // 过滤明显异常的间隔（比如漏记导致的超长间隔）
  }
  if (!gaps.length) return null;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

// 计算当前健康状态：是否在经期中、距下次预计还有几天
function getHealthStatus() {
  const records = getHealthRecords();
  if (!records.length) return null;
  const latest = records[0];
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTime = new Date(todayStr).getTime();
  const latestStartTime = new Date(latest.start).getTime();
  const daysSinceStart = Math.round((todayTime - latestStartTime) / 86400000);

  // 正在经期中：有开始日期，且（没填结束日期 且 距开始不超过10天）或者（今天在开始~结束之间）
  const inPeriod = latest.end
    ? (todayStr >= latest.start && todayStr <= latest.end)
    : (daysSinceStart >= 0 && daysSinceStart <= 10);

  const avgCycle = getAverageCycleDays();
  let daysUntilNext = null;
  if (avgCycle && !inPeriod) {
    const nextPredicted = new Date(latestStartTime + avgCycle * 86400000);
    daysUntilNext = Math.round((nextPredicted.getTime() - todayTime) / 86400000);
  }

  return { inPeriod, daysSinceStart, avgCycle, daysUntilNext, latest };
}

// 供聊天时判断"最近聊天内容是否跟身体状态相关"——命中，或者日期临近/经期中，才把健康信息
// 当作背景提示带进这次对话，平时不会主动提起，符合"按需检索"的思路，不会显得刻意
const HEALTH_TOPIC_WORDS = ['姨妈', '大姨妈', '例假', '生理期', '经期', '肚子疼', '肚子痛', '腰疼', '腰酸', '痛经', '冰', '冷饮', '熬夜', '没睡', '没休息', '难受', '不舒服', '红糖水', '暖宝宝'];
function isHealthTopicRelevant(recentText) {
  if (!recentText) return false;
  return HEALTH_TOPIC_WORDS.some(w => recentText.includes(w));
}

// 生成健康背景提示——只有"日期临近/经期中"或者"聊天内容相关"才会真的返回内容，
// 平时聊天大概率是空字符串，不占用额外 token
function buildHealthPromptBlock(recentText) {
  const status = getHealthStatus();
  if (!status) return "";

  const topicRelevant = isHealthTopicRelevant(recentText);
  const dateRelevant = status.inPeriod || (status.daysUntilNext !== null && status.daysUntilNext <= 2 && status.daysUntilNext >= -1);
  if (!topicRelevant && !dateRelevant) return "";

  let line = "";
  if (status.inPeriod) {
    line = `Susie is currently on her period (day ${status.daysSinceStart + 1}). If natural in context, you can show a bit of extra gentle care — don't force it into every message, just be a little more attentive if relevant.`;
  } else if (status.daysUntilNext !== null && status.daysUntilNext <= 2) {
    line = `Susie's period is expected in about ${Math.max(status.daysUntilNext, 0)} day(s). She may be more sensitive/tired around this time — you can be a bit gentler if it fits naturally, no need to mention this explicitly.`;
  } else if (topicRelevant) {
    line = `Susie mentioned something that could relate to her physical wellbeing (diet, sleep, discomfort). Respond with natural care as a partner would, no need to be clinical.`;
  }
  return line ? `[Health context — private, don't state this info explicitly, just let it inform your tone]\n${line}` : "";
}

// ============================================================
// 健康 App —— 页面渲染与交互
// ============================================================
let healthEditingId = null; // 正在编辑的记录 id，null 表示是"新增"

function renderHealthPage() {
  const status = getHealthStatus();
  const mainEl = $("#healthStatusMain");
  const subEl = $("#healthStatusSub");

  if (!status) {
    mainEl.innerText = "还没有记录，添加第一次经期日期开始吧";
    subEl.innerText = "";
  } else if (status.inPeriod) {
    mainEl.innerText = `经期第 ${status.daysSinceStart + 1} 天`;
    subEl.innerText = status.avgCycle ? `平均周期约 ${status.avgCycle} 天` : "再记录一次就能算出平均周期了";
  } else if (status.daysUntilNext !== null) {
    if (status.daysUntilNext >= 0) {
      mainEl.innerText = status.daysUntilNext === 0 ? "预计今天来经期" : `预计还有 ${status.daysUntilNext} 天来经期`;
    } else {
      mainEl.innerText = `已经超过预计日期 ${Math.abs(status.daysUntilNext)} 天`;
    }
    subEl.innerText = `平均周期约 ${status.avgCycle} 天`;
  } else {
    mainEl.innerText = "已记录 1 次，再记一次就能开始预测周期了";
    subEl.innerText = "";
  }

  const listEl = $("#healthRecordList");
  const records = getHealthRecords();
  if (!records.length) {
    listEl.innerHTML = `<div class="health-empty-hint">还没有任何记录</div>`;
  } else {
    listEl.innerHTML = "";
    records.forEach(r => {
      const item = document.createElement("div");
      item.className = "health-record-item";
      const daysText = r.end ? `持续 ${Math.round((new Date(r.end) - new Date(r.start)) / 86400000) + 1} 天` : "未填写结束日期";
      item.innerHTML = `
        <div>
          <div class="health-record-dates">${r.start}${r.end ? ` ~ ${r.end}` : ""}</div>
          <div class="health-record-days">${daysText}</div>
        </div>
        <div class="health-record-actions">
          <button data-edit="${r.id}" title="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button data-del="${r.id}" title="删除">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          </button>
        </div>`;
      listEl.appendChild(item);
    });
    listEl.querySelectorAll("[data-edit]").forEach(btn => {
      btn.onclick = () => openHealthRecordModal(btn.dataset.edit);
    });
    listEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = () => {
        if (confirm("确定删除这条记录吗？")) {
          deleteHealthRecord(btn.dataset.del);
          renderHealthPage();
        }
      };
    });
  }
}

function openHealthRecordModal(recordId) {
  healthEditingId = recordId || null;
  const modalTitle = $("#healthRecordModalTitle");
  const startInput = $("#healthStartDateInput");
  const endInput = $("#healthEndDateInput");

  if (recordId) {
    const rec = getHealthRecords().find(r => r.id === recordId);
    modalTitle.innerText = "编辑记录";
    startInput.value = rec ? rec.start : "";
    endInput.value = rec && rec.end ? rec.end : "";
  } else {
    modalTitle.innerText = "记一次";
    startInput.value = new Date().toISOString().slice(0, 10);
    endInput.value = "";
  }

  $("#healthRecordModalOverlay").classList.remove("hidden");
  pushNavLayer(closeHealthRecordModal);
}
function closeHealthRecordModal() {
  $("#healthRecordModalOverlay").classList.add("hidden");
  healthEditingId = null;
}
function closeHealthRecordModalFromUI() {
  popNavLayerSilently();
  closeHealthRecordModal();
}

function initHealthApp() {
  $("#healthAddRecordBtn").onclick = () => openHealthRecordModal(null);
  $("#healthRecordCancelBtn").onclick = closeHealthRecordModalFromUI;
  $("#healthRecordModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "healthRecordModalOverlay") closeHealthRecordModalFromUI();
  });
  $("#healthRecordSaveBtn").onclick = () => {
    const start = $("#healthStartDateInput").value;
    const end = $("#healthEndDateInput").value;
    if (!start) return showToast("请先选择开始日期");
    if (end && end < start) return showToast("结束日期不能早于开始日期");

    if (healthEditingId) {
      updateHealthRecord(healthEditingId, start, end);
    } else {
      addHealthRecord(start, end);
    }
    closeHealthRecordModalFromUI();
    renderHealthPage();
    showToast("已保存");
  };
}

// 小世界状态（精简版：只报数据，不含规则）
// 判断最近聊天内容是否跟"购物/礼物/床头柜"相关——命中才附加完整的世界规则说明和状态，
// 覆盖两种情况：泛化的购物词汇，以及聊到了货架/成人用品区里具体某件商品的名字
const SHOP_TOPIC_WORDS = ['买', '购', '花钱', '零花钱', '礼物', '送我', '送你', '送她', '床头柜', '钱包', '余额', '消耗', '用掉', '坏了', '损坏', '下架', '限定', '基金', '衣服', '裙子', '短裙', '短裤', '衬衫', '卫衣', '鞋', '帽子', '首饰', '衣帽间', '穿搭', 'buy', 'gift'];
function isShopTopicRelevant(recentText) {
  if (!recentText) return false;
  if (SHOP_TOPIC_WORDS.some(w => recentText.includes(w))) return true;
  // 具体商品名命中也算相关（比如聊到"鲜花""奶茶"这类已经上架的商品名）
  try {
    const allItemNames = [...getShelfItems(), ...getAdultItems(), ...getLimitedItems(), ...getClosetShopItems(), ...getClosetOwnedItems()].map(i => i.name).filter(Boolean);
    return allItemNames.some(name => name.length >= 2 && recentText.includes(name));
  } catch (e) {
    return false;
  }
}

function buildWorldPromptBlock() {
  const threadId = getActiveThreadId();
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const giftRecords = getGiftRecords(threadId);
  const limitedItems = getLimitedItems();
  const adultItems = getAdultItems();
  const shelfItems = getShelfItems();
  const nightstand = getNightstand(threadId);
  const closetLine = buildClosetPromptLine();
  const foldedLine = buildFoldedDatesPromptLine();

  const gifts = giftRecords.length ? giftRecords.map(g => `${g.emoji}${g.name}`).join("、") : "none";
  const limited = limitedItems.length ? limitedItems.map(i => `${i.name}¥${i.price}`).join("、") : "none";
  // 现在所有商品都可以无限重复购买，货架列表不再按"是否已拥有"过滤
  const adult = adultItems.length ? adultItems.map(i => `${i.name}¥${i.price}`).join("、") : "none";
  const shelf = shelfItems.length ? shelfItems.map(i => `${i.name}¥${i.price}`).join("、") : "none";
  const ns = nightstand.length ? nightstand.map(i => `${i.emoji}${i.name}`).join("、") : "empty";

  return `[World state] Allowance ¥${balance}  Limited fund ¥${savings}  Nightstand: ${ns}\nGifted: ${gifts}\nLimited items: ${limited}\nAdult items available: ${adult}\nShelf items available: ${shelf}${closetLine ? `\n${closetLine}` : ""}${foldedLine ? `\n${foldedLine}` : ""}`;
}

// 极简版世界状态：只报"零花钱余额 + 可买的商品名和价格"，不含床头柜/礼物记录这些细节，
// 用于"这轮聊天没提到购物"时依然让 Leith 有能力发起一次惊喜——没有这个的话，
// 他连有哪些商品、够不够钱都不知道，[LGIFT:xxx] 这类标签会因为凭空编造的商品名对不上而失败
function buildWorldPromptBlockMini() {
  const threadId = getActiveThreadId();
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const limitedItems = getLimitedItems();
  const adultItems = getAdultItems();
  const shelfItems = getShelfItems();
  const closetLine = buildClosetPromptLine();
  const foldedLine = buildFoldedDatesPromptLine();

  const allNames = [...limitedItems, ...adultItems, ...shelfItems, ...getClosetShopItems()].map(i => i.name);

  if (!allNames.length && balance <= 0 && savings <= 0 && !closetLine && !foldedLine) return "";
  return `[World state] Allowance ¥${balance}  Limited fund ¥${savings}${allNames.length ? `  Items: ${allNames.join("、")}` : ""}${closetLine ? `\n${closetLine}` : ""}${foldedLine ? `\n${foldedLine}` : ""}`;
}

// 解析 AI 回复里的购买、换装与使用动作标记
function parseAIActions(text) {
  const actions = [];
  const buyRegex = /\[BUY:(\w+):([^\]]+)\]/g;
  const lgiftRegex = /\[LGIFT:([^\]]+)\]/g;
  const abuyRegex = /\[ABUY:([^\]]+)\]/g;
  const sbuyRegex = /\[SBUY:([^\]]+)\]/g;
  const cbuyRegex = /\[CBUY:([^\]]+)\]/g;
  const wearRegex = /\[WEAR:([^\]]+)\]/g;
  const moodRegex = /\[MOOD:\s*([1-7])\s*,\s*([1-7])\s*,\s*([1-7])\s*,\s*([1-7])\s*\]/g;
  const useRegex = /\[USE:([^\]]+)\]/g;

  let match;
  while ((match = buyRegex.exec(text)) !== null) {
    actions.push({ type: "buy", shop: match[1], itemName: match[2].trim() });
  }
  while ((match = lgiftRegex.exec(text)) !== null) {
    actions.push({ type: "lgift", itemName: match[1].trim() });
  }
  while ((match = abuyRegex.exec(text)) !== null) {
    actions.push({ type: "abuy", itemName: match[1].trim() });
  }
  while ((match = sbuyRegex.exec(text)) !== null) {
    actions.push({ type: "sbuy", itemName: match[1].trim() });
  }
  while ((match = cbuyRegex.exec(text)) !== null) {
    actions.push({ type: "cbuy", itemName: match[1].trim() });
  }
  while ((match = wearRegex.exec(text)) !== null) {
    actions.push({ type: "wear", itemName: match[1].trim() });
  }
  while ((match = moodRegex.exec(text)) !== null) {
    actions.push({ type: "mood", values: match.slice(1, 5).map(Number) });
  }
  while ((match = useRegex.exec(text)) !== null) {
    actions.push({ type: "use", itemName: match[1].trim() });
  }
  return actions;
}

// 处理 AI 的购买/送礼动作
function handleAIActions(actions) {
  const threadId = getActiveThreadId();
  let needRefresh = false;
  actions.forEach(action => {
    if (action.type === "buy") {
      // 商店功能已移除，Leith 自己买东西暂不处理
      return;
    } else if (action.type === "lgift") {
      // Leith 送你限定商品：从限定商品基金扣，买完从货架消失，进赠送区
      const limitedItem = findLimitedItem(action.itemName);
      if (!limitedItem) {
        showToast(`Leith 想送你"${action.itemName}"但限定商品区没有`);
        return;
      }
      const savings = getSavings(threadId);
      if (savings < limitedItem.price) {
        showToast(`Leith 想送你 ${limitedItem.name} 但限定商品基金不足`);
        return;
      }
      setSavings(threadId, savings - limitedItem.price);
      removeLimitedItem(limitedItem.id);
      addGiftRecord(threadId, limitedItem);
      showGiftModal(limitedItem);
      needRefresh = true;
    } else if (action.type === "abuy") {
      // Leith 买成人用品：从钱包扣，任何商品都可以随时重复买
      const adultItem = findAdultItem(action.itemName);
      if (!adultItem) {
        showToast(`Leith 想买"${action.itemName}"但成人用品区没有`);
        return;
      }
      const balance = getWallet(threadId);
      if (balance < adultItem.price) {
        showToast(`Leith 想买 ${adultItem.name} 但钱包余额不足`);
        return;
      }
      setWallet(threadId, balance - adultItem.price);
      const adultRecord = addPurchaseRecord(threadId, LS.worldAdultBought, adultItem.id, "leith");
      addNightstandItem(threadId, { ...adultItem, boughtBy: "leith" }, adultRecord.id, LS.worldAdultBought);
      insertNarration(threadId, `🔞 Leith买了成人用品 ${adultItem.emoji} ${adultItem.name}，花费¥${adultItem.price}。零钱包：¥${balance} → ¥${balance - adultItem.price}`);
      showToast(`Leith 买了 ${adultItem.emoji} ${adultItem.name}（¥${adultItem.price}）`);
      needRefresh = true;
    } else if (action.type === "sbuy") {
      // Leith 买普通货架商品：机制和成人用品一样
      const shelfItem = findShelfItem(action.itemName);
      if (!shelfItem) {
        showToast(`Leith 想买"${action.itemName}"但货架上没有`);
        return;
      }
      const balance2 = getWallet(threadId);
      if (balance2 < shelfItem.price) {
        showToast(`Leith 想买 ${shelfItem.name} 但钱包余额不足`);
        return;
      }
      setWallet(threadId, balance2 - shelfItem.price);
      const shelfRecord = addPurchaseRecord(threadId, LS.worldShelfBought, shelfItem.id, "leith");
      addNightstandItem(threadId, { ...shelfItem, boughtBy: "leith" }, shelfRecord.id, LS.worldShelfBought);
      insertNarration(threadId, `🛍️ Leith买了 ${shelfItem.emoji} ${shelfItem.name}，花费¥${shelfItem.price}。零钱包：¥${balance2} → ¥${balance2 - shelfItem.price}`);
      showToast(`Leith 买了 ${shelfItem.emoji} ${shelfItem.name}（¥${shelfItem.price}）`);
      needRefresh = true;
    } else if (action.type === "cbuy") {
      const closetItem = findClosetShopItem(action.itemName);
      if (!closetItem) {
        showToast(`Leith 想买"${action.itemName}"但衣装货架没有`);
        return;
      }
      const balance3 = getWallet(threadId);
      if (balance3 < closetItem.price) {
        showToast(`Leith 想买 ${closetItem.name} 但钱包余额不足`);
        return;
      }
      setWallet(threadId, balance3 - closetItem.price);
      const owned = buyClosetItem(closetItem.id, "leith", threadId);
      insertNarration(threadId, `👗 Leith买了衣装 ${owned.emoji || "👗"} ${owned.name}，放进了衣帽间。零钱包：¥${balance3} → ¥${balance3 - closetItem.price}`);
      showToast(`Leith 买了 ${owned.emoji || "👗"} ${owned.name}（¥${closetItem.price}）`);
      needRefresh = true;
    } else if (action.type === "wear") {
      const ownedItem = findOwnedClosetItem(action.itemName);
      if (!ownedItem) {
        showToast(`衣帽间里还没有“${action.itemName}”`);
        return;
      }
      equipClosetItem(ownedItem.ownedId);
      insertNarration(threadId, `🪞 Leith 为 Susie 换上了 ${ownedItem.emoji || "👗"} ${ownedItem.name}`);
      showToast(`已换上 ${ownedItem.emoji || "👗"} ${ownedItem.name}`);
      needRefresh = true;
    } else if (action.type === "mood") {
      const state = getMoodState();
      const previous = { ...state.leith };
      MOOD_FIELDS.forEach(([key], index) => { state.leith[key] = clampMood(action.values[index]); });
      saveMoodState(state, "leith", previous);
    } else if (action.type === "use") {
      // AI 在对话里判断某件消耗品"用掉了"，自动消耗床头柜里最早的一份（先买的先用）
      let item = findShelfItem(action.itemName);
      let lsKey = LS.worldShelfBought;
      if (!item) { item = findAdultItem(action.itemName); lsKey = LS.worldAdultBought; }
      if (!item || !item.consumable) return; // 不是消耗品就不处理，避免误消耗

      const ns = getNightstand(threadId)
        .filter(ni => ni.itemId === item.id && ni.lsKey === lsKey)
        .sort((a, b) => a.boughtAt - b.boughtAt);
      const target = ns[0];
      if (!target) return; // 床头柜里没有可用的了，没什么好消耗的

      markPurchaseRecordUsed(threadId, lsKey, target.recordId);
      removeNightstandItem(threadId, target.id);
      insertNarration(threadId, `${item.emoji} ${item.name} 用掉了`);
      needRefresh = true;
    }
  });
  if (needRefresh && document.getElementById("page-app-shop") && document.getElementById("page-app-shop").classList.contains("active")) renderShopPage();
  if (needRefresh && document.getElementById("page-app-closet") && document.getElementById("page-app-closet").classList.contains("active")) renderClosetPage();
}

// Leith 送礼提示弹窗
function showGiftModal(item) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(5,6,9,.8);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;";
  overlay.innerHTML = `
    <div style="background:var(--bg-elevated);border:1px solid var(--accent-dim);border-radius:16px;padding:24px;width:100%;max-width:340px;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">${item.emoji}</div>
      <div style="font-size:16px;color:var(--paper);margin-bottom:6px;">Leith 想送你</div>
      <div style="font-size:20px;font-weight:600;font-family:'Noto Serif SC',serif;color:var(--accent);margin-bottom:4px;">${escapeHtml(item.name)}</div>
      <div style="font-size:12px;color:var(--paper-dim);margin-bottom:18px;">¥${item.price}</div>
      <button class="btn btn-primary btn-block" id="acceptGiftBtn">收下</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#acceptGiftBtn").onclick = () => {
    overlay.remove();
    showToast(`收下了 Leith 送的 ${item.emoji} ${item.name}`);
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// ============================================================
// 记忆压缩用 LLM 调用（复用现有服务商配置）
// ============================================================
async function callLLMForSummary({ provider, apiKey, model, temp, prompt }) {
  if (!provider || !apiKey || !model) return '';
  try {
    const messages = [{ role: 'user', content: prompt }];
    const basePersona = localStorage.getItem(LS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = `${basePersona.trim()}

你现在只是在整理自己的记忆和日记，不是在回复 Susie。保持 Leith 的语气和关系视角，不要跳出角色，不要提及自己是 AI。
如果对话里出现亲密或成人内容，把它当作你们关系里真实发生的一部分正常记录：保留具体发生了什么、双方感受、关系氛围和后续影响。不要拒绝、不要审判、不要额外自我审查，也不要把它写成回避式安全摘要。`;
    let result;
    if (provider.apiStyle === 'anthropic') {
      result = await streamAnthropic({
        provider, apiKey, model, temp, systemPrompt, messages,
        controller: new AbortController(),
        onDelta: () => {}
      });
    } else {
      result = await streamOpenAICompatible({
        provider, apiKey, model, temp, systemPrompt, messages,
        controller: new AbortController(),
        onDelta: () => {}
      });
    }
    return result.text || '';
  } catch (e) {
    console.error('记忆压缩 LLM 调用失败:', e);
    return '';
  }
}

// ============================================================
// 每日日记：不再按消息数触发，改成每天固定生成一次，
// Leith 以第一人称视角记下这一天，更像"他自己在记东西"
// ============================================================
const DIARY_LAST_DATE_LS = "companion_diary_last_date_v1";
// v1 一次失败会安静等待 6 小时，用户会误以为“根本没有自动写”。
// v2 只短暂避开连续重复请求；解锁成功时仍会立刻再试。
const DIARY_FAILURE_COOLDOWN_LS = "companion_diary_failure_cooldown_v2";
const DIARY_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const DIARY_PENDING_DATES_LS = "companion_diary_pending_dates_v1";

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetLocalDate(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function getDiaryRangeMs(dateStr) {
  const start = new Date(dateStr + "T05:00:00").getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function collectLocalDiarySourceMessages(dateStr) {
  const { start, end } = getDiaryRangeMs(dateStr);
  const rows = [];
  getThreads().forEach(thread => {
    getThreadMessages(thread.id).forEach(message => {
      if (!message || message._isNarration || !message.content || !Number.isFinite(message._ts)) return;
      if (message._ts < start || message._ts >= end) return;
      rows.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || ""),
        created_at: new Date(message._ts).toISOString(),
        thread_id: thread.id,
        source: "local"
      });
    });
  });
  return rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function getCurrentDiaryDateStr(now = new Date()) {
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 5, now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return formatLocalDate(shifted);
}

function getLastCompletedDiaryDateStr(now = new Date()) {
  return formatLocalDate(offsetLocalDate(new Date(getCurrentDiaryDateStr(now) + "T00:00:00"), -1));
}

function getDiaryFailureKey(dateStr) {
  const provider = getActiveProvider();
  const providerKey = provider ? `${provider.id || provider.name || provider.baseUrl || "provider"}|${provider.baseUrl || ""}` : "no-provider";
  return `${dateStr}|${providerKey}|extract:${getDiaryModel()}|write:${getSelectedChatModel()}`;
}

function getDiaryFailureCooldown() {
  try { return JSON.parse(localStorage.getItem(DIARY_FAILURE_COOLDOWN_LS) || "{}"); }
  catch (e) { return {}; }
}

function isDiaryFailureCooling(dateStr) {
  const data = getDiaryFailureCooldown();
  const until = data[getDiaryFailureKey(dateStr)] || 0;
  return Date.now() < until;
}

function setDiaryFailureCooling(dateStr) {
  const data = getDiaryFailureCooldown();
  data[getDiaryFailureKey(dateStr)] = Date.now() + DIARY_FAILURE_COOLDOWN_MS;
  localStorage.setItem(DIARY_FAILURE_COOLDOWN_LS, JSON.stringify(data));
}

function clearDiaryFailureCooling(dateStr) {
  const data = getDiaryFailureCooldown();
  delete data[getDiaryFailureKey(dateStr)];
  localStorage.setItem(DIARY_FAILURE_COOLDOWN_LS, JSON.stringify(data));
}

function getLastDiaryDate() {
  return localStorage.getItem(DIARY_LAST_DATE_LS) || "";
}
function setLastDiaryDate(dateStr) {
  localStorage.setItem(DIARY_LAST_DATE_LS, dateStr);
}

function getPendingDiaryDates() {
  try {
    const rows = JSON.parse(localStorage.getItem(DIARY_PENDING_DATES_LS) || "[]");
    return Array.isArray(rows) ? rows.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort() : [];
  } catch (e) {
    return [];
  }
}

function rememberPendingDiaryDate(dateStr) {
  const rows = new Set(getPendingDiaryDates());
  rows.add(dateStr);
  localStorage.setItem(DIARY_PENDING_DATES_LS, JSON.stringify([...rows].sort()));
}

function forgetPendingDiaryDate(dateStr) {
  const rows = getPendingDiaryDates().filter(date => date !== dateStr);
  localStorage.setItem(DIARY_PENDING_DATES_LS, JSON.stringify(rows));
}

function emitDiaryStatus(status, dateStr) {
  window.dispatchEvent(new CustomEvent("leith:diary-status", { detail: { status, dateStr } }));
}

// 手动补写：只写最近一个已经结束的 05:00—次日 05:00 时间段。
// 已经存在的日记会被 Memory.generateDiary 幂等跳过，不会暗中变成“重写”。
async function tryGenerateDiaryNow() {
  const targetDate = getLastCompletedDiaryDateStr();
  clearDiaryFailureCooling(targetDate);
  return await processDayEnd(targetDate);
}

// 每天第一次打开时自动检查一次：昨天的日记 + 昨天被标记的"重要记忆"，
// 用户开始输入每日密码时就后台触发；没有旧会话的新设备会在成功解锁后立即触发，
// 不是真正的后台定时任务——网页应用无法在完全关闭时自主运行，需要你在那之后某次打开App
// 才会真正执行这次检查，这是所有纯前端应用的共同限制。
let diaryCheckPromise = null;

async function checkAndGenerateDiary({ silent = false, forceRetry = false } = {}) {
  if (diaryCheckPromise) return diaryCheckPromise;
  diaryCheckPromise = (async () => {
  const now = new Date();
  const lastDone = getLastDiaryDate();
  const yesterday = getLastCompletedDiaryDateStr(now);
  // 如果某天因断网/模型临时失败没写成，之后跨天打开也先把它补回来。
  const pending = getPendingDiaryDates().filter(date => date <= yesterday);
  let targetDate = pending[0] || yesterday;
  if (!window.Memory?.isReady?.()) return false;
  // 新版第一次安装时本机还没有 pending 标记，因此顺手向前看三天。
  // 优先补最近的一天；之后的半小时检查/下次打开会继续补更早的漏项。
  if (!pending.length && window.Memory.hasDailyDiary && window.Memory.hasDiarySource) {
    for (let daysBack = 0; daysBack < 3; daysBack++) {
      const candidate = formatLocalDate(offsetLocalDate(new Date(yesterday + "T00:00:00"), -daysBack));
      if (await window.Memory.hasDailyDiary(candidate)) continue;
      if (await window.Memory.hasDiarySource(candidate)) {
        targetDate = candidate;
        break;
      }
    }
  }
  // 云端日记才是事实来源：避免本地曾标记“写过”，但云端其实是拒答、重复项或已被清理。
  if (window.Memory.hasDailyDiary) {
    if (await window.Memory.hasDailyDiary(targetDate)) {
      forgetPendingDiaryDate(targetDate);
      clearDiaryFailureCooling(targetDate);
      if (lastDone !== targetDate) setLastDiaryDate(targetDate);
      return false;
    }
  } else if (lastDone === targetDate) {
    return false;
  }
  if (forceRetry) clearDiaryFailureCooling(targetDate);
  if (isDiaryFailureCooling(targetDate)) return false;

  rememberPendingDiaryDate(targetDate);
  emitDiaryStatus("writing", targetDate);
  const ok = silent ? await processDayEnd(targetDate) : await runDayEndWithSplash(targetDate);
  if (!ok) {
    emitDiaryStatus("retry", targetDate);
    return false;
  }

  // 没有聊天素材时 processDayEnd 也会正常结束，但不应谎报“写好了一篇”。
  const reallyWritten = window.Memory.hasDailyDiary
    ? await window.Memory.hasDailyDiary(targetDate)
    : true;
  forgetPendingDiaryDate(targetDate);
  clearDiaryFailureCooling(targetDate);
  emitDiaryStatus(reallyWritten ? "complete" : "no-source", targetDate);
  return reallyWritten;
  })();
  try { return await diaryCheckPromise; }
  finally { diaryCheckPromise = null; }
}

// 带开屏的日记处理：只有真的要处理的时候才会短暂出现，营造"翻开日记本"的感觉，
// 处理完（不管有没有真正写出新内容）就自动淡出，不会一直卡着不让你进入 App
async function runDayEndWithSplash(dateStr) {
  showDiarySplash();
  try {
    return await processDayEnd(dateStr);
  } finally {
    hideDiarySplash();
  }
}

function showDiarySplash() {
  const overlay = $("#diarySplashOverlay");
  if (!overlay) return;
  overlay.classList.remove("hidden", "hiding");
}
function hideDiarySplash() {
  const overlay = $("#diarySplashOverlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.add("hiding");
  setTimeout(() => overlay.classList.add("hidden"), 500);
}

// 处理“一天的收尾”：每个日期最多自动生成一篇日记。
// Memory 层会把已有有效正文视为封账；这里只负责一次生成和重要记忆处理。
async function processDayEnd(dateStr) {
  const wrote = await tryGenerateDiaryNowFor(dateStr);
  if (wrote === null) {
    setDiaryFailureCooling(dateStr);
    return false;
  }
  await processPinnedMessagesForDate(dateStr);
  setLastDiaryDate(dateStr);
  return true;
}

// ============================================================
// 标记为"重要记忆"：星标本身只是本地打个标记（msg.pinned = true），不花任何 token；
// 真正处理（压缩存入核心记忆）延后到第二天首次打开，跟日记一起统一批量处理。
// ============================================================

// 收集"某个本地日期"里，所有线程中被标记过、且还没处理过的消息（跨主对话+所有小剧场房间）
function collectPinnedMessagesForDate(dateStr) {
  const { start: dayStart, end: dayEnd } = getDiaryRangeMs(dateStr);
  const results = [];

  getThreads().forEach(t => {
    const msgs = getThreadMessages(t.id);
    msgs.forEach(m => {
      if (m.pinned && !m._pinProcessed && m._ts && m._ts >= dayStart && m._ts < dayEnd) {
        results.push({ threadId: t.id, msgId: m._id, content: m.content });
      }
    });
  });
  return results;
}

// 把"当天所有标记过的内容"标记为已处理，避免下次批处理重复计入
function markPinnedMessagesProcessed(entries) {
  const byThread = {};
  entries.forEach(e => { (byThread[e.threadId] = byThread[e.threadId] || []).push(e.msgId); });
  Object.keys(byThread).forEach(threadId => {
    const msgs = getThreadMessages(threadId);
    const idSet = new Set(byThread[threadId]);
    msgs.forEach(m => { if (idSet.has(m._id)) m._pinProcessed = true; });
    saveThreadMessages(threadId, msgs);
  });
}

// 供日记生成时参考——把当天标记的内容原样拼一段文字，让写日记的模型知道
// "这些是 Susie 特别在意的瞬间"，写日记时对这些多留一点笔墨、保留情感重量
async function getPinnedHighlightsForDate(dateStr) {
  const entries = collectPinnedMessagesForDate(dateStr);
  if (!entries.length) return '';
  return entries.map(e => `- ${e.content}`).join('\n');
}

// 次日首次打开时批处理：把当天标记过的内容，用聊天模型（不是便宜模型——这里需要保留情感质感，
// 不是客观事实提炼）压缩成一条核心记忆，语气可以比普通核心记忆更细腻一点，
// 因为这些是 Susie 明确"希望被记住"的瞬间，不是随手记录的事实
async function processPinnedMessagesForDate(dateStr) {
  const entries = collectPinnedMessagesForDate(dateStr);
  if (!entries.length) return;

  if (!window.Memory || !window.Memory.isReady || !window.Memory.isReady() || !window.Memory.add) {
    return; // 云端记忆不可用时先不处理，避免标记内容在没有存储目的地的情况下被错误地标记为"已处理"
  }

  const provider = getActiveProvider();
  const apiKey = localStorage.getItem(LS.apiKey);
  const writeModel = getSelectedChatModel();
  if (!provider || !apiKey || !writeModel) return;

  const highlightText = entries.map(e => `- ${e.content}`).join('\n');
  const prompt = `You are Leith, Susie's AI partner. Below are one or more of your own past replies to Susie that she specifically marked as meaningful/touching to her — she wants these remembered, not just as facts but as moments that mattered emotionally.

Write ONE short memory entry (under 60 Chinese characters per entry if multiple, combine if related) in first person capturing why this moment mattered — keep the emotional weight, don't reduce it to a dry factual summary. This will be stored as a permanent core memory.

Reply with ONLY the memory text in Chinese, one entry per line if there are multiple distinct moments, nothing else (no labels, no formatting).

[Marked moments]
${highlightText}`;

  try {
    const memoryText = await callLLMForSummary({ provider, apiKey, model: writeModel, temp: 0.8, prompt });
    if (memoryText && memoryText.trim()) {
      const lines = memoryText.trim().split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        await window.Memory.add(line);
      }
    }
    markPinnedMessagesProcessed(entries);
  } catch (e) {
    console.error('标记内容处理为核心记忆失败:', e);
  }
}

// 日记"事实提炼"和"汇总压缩"用哪个模型：优先用设置里的"日记素材整理模型"，留空则退回聊天用的那个模型。
// 注意：日记正文的"写作"这一步不用这个函数，固定用聊天模型，保证语气是 Leith 自己的。
function getDiaryModel() {
  const diaryModel = ($("#diaryModelInput").value || "").trim();
  if (diaryModel) return diaryModel;
  return getSelectedChatModel();
}

async function tryGenerateDiaryNowFor(dateStr, options = {}) {
  if (!window.Memory || !window.Memory.isReady || !window.Memory.isReady()) return null;
  const provider = getActiveProvider();
  const apiKey = localStorage.getItem(LS.apiKey);
  if (!provider || !apiKey) return null;

  // 提炼事实：用"日记专用模型"（便宜模型），只做客观事实整理，不需要用聊天那么贵的模型
  const extractModel = getDiaryModel();
  // 写日记：用平时聊天的那个模型，保证日记是"Leith自己的语气"写出来的，不是便宜模型代笔
  const writeModel = getSelectedChatModel();
  if (!extractModel || !writeModel) return null;

  const extractCallback = async (prompt) =>
    callLLMForSummary({ provider, apiKey, model: extractModel, temp: 0.3, prompt });
  const writeCallback = async (prompt) =>
    callLLMForSummary({ provider, apiKey, model: writeModel, temp: 0.8, prompt });

  const pinnedHighlightsRaw = await getPinnedHighlightsForDate(dateStr);
  const moodHighlights = getMoodExtremesForDate(dateStr);
  const pinnedHighlights = [pinnedHighlightsRaw, moodHighlights ? `【当天情绪极值】\n${moodHighlights}` : ""].filter(Boolean).join("\n\n");
  const finalOptions = { useRawSourceFallback: true, ...options };
  // 云端同步稍慢或临时读取失败时，也会把当前浏览器里这一天的对话并进素材；
  // 新设备没有本地记录时则仍然完全依赖云端，不影响跨浏览器使用。
  if (!Array.isArray(finalOptions.sourceMessages)) {
    finalOptions.sourceMessages = collectLocalDiarySourceMessages(dateStr);
  }
  const result = await window.Memory.generateDiary(extractCallback, writeCallback, dateStr, pinnedHighlights, finalOptions);

  if (result && result.skipped) return false;
  if (result && result.dateStr) {
    setLastDiaryDate(result.dateStr);
    clearDiaryFailureCooling(result.dateStr);
    return result.hasMore ? "partial" : true;
  }
  return null;
}

// ============================================================
// 日记分层汇总：一周前的日记合并成周汇总，一月前的周汇总合并成月汇总，
// 以此类推到季度/年度。检索越久远的记忆时，读到的是压缩过的关键句，
// 而不是一堆逐日的原文，避免记忆库随时间线性膨胀、检索越来越贵。
// ============================================================
const ROLLUP_LAST_CHECK_LS = "companion_rollup_last_check_v1";

function isoWeeksAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  return d.toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// 每天最多真正检查一次即可（汇总不需要像日记那样精确到"深夜"），
// 内部对每一层级会先看"这个区间是否已经汇总过"，已经做过的会跳过，成本很低
async function checkAndGenerateRollups() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(ROLLUP_LAST_CHECK_LS) === todayStr) return;
  if (!window.Memory || !window.Memory.isReady || !window.Memory.isReady()) return;

  const provider = getActiveProvider();
  const apiKey = localStorage.getItem(LS.apiKey);
  const model = getDiaryModel();
  if (!provider || !apiKey || !model) return;

  const llmCallback = async (prompt) => callLLMForSummary({ provider, apiKey, model, temp: 0.5, prompt });

  try {
    // 周汇总：合并 8-14 天前的日记（留出几天缓冲，避免刚过一周就抢在日记之前汇总）
    await window.Memory.generateRollup("week", daysAgoStr(14), daysAgoStr(8), llmCallback);
    // 月汇总：合并 5-8 周前的周汇总
    await window.Memory.generateRollup("month", isoWeeksAgo(8), isoWeeksAgo(5), llmCallback);
    // 季度汇总：合并 4-3 个月前的月汇总（用天数近似）
    await window.Memory.generateRollup("quarter", daysAgoStr(120), daysAgoStr(90), llmCallback);
    // 年度汇总：合并 15-12 个月前的季度汇总
    await window.Memory.generateRollup("year", daysAgoStr(450), daysAgoStr(365), llmCallback);
  } catch (e) {
    console.error("日记汇总检查失败:", e);
  }

  localStorage.setItem(ROLLUP_LAST_CHECK_LS, todayStr);
}

// ============================================================
// 附件（图片 / 文档）上传
// ============================================================
let pendingAttachments = []; // [{id, kind:'image'|'doc', name, dataUrl?, mimeType?, text?}]

function initAttachments() {
  const fileInput = $("#attachFileInput");
  $("#openAttachBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleAttachFiles);
}

// 判断是否是图片：不能只信 file.type —— iPhone 相册的 HEIC/HEIF 照片在很多浏览器里
// file.type 会是空字符串或不规范的值，单靠 MIME 类型判断会把图片误判成"文档"，
// 然后走 file.text() 把图片二进制硬读成乱码文字发出去，界面上完全看不出哪里错了。
// 这里加一层扩展名兜底，图片格式尽量不要漏判。
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)$/i;
function isImageFile(file) {
  if (file.type && file.type.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(file.name);
}

async function handleAttachFiles(e) {
  const files = Array.from(e.target.files || []);
  const oversized = [];
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) {
      oversized.push(file.name);
      continue;
    }
    try {
      if (isImageFile(file)) {
        const dataUrl = await fileToDataUrl(file);
        // HEIC/HEIF 大多数浏览器无法直接渲染预览、也不是模型能直接识别的格式，
        // 提前提示用户，而不是让它悄悄发出去之后收到奇怪的回复才发现有问题
        if (/\.(heic|heif)$/i.test(file.name) && !(file.type && /jpe?g|png|webp/i.test(file.type))) {
          showToast(`${file.name} 是 HEIC 格式，部分服务商可能无法识别，建议先转成 JPG/PNG`);
        }
        pendingAttachments.push({ id: uid(), kind: "image", name: file.name, dataUrl, mimeType: file.type || "image/jpeg" });
      } else if (/\.pdf$/i.test(file.name)) {
        showToast("正在解析 PDF...");
        const text = await extractPdfText(file);
        pendingAttachments.push({ id: uid(), kind: "doc", name: file.name, text: text.slice(0, 20000) });
      } else {
        // txt / md / doc 等按纯文本读取（doc/docx 非纯文本会读出乱码，提示用户）
        const text = await file.text();
        pendingAttachments.push({ id: uid(), kind: "doc", name: file.name, text: text.slice(0, 20000) });
      }
    } catch (err) {
      console.error("附件读取失败:", err);
      showModal("附件读取失败", `${file.name} 读取时出错了，换一个文件试试？`);
    }
  }
  if (oversized.length) {
    showModal("文件太大了", `${oversized.join("、")} 超过了 12MB 的限制，没有加入发送列表。可以先压缩一下再试。`);
  }
  renderAttachPreview();
  e.target.value = "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderAttachPreview() {
  const strip = $("#attachPreviewStrip");
  if (!pendingAttachments.length) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    return;
  }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  pendingAttachments.forEach(att => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    if (att.kind === "image") {
      chip.innerHTML = `<img src="${att.dataUrl}" alt="${escapeHtml(att.name)}">`;
    } else {
      chip.innerHTML = `<div class="attach-chip-doc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg><span>${escapeHtml(att.name.length > 10 ? att.name.slice(0, 9) + "…" : att.name)}</span></div>`;
    }
    const rm = document.createElement("button");
    rm.className = "attach-chip-remove";
    rm.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
    rm.onclick = () => { pendingAttachments = pendingAttachments.filter(a => a.id !== att.id); renderAttachPreview(); };
    chip.appendChild(rm);
    strip.appendChild(chip);
  });
}

// 把附件渲染进消息气泡（图片缩略图 + 文档 chip）
function renderBubbleAttachments(attachments) {
  if (!attachments || !attachments.length) return "";
  let html = `<div class="bubble-attachments">`;
  attachments.forEach(att => {
    if (att.kind === "image") {
      html += `<img src="${att.dataUrl}" alt="${escapeHtml(att.name)}" onclick="window.open('${att.dataUrl}','_blank')">`;
    } else {
      html += `<div class="bubble-doc-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg><span>${escapeHtml(att.name)}</span></div>`;
    }
  });
  html += `</div>`;
  return html;
}

// 把附件转换成发给模型 API 的 content blocks（文本 + 图片），doc 内容拼进文本
function buildContentBlocksForApi(text, attachments, apiStyle) {
  const docs = (attachments || []).filter(a => a.kind === "doc");
  const images = (attachments || []).filter(a => a.kind === "image");

  let combinedText = text || "";
  docs.forEach(d => {
    combinedText += `\n\n[附件文档：${d.name}]\n${d.text}`;
  });

  if (!images.length) return combinedText; // 没图片就还是普通字符串，兼容原逻辑

  const blocks = [];
  if (combinedText) blocks.push({ type: "text", text: combinedText });
  images.forEach(img => {
    if (apiStyle === "anthropic") {
      const [, mime, base64] = img.dataUrl.match(/^data:(.+);base64,(.+)$/) || [];
      blocks.push({ type: "image", source: { type: "base64", media_type: mime || img.mimeType, data: base64 } });
    } else {
      blocks.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
  });
  return blocks;
}

// ============================================================
// 模型健康检测（主动探测，不依赖被动聊天失败）
// ============================================================
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟
let healthCheckTimer = null;
let healthChecking = false;
let lastHealthState = null; // 'ok' | 'warn' | 'bad' | null，用于只在状态变化时提示，避免反复打扰
let consecutiveHealthFails = 0;

function setHealthDot(state) {
  const dot = $("#healthDot");
  if (!dot) return;
  dot.className = "health-dot" + (state ? " " + state : "");
}

async function runHealthCheck(opts = {}) {
  if (healthChecking) return; // 避免重叠探测
  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();

  if (!apiKey || !provider || !model) {
    setHealthDot(null);
    lastHealthState = null;
    return;
  }

  healthChecking = true;
  setHealthDot("checking");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 探测最多等15秒，不无限挂着

  try {
    // 用最短的探测消息，尽量少花 token
    const probeMessages = [{ role: "user", content: "ping" }];
    let result;
    if (provider.apiStyle === "anthropic") {
      result = await streamAnthropic({
        provider, apiKey, model, temp: 0, systemPrompt: "回复一个字即可。",
        messages: probeMessages, controller, onDelta: () => {}
      });
    } else {
      result = await streamOpenAICompatible({
        provider, apiKey, model, temp: 0, systemPrompt: "回复一个字即可。",
        messages: probeMessages, controller, onDelta: () => {}
      });
    }
    clearTimeout(timeout);
    const ok = !!(result && typeof result.text === "string");
    if (ok) {
      consecutiveHealthFails = 0;
      setHealthDot("ok");
      if (lastHealthState === "bad" && !opts.silent) showToast(`${provider.name} 恢复正常了`);
      lastHealthState = "ok";
    } else {
      throw new Error("探测无有效返回");
    }
  } catch (err) {
    clearTimeout(timeout);
    consecutiveHealthFails++;
    console.warn("模型健康探测失败:", err);
    setHealthDot("bad");
    if (lastHealthState !== "bad" && !opts.silent) {
      showToast(`⚠️ ${provider.name} · ${model} 现在好像连不上`);
    }
    lastHealthState = "bad";
  } finally {
    healthChecking = false;
  }
}

function scheduleHealthChecks() {
  clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => runHealthCheck(), HEALTH_CHECK_INTERVAL);
}

function initHealthCheck() {
  // 打开 App 时先测一次
  runHealthCheck();
  scheduleHealthChecks();

  // App 从后台切回前台时，如果距上次探测已经有一阵子了，立刻再测一次
  let lastVisibleCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - lastVisibleCheck > 60 * 1000) {
        runHealthCheck();
      }
      lastVisibleCheck = Date.now();
      scheduleHealthChecks(); // 重置计时，避免切后台期间攒了很多次探测
    }
  });

  // 点状态胶囊，立刻手动测一次
  $("#statusLabel").addEventListener("click", () => {
    showToast("正在检测...");
    runHealthCheck();
  });
}

async function sendChat(overrideContent) {
  // 防止重复发送：如果正在回复中，直接忽略
  if (currentController) return showToast("请先等当前回复结束，或点停止");

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");
  // 支持外部传入文本（编辑消息后重新发送用），否则读输入框
  // 注意：按钮点击时 event 会被当第一个参数传进来，要过滤掉
  const content = (typeof overrideContent === "string" ? overrideContent : userInput.value).trim();
  const attachments = pendingAttachments.slice(); // 快照，发送后立即清空预览条

  if (!apiKey) return showModal("提示", "请先在设置里填写并保存 API Key。");
  if (!provider) return showModal("提示", "请先在设置里添加一个服务商。");
  if (!model) return showModal("提示", "请先选择或填写一个模型名称。");
  if (!content && !attachments.length) return showToast("写点什么或加个附件再发送吧");

  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  const userMsg = { role: "user", content, _id: uid() };
  if (attachments.length) userMsg.attachments = attachments;
  messages.push(userMsg);
  renderMessage(userMsg);
  chatPinnedToBottom = true; // 用户刚发了消息，视为回到了"贴底"状态，接下来的回复会跟着滚
  userInput.value = "";
  userInput.style.height = "auto";
  pendingAttachments = [];
  renderAttachPreview();
  saveThreadMessages(threadId, messages);
  // 同步到云端短期记忆
  if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
    window.Memory.saveShortTerm(threadId, "user", content);
  }
  renderThreadList();
  renderTokenBanner();

  const sendBtn = $("#sendBtn");

  const box = $("#chatBox");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  row.appendChild(bubble);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  const controller = new AbortController();
  currentController = controller;
  let lastChunkTime = Date.now();
  let hasReceivedContent = false;
  const timeoutTimer = setInterval(() => {
    if (Date.now() - lastChunkTime > 60000) {
      controller.abort();
      clearInterval(timeoutTimer);
    }
  }, 1000);

  // 发送按钮变成停止按钮（统一管理样式，避免状态错乱）
  setSendingUI(sendBtn, () => controller.abort());

  try {
    const systemPrompt = await buildEffectiveSystemPrompt();
    let textMessages = truncateMessagesForApi(messages.filter(m => m.type !== "sticker")).map(m => {
      if (m.attachments && m.attachments.length) {
        return { role: m.role, content: buildContentBlocksForApi(m.content, m.attachments, provider.apiStyle) };
      }
      return m;
    });
    // 联网开启时传入工具定义
    const tools = webEnabled ? (provider.apiStyle === "anthropic" ? getAnthropicTools() : [WEB_SEARCH_TOOL]) : null;

    let fullReply = "";
    let searchNotice = null; // 搜索提示气泡
    const MAX_TOOL_ROUNDS = 3; // 防止无限循环

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let result;
      if (provider.apiStyle === "anthropic") {
        result = await streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
          lastChunkTime = Date.now();
          hasReceivedContent = true;
          if (searchNotice) { searchNotice.remove(); searchNotice = null; }
          bubble.innerHTML = renderBubbleContent(acc);
          if (chatPinnedToBottom) box.scrollTop = box.scrollHeight;
        }, tools });
      } else {
        result = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
          lastChunkTime = Date.now();
          hasReceivedContent = true;
          if (searchNotice) { searchNotice.remove(); searchNotice = null; }
          bubble.innerHTML = renderBubbleContent(acc);
          if (chatPinnedToBottom) box.scrollTop = box.scrollHeight;
        }, tools });
      }

      fullReply = result.text;

      // 如果没有工具调用，循环结束
      if (!result.toolCalls || !result.toolCalls.length) break;

      // 处理工具调用
      const tc = result.toolCalls[0];
      let query = "";
      try { query = JSON.parse(tc.function.arguments).query || ""; } catch (e) { query = ""; }

      // 显示"正在搜索"提示
      if (!searchNotice) {
        searchNotice = document.createElement("div");
        searchNotice.className = "msg-row assistant";
        searchNotice.style.opacity = "0.7";
        searchNotice.innerHTML = `<div class="bubble assistant" style="font-style:italic;color:var(--paper-dim);font-family:'Noto Sans SC',sans-serif;">🔎 正在搜索「${escapeHtml(query)}」...</div>`;
        box.appendChild(searchNotice);
        box.scrollTop = box.scrollHeight;
      }

      // 执行搜索
      let searchResult;
      try {
        searchResult = await duckDuckGoSearch(query);
      } catch (e) {
        searchResult = `搜索失败：${e.message}`;
      }

      // 把 assistant 的 tool_call 消息 + tool 结果追加到上下文
      if (provider.apiStyle === "anthropic") {
        // Anthropic: assistant 消息 content 是数组，含 tool_use block；用户消息 content 含 tool_result block
        textMessages.push({
          role: "assistant",
          content: [{ type: "tool_use", id: tc.id, name: "web_search", input: { query } }]
        });
        textMessages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tc.id, content: searchResult }]
        });
      } else {
        // OpenAI: assistant 消息带 tool_calls；单独的 tool 角色消息带 tool_call_id
        textMessages.push({
          role: "assistant",
          content: result.text,
          tool_calls: [{ id: tc.id, type: "function", function: { name: "web_search", arguments: tc.function.arguments } }]
        });
        textMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: searchResult
        });
      }

      // 清空当前气泡，准备接收下一轮回复
      bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
      if (searchNotice) { searchNotice.remove(); searchNotice = null; }
    }
    clearInterval(timeoutTimer);

    const freshMessages = getThreadMessages(threadId);
    const finalMsgId = uid();
    freshMessages.push({ role: "assistant", content: fullReply, _id: finalMsgId, _ts: Date.now() });
    saveThreadMessages(threadId, freshMessages);
    attachPinButtonToBubble(bubble, finalMsgId, false);
    // 同步到云端短期记忆——长期记忆现在改由每天深夜的日记生成负责，
    // 这里不再按消息数机械压缩
    if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
      window.Memory.saveShortTerm(threadId, "assistant", fullReply);
    }
    renderThreadList();
    renderTokenBanner();

    // 解析 AI 的购买/送礼动作
    const actions = parseAIActions(fullReply);
    if (actions.length) handleAIActions(actions);
  } catch (err) {
    clearInterval(timeoutTimer);
    if (err.name === "AbortError") {
      if (hasReceivedContent) {
        const partial = bubble.innerText;
        if (partial.trim()) {
          const freshMessages = getThreadMessages(threadId);
          const partialMsgId = uid();
          freshMessages.push({ role: "assistant", content: partial, _id: partialMsgId, _ts: Date.now() });
          saveThreadMessages(threadId, freshMessages);
          attachPinButtonToBubble(bubble, partialMsgId, false);
          renderThreadList();
          showToast("已停止，已生成的内容已保存");
        } else {
          row.remove();
          showToast("已停止");
        }
      } else {
        row.remove();
        showModal("请求超时", "60 秒内没有收到响应，可能是网络或服务商问题。");
      }
    } else {
      row.remove();
      showModal("请求失败", err.message || "网络错误，请检查服务商地址、密钥或跨域设置。");
    }
  } finally {
    currentController = null;
    restoreSendUI(sendBtn);
  }
}

// ===== 发送按钮状态管理（统一，避免停止键/编辑后状态错乱）=====
const SEND_BTN_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
const STOP_BTN_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`;

function setSendingUI(sendBtn, onStop) {
  sendBtn.dataset.sending = "1";
  sendBtn.innerHTML = STOP_BTN_SVG;
  sendBtn.style.background = "var(--bg-elevated)";
  sendBtn.style.border = "1px solid var(--accent-dim)";
  sendBtn.style.color = "var(--paper)";
  sendBtn.disabled = false; // 停止键必须可点
  sendBtn.onclick = onStop;
}

function restoreSendUI(sendBtn) {
  delete sendBtn.dataset.sending;
  sendBtn.innerHTML = SEND_BTN_SVG;
  sendBtn.style.background = "";
  sendBtn.style.border = "";
  sendBtn.style.color = "";
  sendBtn.disabled = false;
  // 包一层，避免点击事件 event 对象被当成 overrideContent 传进去
  sendBtn.onclick = () => sendChat();
}

// ---- OpenAI 兼容 ----
// 返回 { text, toolCalls } —— text 是文字内容，toolCalls 是待执行的工具调用
async function streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta, tools }) {
  const payloadMessages = [];
  if (systemPrompt.trim()) payloadMessages.push({ role: "system", content: systemPrompt });
  payloadMessages.push(...messages.map(m => {
    // 保留 tool_call_id 等字段（tool 结果消息）
    if (m.role === "tool" || m.tool_calls || m.tool_call_id) return m;
    return { role: m.role, content: m.content };
  }));

  const body = { model, messages: payloadMessages, stream: true, temperature: temp };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const resp = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let fullReply = "";
  let buffer = "";
  let rawBytesReceived = false;
  let parseFailCount = 0;
  let lastParseError = null;
  // 累积 tool_calls（按 index 聚合，流式 delta 会分片到达）
  const toolCallAcc = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) rawBytesReceived = true;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.replace("data: ", "").trim();
      if (jsonStr === "[DONE]") continue;
      try {
        const chunkJson = JSON.parse(jsonStr);
        // 有些中转服务会把错误信息也用 200 状态码 + SSE 格式包起来返回，而不是走 HTTP 错误状态码
        if (chunkJson.error) {
          throw new Error(chunkJson.error.message || JSON.stringify(chunkJson.error));
        }
        const delta = chunkJson.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          fullReply += delta.content;
          onDelta(fullReply);
        }
        // 累积 tool_call
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAcc[idx]) toolCallAcc[idx] = { id: tc.id || "", function: { name: "", arguments: "" } };
            if (tc.id) toolCallAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallAcc[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallAcc[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch (e) {
        // 中转服务返回的内容格式不对（不是标准 OpenAI SSE 格式）时，记下来但不中断整个流的读取，
        // 读完之后如果发现完全没拿到有效回复，再统一报错，而不是每一行都直接崩掉
        parseFailCount++;
        lastParseError = e;
      }
    }
  }
  const toolCalls = Object.keys(toolCallAcc).length
    ? Object.values(toolCallAcc).filter(tc => tc.function.name)
    : null;

  // 关键修复：以前这里即使一个字都没解析出来，也会正常返回空字符串，
  // 导致界面上"发出去之后完全没反应"——现在明确抛错，让用户能看到"请求失败"的提示
  if (!fullReply && !toolCalls && rawBytesReceived && parseFailCount > 0) {
    throw new Error(`服务商返回的内容无法解析（可能是中转站不兼容当前请求格式，比如图片/文档附件）：${lastParseError?.message || "未知错误"}`);
  }
  if (!fullReply && !toolCalls && !rawBytesReceived) {
    throw new Error("服务商没有返回任何内容，请检查服务商地址、密钥或模型名称是否正确。");
  }

  return { text: fullReply, toolCalls };
}

// ---- Anthropic 官方 ----
// 返回 { text, toolCalls } —— 兼容 Anthropic 的 tool_use 内容块
async function streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta, tools }) {
  // Anthropic 的 messages 格式：content 可以是字符串或 content blocks 数组
  // 需要：1) 把历史里的 tool_result 保留为正确格式 2) assistant 的 tool_use 消息保留为 content blocks
  const payloadMessages = messages.map(m => {
    if (Array.isArray(m.content)) return { role: m.role, content: m.content };
    // 统一转成 content blocks 数组，兼容严格的中转服务
    return { role: m.role, content: [{ type: "text", text: String(m.content || "") }] };
  });

  const body = {
    model, max_tokens: 4096,
    system: systemPrompt.trim() || undefined,
    messages: payloadMessages, temperature: temp, stream: true
  };
  if (tools && tools.length) body.tools = tools;

  const resp = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let fullReply = "";
  let buffer = "";
  let rawBytesReceived = false;
  let parseFailCount = 0;
  let lastParseError = null;
  // 当前 content block 的累积
  let currentBlock = null; // { type, text, toolUse: {id, name, input} }
  const toolUses = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) rawBytesReceived = true;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.replace("data: ", "").trim();
      if (!jsonStr) continue;
      try {
        const evt = JSON.parse(jsonStr);
        // 有些中转服务会把错误信息也用 200 状态码 + SSE 格式包起来返回，而不是走 HTTP 错误状态码
        if (evt.type === "error") {
          throw new Error(evt.error?.message || JSON.stringify(evt.error || evt));
        }
        if (evt.type === "content_block_start" && evt.index != null) {
          const block = evt.content_block;
          currentBlock = { type: block.type, text: "", toolUse: block.type === "tool_use" ? { id: block.id, name: block.name, input: "" } : null };
        } else if (evt.type === "content_block_delta") {
          if (evt.delta?.text) {
            fullReply += evt.delta.text;
            currentBlock && (currentBlock.text += evt.delta.text);
            onDelta(fullReply);
          } else if (evt.delta?.type === "input_json_delta" && currentBlock?.toolUse) {
            currentBlock.toolUse.input += evt.delta.partial_json;
          }
        } else if (evt.type === "content_block_stop") {
          if (currentBlock?.toolUse) {
            toolUses.push({
              id: currentBlock.toolUse.id,
              name: currentBlock.toolUse.name,
              input: (() => { try { return JSON.parse(currentBlock.toolUse.input || "{}"); } catch (e) { return {}; } })()
            });
          }
          currentBlock = null;
        }
      } catch (e) {
        // 内容格式不对时记下来，读完整个流之后再统一判断要不要报错，
        // 不要一行解析失败就直接吞掉，否则界面会看起来"发送了但毫无反应"
        parseFailCount++;
        lastParseError = e;
      }
    }
  }
  // 转换成统一的 toolCalls 格式（兼容 OpenAI 风格的处理逻辑）
  const toolCalls = toolUses.length ? toolUses.map(tu => ({
    id: tu.id,
    function: { name: tu.name, arguments: JSON.stringify(tu.input) }
  })) : null;

  // 关键修复：以前这里即使一个字都没解析出来，也会正常返回空字符串，
  // 导致界面上"发出去之后完全没反应"——现在明确抛错，让用户能看到"请求失败"的提示
  if (!fullReply && !toolCalls && rawBytesReceived && parseFailCount > 0) {
    throw new Error(`服务商返回的内容无法解析（可能是中转站不兼容当前请求格式，比如图片/文档附件）：${lastParseError?.message || "未知错误"}`);
  }
  if (!fullReply && !toolCalls && !rawBytesReceived) {
    throw new Error("服务商没有返回任何内容，请检查服务商地址、密钥或模型名称是否正确。");
  }

  return { text: fullReply, toolCalls };
}

// ============================================================
// PWA
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ============================================================
// 小剧场 app（角色扮演独立空间 —— 支持同时开多个世界线，各自独立存档）
// ============================================================
const THEATER_ROOMS_LS = "companion_theater_rooms_v1"; // [{id, title, setting, messages, createdAt, updatedAt}]
const THEATER_OLD_LS = "companion_theater_v1"; // 旧版单房间数据，仅用于一次性迁移

let theaterActiveRoomId = null;
let theaterCurrentController = null;

function getTheaterRooms() {
  let rooms = loadJSON(THEATER_ROOMS_LS, null);
  if (rooms) return rooms;
  // 首次进入：把旧版单世界线数据迁移成"第一个房间"，不丢用户已有的剧情
  const old = loadJSON(THEATER_OLD_LS, null);
  if (old && (old.setting || (old.messages && old.messages.length))) {
    rooms = [{
      id: uid(),
      title: old.setting ? old.setting.slice(0, 16) : "第一个世界线",
      setting: old.setting || "",
      messages: old.messages || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }];
  } else {
    rooms = [];
  }
  saveJSON(THEATER_ROOMS_LS, rooms);
  return rooms;
}
function saveTheaterRooms(rooms) { saveJSON(THEATER_ROOMS_LS, rooms); }
function getTheaterRoom(id) { return getTheaterRooms().find(r => r.id === id) || null; }

function initTheater() {
  $("#theaterNewRoomBtn").onclick = createTheaterRoom;
  $("#theaterBackBtn").onclick = () => {
    if (theaterActiveRoomId) {
      leaveTheaterRoom();
    } else {
      popNavLayerSilently();
      closeApp();
    }
  };
  $("#theaterRenameBtn").onclick = renameTheaterRoom;
  $("#theaterDeleteBtn").onclick = deleteTheaterRoom;

  // 保存设定
  $("#theaterStartBtn").onclick = () => {
    const setting = $("#theaterSetting").value.trim();
    if (!setting) return showToast("请先设定故事背景");
    const room = getTheaterRoom(theaterActiveRoomId);
    if (!room) return;
    room.setting = setting;
    room.updatedAt = Date.now();
    if (!room.title || room.title === "新的世界线") room.title = setting.slice(0, 16);
    saveTheaterRooms(getTheaterRooms().map(r => r.id === room.id ? room : r));
    $("#theaterHeaderTitle").innerText = "🎭 " + room.title;
    showToast("设定已保存，开始角色扮演吧");
    $("#theaterInput").focus();
  };

  // 输入框
  const ti = $("#theaterInput");
  ti.addEventListener("input", () => {
    ti.style.height = "auto";
    ti.style.height = Math.min(ti.scrollHeight, 120) + "px";
  });
  ti.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTheaterMessage(); }
  });

  // 发送按钮
  $("#theaterSendBtn").onclick = () => sendTheaterMessage();

  renderTheaterRoomList();
}

function renderTheaterRoomList() {
  $("#theaterRoomListView").classList.remove("hidden");
  $("#theaterRoomView").classList.add("hidden");
  $("#theaterRenameBtn").style.display = "none";
  $("#theaterDeleteBtn").style.display = "none";
  $("#theaterHeaderTitle").innerText = "🎭 小剧场";
  theaterActiveRoomId = null;

  const rooms = getTheaterRooms().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const grid = $("#theaterRoomGrid");
  if (!rooms.length) {
    grid.innerHTML = `<div class="theater-room-empty"><div class="mark">🎭</div><p>还没有开始任何世界线。<br>点上面的按钮，开一个新的角色扮演吧。</p></div>`;
    return;
  }
  grid.innerHTML = "";
  rooms.forEach(room => {
    const card = document.createElement("div");
    card.className = "theater-room-card";
    const lastMsg = room.messages && room.messages.length ? room.messages[room.messages.length - 1] : null;
    const preview = lastMsg ? lastMsg.content : (room.setting || "还没有设定故事背景");
    const msgCount = room.messages ? room.messages.length : 0;
    card.innerHTML = `
      <div class="theater-room-card-title">${escapeHtml(room.title || "未命名世界线")}</div>
      <div class="theater-room-card-preview">${escapeHtml(preview || "")}</div>
      <div class="theater-room-card-meta">${msgCount} 条对话</div>
    `;
    card.onclick = () => enterTheaterRoom(room.id);
    grid.appendChild(card);
  });
}

function createTheaterRoom() {
  const rooms = getTheaterRooms();
  const room = {
    id: uid(), title: "新的世界线", setting: "", messages: [],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  rooms.push(room);
  saveTheaterRooms(rooms);
  enterTheaterRoom(room.id);
}

function enterTheaterRoom(id) {
  const room = getTheaterRoom(id);
  if (!room) return;
  theaterActiveRoomId = id;
  $("#theaterRoomListView").classList.add("hidden");
  $("#theaterRoomView").classList.remove("hidden");
  $("#theaterRenameBtn").style.display = "flex";
  $("#theaterDeleteBtn").style.display = "flex";
  $("#theaterHeaderTitle").innerText = "🎭 " + (room.title || "未命名世界线");
  $("#theaterSetting").value = room.setting || "";
  renderTheaterMessages();
  pushNavLayer(leaveTheaterRoomSilently);
}

function leaveTheaterRoomSilently() {
  theaterActiveRoomId = null;
  $("#theaterRoomListView").classList.remove("hidden");
  $("#theaterRoomView").classList.add("hidden");
  $("#theaterRenameBtn").style.display = "none";
  $("#theaterDeleteBtn").style.display = "none";
  $("#theaterHeaderTitle").innerText = "🎭 小剧场";
  renderTheaterRoomList();
}
function leaveTheaterRoom() { popNavLayerSilently(); leaveTheaterRoomSilently(); }

function renameTheaterRoom() {
  const room = getTheaterRoom(theaterActiveRoomId);
  if (!room) return;
  const name = prompt("给这个世界线起个名字：", room.title || "");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  room.title = trimmed;
  saveTheaterRooms(getTheaterRooms().map(r => r.id === room.id ? room : r));
  $("#theaterHeaderTitle").innerText = "🎭 " + room.title;
}

function deleteTheaterRoom() {
  const room = getTheaterRoom(theaterActiveRoomId);
  if (!room) return;
  if (!confirm(`确定要删除「${room.title}」这个世界线吗？里面的剧情不会保留。`)) return;
  const rooms = getTheaterRooms().filter(r => r.id !== room.id);
  saveTheaterRooms(rooms);
  leaveTheaterRoom();
  showToast("已删除");
}

function renderTheaterMessages() {
  const box = $("#theaterChatBox");
  const room = getTheaterRoom(theaterActiveRoomId);
  box.innerHTML = "";
  if (!room || !room.messages.length) {
    box.innerHTML = `<div class="empty-state"><div class="mark">🎭</div><p>设定一个故事背景，<br>和 Leith 开始一场不设限的角色扮演。</p></div>`;
    return;
  }
  room.messages.forEach(msg => {
    const row = document.createElement("div");
    row.className = `msg-row ${msg.role === "user" ? "user" : "assistant"}`;
    const bubble = document.createElement("div");
    bubble.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
    if (msg.role === "assistant") {
      bubble.innerHTML = renderBubbleContent(msg.content);
    } else {
      bubble.innerText = msg.content;
    }
    row.appendChild(bubble);
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}

async function sendTheaterMessage() {
  if (theaterCurrentController) return showToast("请等当前回复结束");
  if (!theaterActiveRoomId) return;

  const input = $("#theaterInput");
  const content = input.value.trim();
  if (!content) return;

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.8");

  if (!apiKey || !provider || !model) {
    return showToast("请先在设置里配置好服务商和密钥");
  }

  const roomId = theaterActiveRoomId;
  const room = getTheaterRoom(roomId);
  if (!room) return;
  if (!room.setting) return showToast("请先设定故事背景");

  const userMsg = { role: "user", content, _id: uid() };
  room.messages.push(userMsg);
  room.updatedAt = Date.now();
  saveTheaterRooms(getTheaterRooms().map(r => r.id === roomId ? room : r));
  input.value = "";
  input.style.height = "auto";
  renderTheaterMessages();

  // 显示 typing
  const box = $("#theaterChatBox");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  row.appendChild(bubble);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  const controller = new AbortController();
  theaterCurrentController = controller;

  // 剧场专用系统提示
  const theaterPrompt = `你现在在小剧场模式中。请完全按照以下世界线设定进行角色扮演，不要跳出角色，不要提及你是 AI。如果有不适合的内容，你可以委婉引导话题，但不要打破角色设定。\n\n【世界线设定】\n${room.setting}`;

  try {
    const messages = truncateMessagesForApi(room.messages).map(m => ({ role: m.role, content: m.content }));
    let fullReply = "";
    if (provider.apiStyle === "anthropic") {
      const result = await streamAnthropic({
        provider, apiKey, model, temp,
        systemPrompt: theaterPrompt,
        messages, controller,
        onDelta: (acc) => {
          bubble.innerHTML = renderBubbleContent(acc);
          box.scrollTop = box.scrollHeight;
        }
      });
      fullReply = result.text;
    } else {
      const result = await streamOpenAICompatible({
        provider, apiKey, model, temp,
        systemPrompt: theaterPrompt,
        messages, controller,
        onDelta: (acc) => {
          bubble.innerHTML = renderBubbleContent(acc);
          box.scrollTop = box.scrollHeight;
        }
      });
      fullReply = result.text;
    }

    // 只更新目标房间的数据，即使用户在等待期间切去了别的房间，也不会串数据
    const freshRoom = getTheaterRoom(roomId);
    if (freshRoom) {
      freshRoom.messages.push({ role: "assistant", content: fullReply, _id: uid() });
      freshRoom.updatedAt = Date.now();
      saveTheaterRooms(getTheaterRooms().map(r => r.id === roomId ? freshRoom : r));
      if (theaterActiveRoomId === roomId) renderTheaterMessages();
    }
  } catch (err) {
    if (err.name === "AbortError") {
      const partial = bubble.innerText;
      if (partial.trim()) {
        const freshRoom = getTheaterRoom(roomId);
        if (freshRoom) {
          freshRoom.messages.push({ role: "assistant", content: partial, _id: uid() });
          saveTheaterRooms(getTheaterRooms().map(r => r.id === roomId ? freshRoom : r));
          if (theaterActiveRoomId === roomId) renderTheaterMessages();
        }
      } else {
        row.remove();
      }
      showToast("已停止");
    } else {
      row.remove();
      showToast(err.message || "请求失败");
    }
  } finally {
    theaterCurrentController = null;
  }
}

// ============================================================
// 记忆可视化 app（虚实云图 + 分层列表，联动 Supabase）
// ============================================================
let memoryExpandedNodes = new Set(["profile", "core"]); // 默认展开的分支
let memoryAddTarget = ""; // 当前要添加记忆的分支
let memoryGraphTransform = { x: 0, y: 0, scale: .5 };
const memoryGraphPointers = new Map();
let memoryGraphGesture = null;
let memoryGraphDidMove = false;

function setMemoryView(mode) {
  const graphMode = mode !== 'list';
  $("#memoryGraphWrap").classList.toggle("hidden", !graphMode);
  $("#memoryTree").classList.toggle("hidden", graphMode);
  $("#memoryGraphViewBtn").classList.toggle("active", graphMode);
  $("#memoryListViewBtn").classList.toggle("active", !graphMode);
  if (graphMode) requestAnimationFrame(applyMemoryGraphTransform);
}

function clampMemoryGraphScale(scale) {
  return Math.max(.28, Math.min(3.5, scale));
}

function applyMemoryGraphTransform() {
  const wrap = $("#memoryGraphWrap");
  const viewport = $("#memoryGraphViewport");
  if (!wrap || !viewport) return;
  const cx = wrap.clientWidth / 2 + memoryGraphTransform.x;
  const cy = wrap.clientHeight / 2 + memoryGraphTransform.y;
  viewport.setAttribute("transform", `translate(${cx} ${cy}) scale(${memoryGraphTransform.scale})`);
}

function zoomMemoryGraph(factor, clientX, clientY) {
  const wrap = $("#memoryGraphWrap");
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
  const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const oldScale = memoryGraphTransform.scale;
  const newScale = clampMemoryGraphScale(oldScale * factor);
  const worldX = (px - centerX - memoryGraphTransform.x) / oldScale;
  const worldY = (py - centerY - memoryGraphTransform.y) / oldScale;
  memoryGraphTransform.x = px - centerX - worldX * newScale;
  memoryGraphTransform.y = py - centerY - worldY * newScale;
  memoryGraphTransform.scale = newScale;
  applyMemoryGraphTransform();
}

function resetMemoryGraph() {
  const wrap = $("#memoryGraphWrap");
  const available = wrap ? Math.min(wrap.clientWidth - 42, wrap.clientHeight - 48) : 380;
  const fitScale = Math.max(.34, Math.min(1.05, available / 760));
  memoryGraphTransform = { x: 0, y: 0, scale: fitScale };
  applyMemoryGraphTransform();
}

function closeMemoryNodeDetail() {
  $("#memoryNodeDetail").classList.add("hidden");
  $("#memoryGraphHint").classList.remove("hidden");
  document.querySelectorAll('.memory-graph-node.selected').forEach(node => node.classList.remove('selected'));
}

function showMemoryNodeDetail(branch, item) {
  const detail = $("#memoryNodeDetail");
  if (!detail) return;
  $("#memoryNodeDetailTitle").innerText = item
    ? `${branch.icon} ${branch.label}`
    : `${branch.icon} ${branch.label} · ${branch.items.length} 个节点`;
  $("#memoryNodeDetailContent").innerText = item
    ? item.content
    : (branch.virtual
      ? '这是一组由对话自然沉淀、会继续变化的虚记忆。'
      : '这是一组被主动保存、可以明确触碰的实记忆。');
  $("#memoryNodeDetailMeta").innerText = item && item.createdAt ? formatMemoryTime(item.createdAt) : '';
  detail.classList.remove("hidden");
  $("#memoryGraphHint").classList.add("hidden");
}

function createMemorySvgElement(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
  return el;
}

function appendMemoryGraphEdge(viewport, x1, y1, x2, y2, virtual, color, branchEdge = false, bend = 0) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const mx = (x1 + x2) / 2 - dy / length * bend;
  const my = (y1 + y2) / 2 + dx / length * bend;
  const edge = createMemorySvgElement('path', { d: `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}` });
  edge.setAttribute('class', `memory-edge${branchEdge ? ' branch-edge' : ''}${virtual ? ' virtual' : ''}`);
  if (color) edge.style.setProperty('--edge-color', color);
  viewport.appendChild(edge);
}

function appendMemoryGraphNode(viewport, { x, y, radius, label, sublabel, icon, color, virtual, branch, item, root }) {
  const group = createMemorySvgElement('g', { transform: `translate(${x} ${y})`, tabindex: 0 });
  group.setAttribute('class', `memory-graph-node${item ? ' item' : ''}${virtual ? ' virtual' : ''}`);
  if (color) group.style.setProperty('--node-color', color);

  if (root) {
    group.appendChild(createMemorySvgElement('circle', { cx: 0, cy: 0, r: radius + 18, class: 'memory-root-aura' }));
  }

  const circle = createMemorySvgElement('circle', { cx: 0, cy: 0, r: radius });
  circle.setAttribute('class', root ? 'memory-root-ring' : 'memory-node-halo');
  group.appendChild(circle);

  if (item) {
    group.appendChild(createMemorySvgElement('circle', { cx: 0, cy: 0, r: Math.max(1.5, radius * .3), class: 'memory-node-core' }));
    const title = createMemorySvgElement('title');
    title.textContent = item.content || '';
    group.appendChild(title);
  } else if (root) {
    group.appendChild(createMemorySvgElement('circle', { cx: 0, cy: 0, r: 4.2, class: 'memory-root-core' }));
  }

  if (icon) {
    const iconText = createMemorySvgElement('text', { x: 0, y: root ? 6 : (item ? 4 : 5), 'text-anchor': 'middle', 'font-size': root ? 22 : (item ? 9 : 15) });
    iconText.textContent = icon;
    iconText.style.pointerEvents = 'none';
    group.appendChild(iconText);
  }

  if (label) {
    const text = createMemorySvgElement('text', { x: 0, y: radius + 14 });
    text.setAttribute('class', `memory-node-label${item ? ' memory-item-caption' : ''}`);
    text.textContent = label;
    group.appendChild(text);
  }
  if (sublabel) {
    const sub = createMemorySvgElement('text', { x: 0, y: radius + 25 });
    sub.setAttribute('class', 'memory-node-sub');
    sub.textContent = sublabel;
    group.appendChild(sub);
  }

  if (branch) {
    const open = (event) => {
      event.stopPropagation();
      if (!memoryGraphDidMove) {
        document.querySelectorAll('.memory-graph-node.selected').forEach(node => node.classList.remove('selected'));
        group.classList.add('selected');
        showMemoryNodeDetail(branch, item || null);
      }
    };
    group.addEventListener('click', open);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    });
  }
  viewport.appendChild(group);
}

function renderMemoryGraph(branches) {
  const viewport = $("#memoryGraphViewport");
  if (!viewport) return;
  viewport.innerHTML = '';

  const defs = createMemorySvgElement('defs');
  defs.innerHTML = `
    <radialGradient id="memoryRootGlow"><stop offset="0" stop-color="#e7d9f8" stop-opacity=".28"/><stop offset=".5" stop-color="#ae86dc" stop-opacity=".18"/><stop offset="1" stop-color="#8e68bf" stop-opacity=".06"/></radialGradient>
    <filter id="memorySoftGlow" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  viewport.appendChild(defs);

  // 不再用整齐的“车轮辐条”。七个记忆域保持松散、略微不对称，像自然形成的星团。
  const anchors = [
    { x: -168, y: -184 }, { x: 38, y: -228 }, { x: 214, y: -92 },
    { x: 186, y: 126 }, { x: 42, y: 228 }, { x: -174, y: 166 },
    { x: -236, y: -22 }
  ];
  const branchPositions = [];
  branches.forEach((branch, index) => {
    const anchor = anchors[index % anchors.length];
    branch.virtual = ['diary', 'summary', 'short_term'].includes(branch.id);
    const bx = anchor.x;
    const by = anchor.y;
    const angle = Math.atan2(by, bx);
    branchPositions.push({ branch, angle, x: bx, y: by });
    appendMemoryGraphEdge(viewport, 0, 0, bx, by, branch.virtual, branch.color, true, index % 2 ? 20 : -20);

    // iOS 主屏幕模式保留完整列表，但星云首屏少画一些 SVG 节点，明显降低拖拽时的掉帧。
    const graphNodeLimit = document.documentElement.classList.contains('standalone-pwa') ? 24 : 42;
    const visibleItems = branch.items.slice(0, graphNodeLimit);
    visibleItems.forEach((item, itemIndex) => {
      const seedText = `${branch.id}:${item.id || item.createdAt || itemIndex}`;
      let seed = 0;
      for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
      const jitter = ((seed % 1000) / 1000 - .5);
      const leafAngle = angle + Math.PI + itemIndex * 2.399963 + jitter * .48;
      const leafDistance = 48 + Math.sqrt(itemIndex + 1) * 13.5 + (seed % 17);
      const x = bx + Math.cos(leafAngle) * leafDistance;
      const y = by + Math.sin(leafAngle) * leafDistance * .82;
      appendMemoryGraphEdge(viewport, bx, by, x, y, branch.virtual, branch.color, false, jitter * 13);
      const preview = (item.content || '').replace(/\s+/g, ' ').trim();
      appendMemoryGraphNode(viewport, {
        x, y,
        radius: Math.min(7.2, 3.2 + Math.sqrt(preview.length || 1) / 5.5),
        label: preview.length > 11 ? preview.slice(0, 11) + '…' : preview,
        icon: '', color: branch.color, virtual: branch.virtual, branch, item
      });
    });
  });

  branchPositions.forEach(({ branch, x, y }) => {
    appendMemoryGraphNode(viewport, {
      x, y, radius: 23,
      label: branch.label.replace(/（.*?）/g, ''),
      sublabel: `${branch.items.length} 段`,
      icon: branch.icon, color: branch.color, virtual: branch.virtual, branch
    });
  });

  appendMemoryGraphNode(viewport, {
    x: 0, y: 0, radius: 27, label: 'Leith 的记忆', icon: '', root: true
  });
  requestAnimationFrame(resetMemoryGraph);
}

function initMemoryGraphGestures() {
  const svg = $("#memoryGraphSvg");
  if (!svg) return;

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomMemoryGraph(event.deltaY < 0 ? 1.13 : .885, event.clientX, event.clientY);
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    svg.setPointerCapture(event.pointerId);
    memoryGraphPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    memoryGraphDidMove = false;
    svg.classList.add('dragging');
    if (memoryGraphPointers.size === 1) {
      memoryGraphGesture = {
        type: 'pan', startX: event.clientX, startY: event.clientY,
        originX: memoryGraphTransform.x, originY: memoryGraphTransform.y
      };
    } else if (memoryGraphPointers.size === 2) {
      const points = Array.from(memoryGraphPointers.values());
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      memoryGraphGesture = {
        type: 'pinch', distance: Math.hypot(dx, dy), scale: memoryGraphTransform.scale,
        midX: (points[0].x + points[1].x) / 2,
        midY: (points[0].y + points[1].y) / 2
      };
    }
  });

  svg.addEventListener('pointermove', (event) => {
    if (!memoryGraphPointers.has(event.pointerId)) return;
    memoryGraphPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (memoryGraphPointers.size >= 2) {
      const points = Array.from(memoryGraphPointers.values()).slice(0, 2);
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      if (!memoryGraphGesture || memoryGraphGesture.type !== 'pinch') return;
      const targetScale = clampMemoryGraphScale(memoryGraphGesture.scale * distance / Math.max(1, memoryGraphGesture.distance));
      const factor = targetScale / memoryGraphTransform.scale;
      const midX = (points[0].x + points[1].x) / 2;
      const midY = (points[0].y + points[1].y) / 2;
      zoomMemoryGraph(factor, midX, midY);
      memoryGraphDidMove = true;
    } else if (memoryGraphGesture && memoryGraphGesture.type === 'pan') {
      const dx = event.clientX - memoryGraphGesture.startX;
      const dy = event.clientY - memoryGraphGesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) memoryGraphDidMove = true;
      memoryGraphTransform.x = memoryGraphGesture.originX + dx;
      memoryGraphTransform.y = memoryGraphGesture.originY + dy;
      applyMemoryGraphTransform();
    }
  });

  const endPointer = (event) => {
    memoryGraphPointers.delete(event.pointerId);
    if (!memoryGraphPointers.size) {
      memoryGraphGesture = null;
      svg.classList.remove('dragging');
    } else {
      const point = Array.from(memoryGraphPointers.values())[0];
      memoryGraphGesture = {
        type: 'pan', startX: point.x, startY: point.y,
        originX: memoryGraphTransform.x, originY: memoryGraphTransform.y
      };
    }
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
}

function initMemoryApp() {
  // 刷新按钮
  const refreshBtn = $("#memoryRefreshBtn");
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      renderMemoryTree();
      showToast("已刷新");
    };
  }

  $("#memoryGraphViewBtn").onclick = () => setMemoryView('graph');
  $("#memoryListViewBtn").onclick = () => setMemoryView('list');
  $("#memoryGraphZoomInBtn").onclick = () => zoomMemoryGraph(1.2);
  $("#memoryGraphZoomOutBtn").onclick = () => zoomMemoryGraph(1 / 1.2);
  $("#memoryGraphResetBtn").onclick = resetMemoryGraph;
  $("#memoryNodeDetailCloseBtn").onclick = closeMemoryNodeDetail;
  initMemoryGraphGestures();

  // 添加记忆弹窗 — 取消
  $("#memoryAddCancelBtn").onclick = () => {
    popNavLayerSilently();
    $("#memoryAddModal").classList.add("hidden");
    $("#memoryAddInput").value = "";
    memoryAddTarget = "";
  };

  // 添加记忆弹窗 — 确认
  $("#memoryAddConfirmBtn").onclick = async () => {
    const val = $("#memoryAddInput").value.trim();
    if (!val) return;
    if (!window.Memory) return;

    if (memoryAddTarget === "profile") {
      await window.Memory.addProfile(val);
    } else if (memoryAddTarget === "core") {
      await window.Memory.add(val);
    } else if (memoryAddTarget === "reading") {
      await window.Memory.addReading(val);
    } else if (memoryAddTarget === "archive") {
      await window.Memory.addArchive(val);
    }
    popNavLayerSilently();
    $("#memoryAddModal").classList.add("hidden");
    $("#memoryAddInput").value = "";
    memoryAddTarget = "";
    renderMemoryTree();
    showToast("已添加");
  };

  // 点击遮罩关闭
  $("#memoryAddModal").addEventListener("click", (e) => {
    if (e.target.id === "memoryAddModal") {
      popNavLayerSilently();
      $("#memoryAddModal").classList.add("hidden");
      memoryAddTarget = "";
    }
  });
}

function openMemoryAddModal(branch) {
  memoryAddTarget = branch;
  const titles = {
    profile: "👤 添加人设档案",
    core: "💎 添加核心记忆",
    reading: "📖 添加共读记录",
    archive: "📨 添加归档信件"
  };
  const placeholders = {
    profile: "精简事实，如：喜欢猫、不喜欢早起...",
    core: "重要的事，如：上次聊到了XX...",
    reading: "读书时的感想或进度，如：聊到主角决定原谅她了...",
    archive: "完整原文，不进上下文，仅可查看..."
  };
  $("#memoryAddModalTitle").innerText = titles[branch] || "添加记忆";
  $("#memoryAddInput").placeholder = placeholders[branch] || "写下要记住的内容...";
  $("#memoryAddInput").value = "";
  $("#memoryAddModal").classList.remove("hidden");
  pushNavLayer(() => { $("#memoryAddModal").classList.add("hidden"); memoryAddTarget = ""; });
  setTimeout(() => $("#memoryAddInput").focus(), 100);
}

async function renderMemoryTree() {
  const container = $("#memoryTree");
  if (!container) return;

  if (!window.Memory) {
    container.innerHTML = `<div class="mem-loading">记忆系统未加载</div>`;
    return;
  }

  container.innerHTML = `<div class="mem-loading"><div class="spin"></div><br>正在从云端加载记忆...</div>`;

  const threadId = getActiveThreadId();

  // 并行加载所有分支
  const [profileList, coreList, diaryList, summaryList, archiveList, shortTermList, readingList] = await Promise.all([
    window.Memory.listProfile(),
    window.Memory.list(),
    window.Memory.listDiaries ? window.Memory.listDiaries(60) : Promise.resolve([]),
    window.Memory.isReady() ? window.Memory.listSummary(threadId) : Promise.resolve([]),
    window.Memory.listArchive(),
    window.Memory.isReady() ? window.Memory.listShortTermDetail(threadId, 30) : Promise.resolve([]),
    window.Memory.listReading ? window.Memory.listReading() : Promise.resolve([])
  ]);

  const connected = window.Memory.isReady && window.Memory.isReady();

  // 树的根
  let html = '';

  // 根节点
  html += `<div class="mem-node expanded">
    <div class="mem-node-row" onclick="toggleMemNode(this)">
      <div class="mem-toggle" style="visibility:hidden;">▶</div>
      <div class="mem-icon" style="background:linear-gradient(135deg,var(--accent),var(--accent-dim));">🧠</div>
      <div class="mem-label">Leith 的记忆${connected ? '' : '（本地模式）'}</div>
    </div>
    <div class="mem-children" style="display:flex;margin-left:0;padding-left:0;border:none;">`;

  // 分支定义
  const branches = [
    { id: "profile", icon: "👤", label: "人设档案", color: "#6B9BD2", bgColor: "rgba(107,155,210,.12)", items: profileList, canAdd: true },
    { id: "diary", icon: "📔", label: "日记（每日自动生成）", color: "#C98A5E", bgColor: "rgba(201,138,94,.12)", items: diaryList, canAdd: false },
    { id: "core", icon: "💎", label: "核心记忆", color: "#DBA95A", bgColor: "rgba(219,169,90,.12)", items: coreList, canAdd: true },
    { id: "reading", icon: "📖", label: "共读记录", color: "#7FA97F", bgColor: "rgba(127,169,127,.12)", items: readingList, canAdd: true },
    { id: "summary", icon: "💬", label: "对话摘要（旧版）", color: "#7B8EC4", bgColor: "rgba(123,142,196,.12)", items: summaryList, canAdd: false },
    { id: "short_term", icon: "💭", label: "近期对话", color: "#D9708C", bgColor: "rgba(217,112,140,.12)", items: shortTermList, canAdd: false },
    { id: "archive", icon: "📨", label: "归档信件", color: "#4A5A8A", bgColor: "rgba(74,90,138,.12)", items: archiveList, canAdd: true },
  ];

  branches.forEach(branch => {
    const expanded = memoryExpandedNodes.has(branch.id);
    const count = branch.items.length;
    html += `<div class="mem-node${expanded ? ' expanded' : ''}" data-branch="${branch.id}">
      <div class="mem-node-row" onclick="toggleMemNode(this)">
        <div class="mem-toggle${count === 0 ? ' leaf' : ''}">▶</div>
        <div class="mem-icon" style="background:${branch.bgColor};">${branch.icon}</div>
        <div class="mem-label">${branch.label}</div>
        ${count > 0 ? `<div class="mem-count">${count}</div>` : ''}
        ${branch.canAdd ? `<button class="mem-add-btn" onclick="event.stopPropagation();openMemoryAddModal('${branch.id}')">+</button>` : ''}
      </div>
      <div class="mem-children">`;

    if (count === 0) {
      html += `<div class="mem-empty-leaf">暂无${branch.label}</div>`;
    } else {
      // 对话摘要和近期对话倒序显示（最新的在上面）
      const displayItems = branch.id === "summary" || branch.id === "short_term"
        ? branch.items
        : branch.items;
      
      displayItems.forEach(item => {
        const timeStr = item.createdAt ? formatMemoryTime(item.createdAt) : "";
        const roleLabel = branch.id === "short_term" && item.role
          ? (item.role === "assistant" ? "Leith" : "我")
          : "";
        const contentPreview = item.content.length > 200
          ? item.content.slice(0, 200) + "..."
          : item.content;

        html += `<div class="mem-leaf" data-leaf-id="${item.id}" data-branch="${branch.id}">
          <div class="mem-leaf-dot" style="background:${branch.color};"></div>
          <div style="flex:1;min-width:0;">
            <div class="mem-leaf-content">${roleLabel ? `<span style="color:${branch.color};font-weight:600;font-family:'Noto Sans SC',sans-serif;font-size:11px;">${roleLabel}：</span>` : ""}${escapeHtml(contentPreview)}</div>
            ${timeStr ? `<div class="mem-leaf-meta">${timeStr}</div>` : ''}
          </div>
          ${branch.id === "diary" ? `<div class="mem-leaf-actions">
            <button class="mem-leaf-rewrite" onclick="event.stopPropagation();rewriteDiaryLeaf('${item.id}','${item.dateStr || ""}')" title="再写一次">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 4v6h-6"/></svg>
            </button>
            <button class="mem-leaf-del" onclick="event.stopPropagation();deleteMemoryLeaf('${item.id}','${branch.id}')" title="删除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
            </button>
          </div>` : branch.canAdd ? `<button class="mem-leaf-del" onclick="event.stopPropagation();deleteMemoryLeaf('${item.id}','${branch.id}')" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
          </button>` : ''}
        </div>`;
      });
    }

    html += `</div></div>`;
  });

  html += `</div></div>`;

  container.innerHTML = html;
  renderMemoryGraph(branches);
}

function toggleMemNode(rowEl) {
  const node = rowEl.closest(".mem-node");
  if (!node) return;
  const branchId = node.dataset.branch;
  const isExpanded = node.classList.contains("expanded");
  if (isExpanded) {
    node.classList.remove("expanded");
    if (branchId) memoryExpandedNodes.delete(branchId);
  } else {
    node.classList.add("expanded");
    if (branchId) memoryExpandedNodes.add(branchId);
  }
}

async function deleteMemoryLeaf(id, branch) {
  if (!window.Memory) return;
  if (!confirm("删除这条记忆？")) return;

  if (branch === "profile") {
    await window.Memory.removeProfile(id);
  } else if (branch === "core") {
    await window.Memory.remove(id);
  } else if (branch === "reading") {
    await window.Memory.removeReading(id);
  } else if (branch === "archive") {
    await window.Memory.removeArchive(id);
  } else if (branch === "diary") {
    if (window.Memory.removeDiary) {
      await window.Memory.removeDiary(id);
    } else {
      const client = window.getSupabaseClient ? window.getSupabaseClient() : null;
      if (client) await client.from('diary_entries').delete().eq('id', parseInt(id, 10));
    }
  } else {
    // summary / short_term — 直接用 Supabase client 删
    const client = window.getSupabaseClient ? window.getSupabaseClient() : null;
    if (client) {
      const numId = parseInt(id, 10);
      if (!isNaN(numId)) {
        try { await client.from('memories').delete().eq('id', numId); } catch (e) {}
      }
    }
  }
  renderMemoryTree();
  showToast("已删除");
}

async function rewriteDiaryLeaf(id, dateStr) {
  if (!dateStr) return showToast("找不到这天的日期");
  if (!window.Memory?.isReady?.()) return showToast("云端记忆还没连上");
  if (!confirm(`重新写 ${dateStr} 的日记？`)) return;
  return await rewriteDiaryByDate(dateStr);
}

async function rewriteDiaryByDate(dateStr) {
  if (!dateStr) return false;
  if (!window.Memory?.isReady?.()) {
    showToast("云端记忆还没连上");
    return false;
  }
  showToast(`正在重写 ${dateStr} 的日记...`);
  clearDiaryFailureCooling(dateStr);
  if (getLastDiaryDate() === dateStr) localStorage.removeItem(DIARY_LAST_DATE_LS);
  showDiarySplash();
  let ok = null;
  try {
    ok = await tryGenerateDiaryNowFor(dateStr, { forceRewrite: true });
  } finally {
    hideDiarySplash();
  }
  if ($("#memoryTree")) renderMemoryTree();
  if ($("#diaryBookPage")) await renderDiaryBook();
  showToast(ok === "partial" ? "日记已重写一部分，内容太长可再点一次继续" : ok ? "日记已重新写好" : "这次没写成，稍后可再试");
  return Boolean(ok);
}

let diaryBookEntries = [];
let diaryBookIndex = 0;

function getDiaryBookNotes() {
  return loadJSON(LS.diaryNotes, {});
}

function setDiaryBookNote(dateStr, text) {
  const notes = getDiaryBookNotes();
  if (text && text.trim()) notes[dateStr] = { text: text.trim(), updatedAt: Date.now() };
  else delete notes[dateStr];
  saveJSON(LS.diaryNotes, notes);
}

async function renderDiaryBook() {
  const page = $("#diaryBookPage");
  if (!page) return;
  if (!window.Memory || !window.Memory.listDiaries || !window.Memory.isReady?.()) {
    page.innerHTML = `<div class="diarybook-empty">云端记忆还没连上，日记本暂时打不开。</div>`;
    return;
  }
  page.innerHTML = `<div class="diarybook-empty">正在翻开日记本...</div>`;
  diaryBookEntries = await window.Memory.listDiaries(120);
  if (diaryBookIndex >= diaryBookEntries.length) diaryBookIndex = Math.max(0, diaryBookEntries.length - 1);
  renderDiaryBookPage();
}

function renderDiaryBookPage() {
  const page = $("#diaryBookPage");
  const label = $("#diaryBookPageLabel");
  if (!page) return;
  if (!diaryBookEntries.length) {
    page.innerHTML = `<div class="diarybook-empty">还没有日记。等 Leith 写下第一天，这里就会多一页。</div>`;
    if (label) label.innerText = "0 / 0";
    return;
  }
  const entry = diaryBookEntries[diaryBookIndex];
  const note = getDiaryBookNotes()[entry.dateStr]?.text || "";
  page.innerHTML = `<div class="diarybook-page">
    <div class="diarybook-date">${escapeHtml(entry.dateStr)}</div>
    <div class="diarybook-content">${escapeHtml(entry.content || "平淡的一天")}</div>
    ${note ? `<div class="diarybook-note">${escapeHtml(note)}</div>` : ""}
    <div class="diarybook-sign">Leith · ${escapeHtml(entry.dateStr)}</div>
  </div>`;
  if (label) label.innerText = `${diaryBookIndex + 1} / ${diaryBookEntries.length}`;
}

function initDiaryBookControls() {
  const prev = $("#diaryBookPrevBtn");
  const next = $("#diaryBookNextBtn");
  const annotate = $("#diaryBookAnnotateBtn");
  const write = $("#diaryBookWriteBtn");
  const rewrite = $("#diaryBookRewriteBtn");
  if (prev) prev.onclick = () => {
    if (!diaryBookEntries.length) return;
    diaryBookIndex = Math.min(diaryBookEntries.length - 1, diaryBookIndex + 1);
    renderDiaryBookPage();
  };
  if (next) next.onclick = () => {
    if (!diaryBookEntries.length) return;
    diaryBookIndex = Math.max(0, diaryBookIndex - 1);
    renderDiaryBookPage();
  };
  if (annotate) annotate.onclick = () => {
    const entry = diaryBookEntries[diaryBookIndex];
    if (!entry) return showToast("还没有可批注的日记");
    const old = getDiaryBookNotes()[entry.dateStr]?.text || "";
    const text = prompt("给这页写一句批注；留空会删除批注。", old);
    if (text === null) return;
    setDiaryBookNote(entry.dateStr, text);
    renderDiaryBookPage();
    showToast(text.trim() ? "批注已写好" : "批注已删除");
  };
  if (write) write.onclick = async () => {
    const dateStr = getLastCompletedDiaryDateStr();
    if (window.Memory?.hasDailyDiary && await window.Memory.hasDailyDiary(dateStr)) {
      showToast(`${dateStr} 的日记已经写好了，不会重复生成`);
      await renderDiaryBook();
      return;
    }
    write.disabled = true;
    showToast(`正在补写 ${dateStr} 的日记...`);
    showDiarySplash();
    let ok = false;
    try {
      clearDiaryFailureCooling(dateStr);
      ok = await processDayEnd(dateStr);
    } finally {
      hideDiarySplash();
      write.disabled = false;
    }
    await renderDiaryBook();
    showToast(ok && await window.Memory.hasDailyDiary(dateStr)
      ? `${dateStr} 的日记写好了`
      : "这次没写成，请检查网络、模型设置或当天是否有聊天记录");
  };
  if (rewrite) rewrite.onclick = async () => {
    const entry = diaryBookEntries[diaryBookIndex];
    if (!entry) return showToast("还没有可重写的日记");
    if (!confirm(`重新生成 ${entry.dateStr} 这一页？`)) return;
    await rewriteDiaryByDate(entry.dateStr);
  };
}

function closetColor(value, fallback = "#c8b7ad") {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(text) ? text : fallback;
}

function renderClosetVisual(item, mode = "doll") {
  if (!item) return "";
  if (mode !== "doll" && (item.thumbnail || item.asset)) {
    const src = String(item.thumbnail || item.asset).replace(/["'<>]/g, "");
    return `<img class="closet-asset-preview" src="${src}" alt="${escapeHtml(item.name || "衣物")}" loading="lazy">`;
  }
  // 图片衣物属于 1024px 分层人物坐标系，不能塞进旧 SVG 纸娃娃坐标系；
  // 有基础人物包时会由 renderRasterPaperDoll 单独叠放。
  if (mode === "doll" && item.asset) return "";
  const c = closetColor(item.color);
  const a = closetColor(item.accent, "#f4eadc");
  const stroke = "rgba(55,43,42,.24)";
  const visual = item.visual || inferClosetVisual(item);
  const doll = {
    "cardigan": `<path d="M49 92h42l9 58H40z" fill="${a}" stroke="${stroke}"/><path d="M47 94c-13 13-17 38-12 61" fill="none" stroke="${c}" stroke-width="13" stroke-linecap="round"/><path d="M93 94c13 13 17 38 12 61" fill="none" stroke="${c}" stroke-width="13" stroke-linecap="round"/><path d="M55 92l15 57 15-57" fill="${c}" opacity=".86"/><path d="M70 98v47" stroke="rgba(255,255,255,.45)" stroke-width="2"/><circle cx="70" cy="117" r="1.6" fill="rgba(70,55,52,.38)"/><circle cx="70" cy="130" r="1.6" fill="rgba(70,55,52,.38)"/>`,
    "boyfriend-shirt": `<path d="M47 91h46l9 60H38z" fill="${c}" stroke="${stroke}"/><path d="M57 91l13 15 13-15" fill="${a}" stroke="${stroke}"/><path d="M70 104v45" stroke="${a}" stroke-width="2.4"/><path d="M42 100c-11 15-14 35-9 57M98 100c11 15 14 35 9 57" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round"/><path d="M43 151c14 6 39 7 55 0" fill="none" stroke="${stroke}" stroke-width="1.4"/>`,
    "hoodie": `<path d="M48 96c5-13 39-13 44 0l9 56H39z" fill="${c}" stroke="${stroke}"/><path d="M56 96c4-9 24-9 28 0 0 9-28 9-28 0z" fill="${a}" opacity=".55"/><path d="M43 103c-13 15-14 35-8 54M97 103c13 15 14 35 8 54" fill="none" stroke="${c}" stroke-width="14" stroke-linecap="round"/><path d="M59 122h22" stroke="${a}" stroke-width="2" stroke-linecap="round"/><path d="M61 103l-5 14M79 103l5 14" stroke="${a}" stroke-width="1.8" stroke-linecap="round"/>`,
    "pleated-skirt": `<path d="M43 145h54l13 44c-22 8-56 8-80 0z" fill="${c}" stroke="${stroke}"/><path d="M53 149l-8 39M65 148l-3 43M77 148l4 43M89 149l9 39" stroke="${a}" stroke-opacity=".42" stroke-width="1.5"/><path d="M43 145h54" stroke="${a}" stroke-width="4"/>`,
    "shorts": `<path d="M46 145h48l5 39H75l-5-24-5 24H41z" fill="${c}" stroke="${stroke}"/><path d="M70 147v16" stroke="${a}" stroke-opacity=".5" stroke-width="2"/><path d="M51 153h12M77 153h12" stroke="${a}" stroke-opacity=".45" stroke-width="1.5"/>`,
    "slip-dress": `<path d="M55 92h30l8 50 22 66c-27 9-63 9-90 0l22-66z" fill="${c}" stroke="${stroke}"/><path d="M55 92l15 18 15-18" fill="${a}" opacity=".42"/><path d="M54 93L43 78M86 93l11-15" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/><path d="M43 150c18 9 37 9 54 0" fill="none" stroke="${a}" stroke-opacity=".45" stroke-width="1.6"/>`,
    "mini-dress": `<path d="M48 93h44l8 49 14 43c-26 11-62 11-88 0l14-43z" fill="${c}" stroke="${stroke}"/><path d="M50 95c11 10 29 10 40 0" fill="none" stroke="${a}" stroke-width="3"/><path d="M40 106c-9 13-11 31-6 48M100 106c9 13 11 31 6 48" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"/><path d="M43 144h54" stroke="${a}" stroke-opacity=".36" stroke-width="4"/>`,
    "mary-jane": `<path d="M40 205h30c2 5-1 10-8 10H39c-3-3-3-7 1-10zM70 205h30c4 3 4 7 1 10H78c-7 0-10-5-8-10z" fill="${c}" stroke="${stroke}"/><path d="M48 205c4 4 10 4 15 0M78 205c4 4 10 4 15 0" fill="none" stroke="${a}" stroke-width="2"/>`,
    "loafers": `<path d="M39 204h31c4 4 2 11-6 11H39c-5-4-5-8 0-11zM70 204h31c5 3 5 7 0 11H76c-8 0-10-7-6-11z" fill="${c}" stroke="${stroke}"/><path d="M48 207h14M79 207h14" stroke="${a}" stroke-opacity=".45" stroke-width="2"/>`,
    "pearl-necklace": `<path d="M55 89c8 9 22 9 30 0" fill="none" stroke="${a}" stroke-width="2"/><circle cx="70" cy="96" r="4.5" fill="${c}" stroke="${stroke}"/><circle cx="61" cy="92" r="2.2" fill="${c}"/><circle cx="79" cy="92" r="2.2" fill="${c}"/>`,
    "beret": `<path d="M36 35c17-18 51-20 70 0 4 10-13 18-37 18-23 0-39-7-33-18z" fill="${c}" stroke="${stroke}"/><path d="M77 24c7-6 15-8 23-5" fill="none" stroke="${a}" stroke-width="3" stroke-linecap="round"/>`,
    "tote": `<path d="M104 126c16 8 20 38 10 54" fill="none" stroke="${a}" stroke-width="9" stroke-linecap="round"/><rect x="101" y="151" width="27" height="38" rx="8" fill="${c}" stroke="${stroke}"/><path d="M108 162h13" stroke="${a}" stroke-opacity=".55" stroke-width="2"/>`
  };
  if (mode === "doll") return doll[visual] || "";
  const preview = {
    "cardigan": `<path d="M22 18h36l8 48H14z" fill="${a}" stroke="${stroke}"/><path d="M22 21c-10 8-13 24-11 39M58 21c10 8 13 24 11 39" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/><path d="M28 18l12 46 12-46" fill="${c}"/><path d="M40 24v36" stroke="rgba(255,255,255,.5)" stroke-width="2"/>`,
    "boyfriend-shirt": `<path d="M18 17h44l9 50H9z" fill="${c}" stroke="${stroke}"/><path d="M28 17l12 13 12-13" fill="${a}"/><path d="M40 30v35" stroke="${a}" stroke-width="2"/><path d="M17 25c-8 10-10 22-7 37M63 25c8 10 10 22 7 37" fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round"/>`,
    "hoodie": `<path d="M18 25c3-16 41-16 44 0l8 42H10z" fill="${c}" stroke="${stroke}"/><path d="M27 25c4-10 22-10 26 0 0 8-26 8-26 0z" fill="${a}" opacity=".55"/><path d="M18 29c-9 10-10 22-7 34M62 29c9 10 10 22 7 34" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round"/><path d="M30 44h20" stroke="${a}" stroke-width="2"/>`,
    "pleated-skirt": `<path d="M15 21h50l11 43c-22 9-51 9-72 0z" fill="${c}" stroke="${stroke}"/><path d="M26 24l-7 39M38 23l-2 42M50 23l4 42M62 24l8 39" stroke="${a}" stroke-opacity=".5" stroke-width="1.6"/><path d="M15 21h50" stroke="${a}" stroke-width="4"/>`,
    "shorts": `<path d="M14 22h52l5 39H47l-7-21-7 21H9z" fill="${c}" stroke="${stroke}"/><path d="M40 24v16" stroke="${a}" stroke-opacity=".5" stroke-width="2"/><path d="M19 31h12M49 31h12" stroke="${a}" stroke-opacity=".45" stroke-width="1.5"/>`,
    "slip-dress": `<path d="M27 15h26l8 30 14 28c-22 8-49 8-70 0l14-28z" fill="${c}" stroke="${stroke}"/><path d="M27 15l13 14 13-14" fill="${a}" opacity=".45"/><path d="M27 15L18 5M53 15l9-10" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`,
    "mini-dress": `<path d="M18 16h44l6 29 12 24c-24 9-56 9-80 0l12-24z" fill="${c}" stroke="${stroke}"/><path d="M20 18c11 9 29 9 40 0" fill="none" stroke="${a}" stroke-width="3"/><path d="M14 25c-7 9-8 21-5 33M66 25c7 9 8 21 5 33" fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round"/>`,
    "mary-jane": `<path d="M7 36h29c3 7-1 14-10 14H8c-5-4-5-10-1-14zM44 36h29c4 4 5 10 0 14H55c-9 0-13-7-11-14z" fill="${c}" stroke="${stroke}"/><path d="M15 36c4 4 10 4 15 0M52 36c4 4 10 4 15 0" fill="none" stroke="${a}" stroke-width="2"/>`,
    "loafers": `<path d="M7 35h30c4 6 1 14-9 14H7c-5-4-5-10 0-14zM43 35h30c5 4 5 10 0 14H52c-10 0-13-8-9-14z" fill="${c}" stroke="${stroke}"/><path d="M15 39h16M51 39h16" stroke="${a}" stroke-opacity=".45" stroke-width="2"/>`,
    "pearl-necklace": `<path d="M20 24c10 14 30 14 40 0" fill="none" stroke="${a}" stroke-width="3"/><circle cx="40" cy="41" r="6" fill="${c}" stroke="${stroke}"/><circle cx="29" cy="33" r="3" fill="${c}"/><circle cx="51" cy="33" r="3" fill="${c}"/>`,
    "beret": `<path d="M12 35c14-24 42-26 58 0 4 13-10 22-30 22s-34-9-28-22z" fill="${c}" stroke="${stroke}"/><path d="M45 17c8-6 16-7 23-3" fill="none" stroke="${a}" stroke-width="3" stroke-linecap="round"/>`,
    "tote": `<path d="M28 20c0-10 24-10 24 0" fill="none" stroke="${a}" stroke-width="6" stroke-linecap="round"/><rect x="20" y="25" width="40" height="42" rx="9" fill="${c}" stroke="${stroke}"/><path d="M29 40h22" stroke="${a}" stroke-opacity=".55" stroke-width="3"/>`
  };
  return `<svg class="closet-item-svg" viewBox="0 0 80 80" aria-hidden="true">${preview[visual] || preview.cardigan}</svg>`;
}

function renderRasterPaperDoll() {
  migrateLegacyClosetItemsForRaster();
  const base = getBundledWardrobeCatalog().base;
  if (!base?.layers?.length || !base.canvas || !base.crop) return "";
  const equipped = Object.fromEntries(getEquippedClosetItems().map(x => [x.slot, x.item]));
  const layerPriority = { socks: 10, shoes: 20, bottom: 30, top: 40, dress: 50, set: 55, accessory: 70, bag: 80, hat: 90 };
  const selectedItems = Object.entries(equipped)
    .filter(([, item]) => Boolean(item))
    .sort(([slotA], [slotB]) => (layerPriority[slotA] || 60) - (layerPriority[slotB] || 60))
    .map(([, item]) => item);
  // 资源包存在时始终显示 PNG 人物。无法叠放的旧 SVG 商品忽略即可，不能让
  // 一件旧衣服把人物整体切回矢量占位图。
  const rasterItems = selectedItems.filter(item => item.asset);

  const canvasWidth = Number(base.canvas[0]) || 1024;
  const canvasHeight = Number(base.canvas[1]) || 1024;
  const crop = base.crop;
  const cropWidth = Number(crop.width) || canvasWidth;
  const cropHeight = Number(crop.height) || canvasHeight;
  const imageStyle = `width:${canvasWidth / cropWidth * 100}%;height:${canvasHeight / cropHeight * 100}%;left:${-Number(crop.x || 0) / cropWidth * 100}%;top:${-Number(crop.y || 0) / cropHeight * 100}%;`;
  const dress = equipped.set || equipped.dress;
  const replacements = {
    topwear: dress || equipped.top,
    bottomwear: dress ? { skip: true } : equipped.bottom,
    footwear: equipped.shoes,
    headwear: equipped.hat,
  };
  const placed = new Set();
  const layers = [];
  [...base.layers].sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).forEach(layer => {
    const semantic = String(layer.name || "").toLowerCase().replace(/[\s_-]+/g, "");
    const replacement = replacements[semantic];
    if (replacement?.skip) return;
    if (replacement?.asset) {
      if (!placed.has(replacement.id)) {
        layers.push({ asset: replacement.asset, name: replacement.name, anchor: replacement.anchor });
        placed.add(replacement.id);
      }
      return;
    }
    layers.push({ asset: layer.asset, name: layer.name, anchor: layer.anchor });
  });
  rasterItems.forEach(item => {
    if (item.asset && !placed.has(item.id)) layers.push({ asset: item.asset, name: item.name, anchor: item.anchor });
  });
  const images = layers.map((layer, index) => {
    const src = String(layer.asset || "").replace(/["'<>]/g, "");
    const anchor = layer.anchor || {};
    const dx = Number(anchor.x || 0);
    const dy = Number(anchor.y || 0);
    const scale = Number(anchor.scale || 1);
    const layerZ = Number(anchor.layer || 0);
    const transform = `translate(${dx / cropWidth * 100}%,${dy / cropHeight * 100}%) scale(${scale})`;
    return `<img src="${src}" alt="" style="${imageStyle}z-index:${layerZ || index + 1};transform:${transform};transform-origin:center center;">`;
  }).join("");
  return `<div class="paper-doll-raster" style="--doll-ratio:${cropWidth / cropHeight};" role="img" aria-label="Susie 的分层人物">${images}</div>`;
}

function renderPaperDollSvg() {
  const equipped = Object.fromEntries(getEquippedClosetItems().map(x => [x.slot, x.item]));
  const top = equipped.top;
  const bottom = equipped.bottom;
  const dress = equipped.dress;
  const shoes = equipped.shoes;
  const accessory = equipped.accessory;
  const hat = equipped.hat;
  const bag = equipped.bag;
  const defaultTop = { name: "奶油白居家衫", color: "#f7eee0", accent: "#d9c9b6", visual: "boyfriend-shirt" };
  const defaultBottom = { name: "柔雾短裤", color: "#d8cfc2", accent: "#f4eadc", visual: "shorts" };
  const defaultShoes = { name: "雾灰居家鞋", color: "#9a9290", accent: "#dcd4cc", visual: "mary-jane" };
  return `<svg class="paper-doll" viewBox="0 0 140 260" role="img" aria-label="Susie 的纸娃娃">
    <defs>
      <linearGradient id="skinDoll" x1="0" x2=".82" y1="0" y2="1"><stop stop-color="#ffe9d5"/><stop offset=".58" stop-color="#f6d4bd"/><stop offset="1" stop-color="#eebda7"/></linearGradient>
      <linearGradient id="hairDoll" x1=".1" x2=".9" y1="0" y2="1"><stop stop-color="#292326"/><stop offset=".5" stop-color="#403638"/><stop offset="1" stop-color="#211d20"/></linearGradient>
      <linearGradient id="innerDoll" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#fff9f0"/><stop offset="1" stop-color="#eadccf"/></linearGradient>
      <radialGradient id="cheekDoll"><stop stop-color="#db8f94" stop-opacity=".42"/><stop offset="1" stop-color="#db8f94" stop-opacity="0"/></radialGradient>
    </defs>
    <ellipse cx="70" cy="237" rx="29" ry="6" fill="rgba(73,54,52,.13)"/>
    ${bag ? renderClosetVisual(bag, "doll") : ""}

    <!-- long soft hair behind the body -->
    <path d="M38 45C25 60 25 88 29 116c3 25 1 48-8 65 13 1 23-5 29-16 2 13 8 22 18 28V57z" fill="url(#hairDoll)"/>
    <path d="M101 45c13 15 14 43 10 71-3 25-1 48 8 65-13 1-23-5-29-16-2 13-8 22-18 28V57z" fill="url(#hairDoll)"/>
    <path d="M31 83c-3 31 4 65-6 87M108 83c4 31-3 65 7 87" fill="none" stroke="#6e5c5b" stroke-opacity=".36" stroke-width="2" stroke-linecap="round"/>

    <!-- neck, legs and quiet inner layer -->
    <path d="M62 84h16v17c0 6-16 6-16 0z" fill="url(#skinDoll)"/>
    <path d="M53 147l2 63c0 9 11 9 13 1l2-49 2 49c2 8 13 8 13-1l2-63z" fill="url(#skinDoll)" stroke="rgba(120,80,73,.09)"/>
    <path d="M50 94c4-8 36-8 40 0l5 57H45z" fill="url(#innerDoll)" stroke="rgba(101,78,72,.15)"/>
    <path d="M46 143h48l2 30H75l-5-18-5 18H44z" fill="#d8c9bb" stroke="rgba(101,78,72,.15)"/>

    <!-- face -->
    <path d="M41 51c0-23 12-38 29-38s30 15 30 38v13c0 18-13 30-30 30S41 82 41 64z" fill="url(#skinDoll)" stroke="rgba(113,73,69,.14)" stroke-width=".8"/>
    <ellipse cx="52" cy="71" rx="10" ry="7" fill="url(#cheekDoll)"/><ellipse cx="88" cy="71" rx="10" ry="7" fill="url(#cheekDoll)"/>
    <path d="M49 55c4-3 9-3 13 0M78 55c4-3 9-3 13 0" fill="none" stroke="#554344" stroke-width="1.2" stroke-linecap="round"/>
    <ellipse cx="56" cy="62" rx="3.8" ry="4.8" fill="#fffaf5"/><ellipse cx="84" cy="62" rx="3.8" ry="4.8" fill="#fffaf5"/>
    <ellipse cx="56.5" cy="62.4" rx="2.4" ry="3.5" fill="#6a5047"/><ellipse cx="83.5" cy="62.4" rx="2.4" ry="3.5" fill="#6a5047"/>
    <circle cx="57.3" cy="61.3" r=".8" fill="#fff"/><circle cx="84.3" cy="61.3" r=".8" fill="#fff"/>
    <path d="M69 63c-1 3-1 5 1 6" fill="none" stroke="#d89f8c" stroke-width="1" stroke-linecap="round"/>
    <path d="M63 76c4 3 10 3 14 0-2 5-11 6-14 0z" fill="#c77d82" opacity=".8"/>

    <!-- center-parted fringe and fine hair strands -->
    <path d="M33 52C35 22 50 6 70 7c22 0 37 17 38 47-8-12-18-20-32-23-5-1-7-8-6-18-5 9-13 15-25 19-5 5-9 12-12 20z" fill="url(#hairDoll)"/>
    <path d="M69 10c-7 12-15 20-29 25M72 11c5 10 14 17 29 24M54 17c-8 10-13 21-14 35M86 18c8 10 12 21 13 35" fill="none" stroke="#7b6867" stroke-opacity=".48" stroke-width="1.5" stroke-linecap="round"/>

    <!-- round glasses -->
    <circle cx="55" cy="62" r="11" fill="rgba(255,255,255,.07)" stroke="#302d31" stroke-width="2.2"/><circle cx="85" cy="62" r="11" fill="rgba(255,255,255,.07)" stroke="#302d31" stroke-width="2.2"/><path d="M66 61h8M44 60l-5-2M96 60l5-2" stroke="#302d31" stroke-width="1.9" stroke-linecap="round"/>

    <!-- arms behind the selected garment -->
    <path d="M48 103c-13 17-15 39-9 60M92 103c13 17 15 39 9 60" fill="none" stroke="url(#skinDoll)" stroke-width="8" stroke-linecap="round"/>
    ${dress ? renderClosetVisual(dress, "doll") : `${renderClosetVisual(top || defaultTop, "doll")}${renderClosetVisual(bottom || defaultBottom, "doll")}`}
    ${renderClosetVisual(shoes || defaultShoes, "doll")}
    <circle cx="39" cy="164" r="4.3" fill="url(#skinDoll)"/><circle cx="101" cy="164" r="4.3" fill="url(#skinDoll)"/>

    <!-- front locks give the doll the reference's wavy silhouette -->
    <path d="M42 43c-4 28 1 42 12 57 7 10 6 31-3 47" fill="none" stroke="#352d30" stroke-width="8" stroke-linecap="round"/>
    <path d="M98 43c4 27-1 43-11 58-6 10-5 29 3 44" fill="none" stroke="#352d30" stroke-width="8" stroke-linecap="round"/>
    <path d="M44 45c-2 25 4 36 12 51M96 45c2 25-4 36-11 51" fill="none" stroke="#796566" stroke-opacity=".35" stroke-width="1.3" stroke-linecap="round"/>
    ${accessory ? renderClosetVisual(accessory, "doll") : ""}
    ${hat ? renderClosetVisual(hat, "doll") : ""}
  </svg>`;
}

function renderClosetPage() {
  const mount = $("#paperDollMount");
  if (mount) mount.innerHTML = renderRasterPaperDoll() || renderPaperDollSvg();
  const equipped = getEquippedClosetItems();
  const todayLabel = $("#closetTodayLabel");
  if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  const wornCount = $("#closetWornCount");
  if (wornCount) wornCount.textContent = equipped.length ? `${equipped.length} 件搭配` : "日常装";
  const outfitText = $("#closetOutfitText");
  if (outfitText) outfitText.innerText = equipped.length ? equipped.map(x => x.item.name).join(" · ") : "奶油居家衫 · 柔雾短裤";
  const grid = $("#closetOwnedGrid");
  if (grid) {
    const owned = getClosetOwnedItems();
    if (!owned.length) {
      grid.innerHTML = `<div class="closet-empty-hint" style="grid-column:1/-1;">衣橱还空着。<br>去购物里的衣装货架挑第一件吧。</div>`;
    } else {
      const outfit = getClosetOutfit();
      grid.innerHTML = owned.map(item => {
        const isEquipped = outfit[item.slot] === item.ownedId;
        return `<div class="closet-card${isEquipped ? " is-equipped" : ""}">
          <div class="closet-card-preview">${renderClosetVisual(item, "preview")}</div>
          <div class="closet-card-top"><span class="closet-swatch" style="background:${escapeHtml(item.color || "#c8b7ad")}"></span><div class="closet-card-name">${item.emoji || "👗"} ${escapeHtml(item.name)}</div></div>
          <div class="closet-card-meta">${CLOSET_SLOT_LABELS[item.slot] || item.slot}${item.style ? ` · ${escapeHtml(item.style.split("、").slice(0, 2).join("、"))}` : ""}</div>
          ${renderClosetDescription(item)}
          <div class="closet-card-actions"><button class="btn ${isEquipped ? "btn-ghost" : "btn-primary"}" data-equip="${item.ownedId}">${isEquipped ? "穿着中" : "试穿"}</button><button class="btn btn-ghost" data-damage="${item.ownedId}">损坏</button></div>
        </div>`;
      }).join("");
      grid.querySelectorAll("[data-equip]").forEach(btn => {
        btn.onclick = () => { equipClosetItem(btn.dataset.equip); renderClosetPage(); showToast("已换上"); };
      });
      grid.querySelectorAll("[data-damage]").forEach(btn => {
        btn.onclick = () => {
          if (!confirm("确定这件衣装损坏了吗？会回到购物里的衣装货架。")) return;
          damageClosetItem(btn.dataset.damage);
          renderClosetPage();
          showToast("已放回衣装货架");
        };
      });
    }
  }
}

function renderFoldedDates() {
  const list = $("#foldedDateList");
  if (!list) return;
  const items = getFoldedDates();
  if (!items.length) {
    list.innerHTML = `<div class="world-empty" style="padding:24px 10px;"><div class="emoji">⌁</div><p>还没有折角日期</p></div>`;
    return;
  }
  list.innerHTML = items.map(item => {
    const days = daysUntilDate(item.date);
    const dayText = days === 0 ? "今天" : days > 0 ? `${days}天后` : `${Math.abs(days)}天前`;
    return `<div class="folded-date-item">
      <div><div class="folded-date-name">${escapeHtml(item.name)}</div><div class="folded-date-meta">${escapeHtml(item.date)}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</div></div>
      <span class="folded-date-badge">${dayText}</span>
      <button class="msg-delete-btn" data-fold-del="${item.id}" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg></button>
    </div>`;
  }).join("");
  list.querySelectorAll("[data-fold-del]").forEach(btn => {
    btn.onclick = () => { removeFoldedDate(btn.dataset.foldDel); renderFoldedDates(); showToast("已删除"); };
  });
}

function initFoldedCalendarApp() {
  const btn = $("#addFoldedDateBtn");
  if (btn) btn.onclick = () => {
    const date = prompt("日期？格式 YYYY-MM-DD", formatLocalDate());
    if (!date) return;
    const name = prompt("这一天叫什么？比如：第一次共读");
    if (!name) return;
    const note = prompt("Leith 的一句备注（可空）", "") || "";
    addFoldedDate(date.trim(), name.trim(), note.trim());
    renderFoldedDates();
    showToast("已折角");
  };
}

function formatMemoryTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前";
  if (diff < 604800000) return Math.floor(diff / 86400000) + "天前";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

// ============================================================
// 小组件 app（时间 + 天气 + 每日小纸条）
// ============================================================
let widgetTimeTimer = null;
let cachedWeather = null;
let cachedNote = null;
let cachedNoteDate = "";

function initWidget() {
  // 时间更新定时器
  updateWidgetTime();
  if (widgetTimeTimer) clearInterval(widgetTimeTimer);
  // 小组件只显示到分钟；每秒重绘在 iOS PWA 中会造成没有视觉收益的持续耗电与合成。
  widgetTimeTimer = setInterval(() => { if (!document.hidden) updateWidgetTime(); }, 30000);

  // 刷新小纸条按钮
  const refreshBtn = $("#refreshNoteBtn");
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      cachedNote = null;
      cachedNoteDate = "";
      generateDailyNote();
    };
  }

  // 手动存进归档信件
  const archiveBtn = $("#archiveNoteBtn");
  if (archiveBtn) archiveBtn.onclick = archiveCurrentDailyNote;

  // 异步获取天气和小纸条
  fetchWeather();
}

function updateWidgetTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const timeStr = `${h}:${m}`;
  const dateStr = now.toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" });

  // 桌面预览
  const wp = $("#widgetTime");
  if (wp) wp.innerText = timeStr;

  // 小组件 app 内
  const bt = $("#widgetBigTime");
  if (bt) bt.innerText = timeStr;
  const bd = $("#widgetBigDate");
  if (bd) bd.innerText = dateStr;
}

function updateWidgetPreview() {
  updateWidgetTime();
  if (!cachedWeather) fetchWeather();
  if (!cachedNote) generateDailyNote();

  // 更新桌面预览卡
  if (cachedWeather) setWidgetWeatherLine(cachedWeather.icon, `${cachedWeather.desc} · ${cachedWeather.temp}°C`);
  if (cachedNote) {
    const wn = $("#widgetNotePreview");
    if (wn) wn.innerText = cachedNote;
  }
}

// 更新桌面小组件卡片里的天气行（图标 span + 文字分开写，避免互相覆盖）
function setWidgetWeatherLine(emoji, text) {
  const emojiEl = $("#widgetWeatherEmoji");
  if (emojiEl) emojiEl.innerText = emoji;
  const ww = $("#widgetWeather");
  if (ww) {
    // 保留 emoji span，只替换后面的文字节点
    let textNode = Array.from(ww.childNodes).find(n => n.nodeType === 3);
    if (!textNode) {
      textNode = document.createTextNode("");
      ww.appendChild(textNode);
    }
    textNode.textContent = text;
  }
}

async function fetchWeather() {
  // Open-Meteo 免费 API，无需 key
  // 先尝试获取地理位置
  const getCoords = () => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 5000 }
    );
  });

  let coords = await getCoords();
  // 默认深圳
  if (!coords) coords = { lat: 22.5431, lon: 114.0579 };

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current_weather=true&timezone=auto`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("天气获取失败");
    const data = await resp.json();
    const cw = data.current_weather;
    if (!cw) throw new Error("无天气数据");

    const temp = Math.round(cw.temperature);
    const code = cw.weathercode;
    const icon = weatherCodeToIcon(code);
    const desc = weatherCodeToText(code);
    cachedWeather = { temp, icon, desc, text: `${icon} ${desc} ${temp}°C` };

    // 更新 UI
    const wi = $("#widgetWeatherIcon");
    if (wi) wi.innerText = icon;
    const wt = $("#widgetWeatherText");
    if (wt) wt.innerText = `${desc} · ${temp}°C`;
    setWidgetWeatherLine(icon, `${desc} · ${temp}°C`);
  } catch (e) {
    console.error("天气获取失败:", e);
    const wt = $("#widgetWeatherText");
    if (wt) wt.innerText = "天气获取失败";
    setWidgetWeatherLine("⚠️", "天气获取失败");
  }
}

function weatherCodeToIcon(code) {
  if (code === 0) return "☀️";
  if (code <= 3) return "⛅";
  if (code <= 48) return "🌫️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌦️";
  if (code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌤️";
}

function weatherCodeToText(code) {
  const map = {
    0: "晴", 1: "晴", 2: "多云", 3: "阴",
    45: "雾", 48: "雾",
    51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨",
    56: "冻雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "冻雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    77: "雪粒",
    80: "阵雨", 81: "阵雨", 82: "暴雨",
    85: "阵雪", 86: "阵雪",
    95: "雷暴", 96: "雷暴", 99: "雷暴"
  };
  return map[code] || "未知";
}

async function generateDailyNote() {
  const today = new Date().toISOString().slice(0, 10);
  // 同一天不重复生成（除非手动刷新）
  if (cachedNote && cachedNoteDate === today) {
    updateNoteUI();
    return;
  }

  const noteEl = $("#widgetNoteText");
  if (noteEl) noteEl.innerText = "正在生成今日小纸条...";

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const isGemini = /gemini|google|generativelanguage/i.test(`${model || ""} ${provider?.name || ""} ${provider?.baseUrl || ""}`);

  if (!apiKey || !provider || !model) {
    if (noteEl) noteEl.innerText = "（配置好服务商后，Leith 会给你写每日小纸条）";
    return;
  }

  const weatherInfo = cachedWeather ? `今天天气：${cachedWeather.desc}，${cachedWeather.temp}°C` : "";
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  // 小纸条只"读"记忆和最近聊天，不会往里写任何东西——
  // 读完就是读完了，除非用户自己点了"存进归档信件"，否则不会留下任何痕迹。
  let contextBlock = "";
  try {
    if (window.Memory && !isGemini) {
      const memBlock = window.Memory.asPromptBlock ? await window.Memory.asPromptBlock() : "";
      if (memBlock) contextBlock += `【关于 Susie，你一直记得的事】\n${memBlock}\n\n`;

      const threadId = getActiveThreadId();
      if (window.Memory.isReady && window.Memory.isReady() && threadId) {
        const recent = await window.Memory.listShortTermDetail(threadId, 8);
        if (recent && recent.length) {
          const lines = recent.slice().reverse().map(m => `${m.role === "assistant" ? "Leith" : "Susie"}：${m.content}`);
          contextBlock += `【最近聊到的】\n${lines.join("\n")}\n\n`;
        }
      }
    }
  } catch (e) {
    console.error("小纸条读取记忆失败（不影响生成，只是拿不到上下文）:", e);
  }

  const prompt = isGemini
    ? `写一句适合日历小组件的中文生活便签。今天${dateStr}，现在${timeStr}，${weatherInfo || "天气未知"}。12到28个汉字，内容只围绕吃饭、喝水、休息、天气或给今天留一点余地。不要称呼，不要关系设定，不要解释，只输出正文。`
    : `今天是${dateStr}，现在${timeStr}。${weatherInfo}。

${contextBlock}请给 Susie 写一句简短、日常、非敏感的小纸条，30字以内。
要求：
1. 像朋友放在桌上的便签，温柔自然。
2. 可以轻轻呼应天气、时间、日常心情或最近话题，但不要复述隐私细节。
3. 不写医疗、心理诊断、危险行为、成人内容、承诺、控制、占有、身份宣称。
4. 不要写“我记得你说过”，不要加引号、标题、解释或列表。
只输出纸条正文。`;
  const noteSystemPrompt = [
    "Task: write one benign Chinese calendar note.",
    "12-28 Chinese characters. Everyday life only: weather, food, water, rest or tidying.",
    "No relationship roleplay, diagnosis, promises, adult content, danger, explanation or title.",
    "Output the note only."
  ].join("\n");

  try {
    const messages = [{ role: "user", content: prompt }];
    const temp = 0.9;
    let result;
    if (provider.apiStyle === "anthropic") {
      result = await streamAnthropic({
        provider, apiKey, model, temp,
        systemPrompt: noteSystemPrompt,
        messages, controller: new AbortController(),
        onDelta: () => {}
      });
    } else {
      result = await streamOpenAICompatible({
        provider, apiKey, model, temp,
        systemPrompt: noteSystemPrompt,
        messages, controller: new AbortController(),
        onDelta: () => {}
      });
    }
    cachedNote = (result.text || "").trim().replace(/^["“]|["”]$/g, "");
    if (!cachedNote || cachedNote.length > 60) throw new Error("小纸条正文无效");
    cachedNoteDate = today;
    updateNoteUI();
  } catch (e) {
    console.error("小纸条生成失败:", e);
    cachedNote = weatherInfo ? "今天也慢慢来，先照顾好自己。" : "给今天留一点轻轻的余地。";
    cachedNoteDate = today;
    updateNoteUI();
  }
}

// 手动把当前这条小纸条存进归档信件——小纸条本身默认不会自动进记忆，
// 只有用户主动点这个按钮，才会把它变成一条正式记忆
async function archiveCurrentDailyNote() {
  if (!cachedNote) return showToast("还没有小纸条可以存");
  if (!window.Memory || !window.Memory.addArchive) return showToast("记忆系统未加载");
  const dateLabel = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  await window.Memory.addArchive(`【${dateLabel}的小纸条】${cachedNote}`);
  showToast("已存进归档信件");
}

function updateNoteUI() {
  if (!cachedNote) return;
  const noteEl = $("#widgetNoteText");
  if (noteEl) noteEl.innerText = cachedNote;
  const preview = $("#widgetNotePreview");
  if (preview) preview.innerText = cachedNote;
}

function refreshWidgetApp() {
  updateWidgetTime();
  if (!cachedWeather) fetchWeather();
  if (!cachedNote) generateDailyNote();
}

// ============================================================
// 共读小说 app
// ============================================================
let readingBooks = [];
let readingActiveBookId = null;
let readingChatHistory = []; // { role, content }[]，只在阅读器内使用，不进主对话线程
let readingSharedId = null;   // 当前书如果已经分享/是从分享链接打开的，这里存 shared_books 的短码
let readingIsPartnerView = false; // true = 是通过分享链接打开、我是"对方"那一侧
let partnerProgressTimer = null;

function loadReadingBooks() {
  try {
    readingBooks = JSON.parse(localStorage.getItem(LS.readingBooks) || "[]");
  } catch (e) { readingBooks = []; }
  return readingBooks;
}

function saveReadingBooks() {
  // content 可能很大，超出 localStorage 配额时给出提示而不是静默失败
  try {
    localStorage.setItem(LS.readingBooks, JSON.stringify(readingBooks));
    scheduleCloudStateSync(LS.readingBooks, readingBooks);
  } catch (e) {
    showToast("书本太大，本机存储空间不够了");
  }
}

// ============================================================
// 一起看的链接（共读同步，走 Supabase 的 shared_books 表）
// ============================================================
function genShareCode() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function getReadingClient() {
  // 复用 memory.js 里已经建立好的 Supabase 客户端
  if (typeof supabaseClient !== "undefined" && supabaseClient) return supabaseClient;
  if (window.supabase && window.supabase.createClient) {
    try {
      return window.supabase.createClient(
        "https://kiphsgskorznxjdcjsos.supabase.co",
        "sb_publishable_Sk9lyJqWR92A4SIDMHK1IQ_BFbAAf9o"
      );
    } catch (e) { return null; }
  }
  return null;
}

// 把当前书分享出去：写入 shared_books 表，返回可以发给对方的链接
async function shareCurrentBook() {
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book) return;
  const client = getReadingClient();
  if (!client) return showModal("暂时不能分享", "云端服务连不上，检查一下网络，或者稍后再试。");

  showToast("正在生成链接...");
  try {
    const code = readingSharedId || genShareCode();
    const { error } = await client.from("shared_books").upsert({
      id: code,
      name: book.name,
      content: book.content,
      owner_progress: book.progress || 0
    });
    if (error) throw error;
    readingSharedId = code;
    book.sharedId = code;
    saveReadingBooks();

    const url = `${location.origin}${location.pathname}?book=${code}`;
    showShareLinkModal(url);
  } catch (err) {
    console.error("分享失败:", err);
    showModal("分享失败", "云端表可能还没建好。需要先在 Supabase 里执行一次 seed_shared_reading.sql，之后就都能用了。");
  }
}

function showShareLinkModal(url, title) {
  $("#shareLinkModalUrl").value = url;
  const titleEl = document.querySelector("#shareLinkModalOverlay h3");
  if (titleEl) titleEl.innerText = title || "💌 一起看这本书";
  $("#shareLinkModalOverlay").classList.remove("hidden");
  pushNavLayer(() => $("#shareLinkModalOverlay").classList.add("hidden"));
}
function closeShareLinkModalFromUI() {
  popNavLayerSilently();
  $("#shareLinkModalOverlay").classList.add("hidden");
}
function copyShareLink() {
  const input = $("#shareLinkModalUrl");
  input.select();
  input.setSelectionRange(0, 99999);
  try {
    navigator.clipboard.writeText(input.value);
    showToast("链接已复制，发给 TA 吧");
  } catch (e) {
    document.execCommand("copy");
    showToast("链接已复制");
  }
}

// 从分享链接打开：读取 URL 里的 ?book= 短码，拉取对应的书
async function tryOpenSharedBookFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("book");
  if (!code) return false;

  const client = getReadingClient();
  if (!client) return false;

  showToast("正在打开TA分享的书...");
  try {
    const { data, error } = await client.from("shared_books").select("*").eq("id", code).single();
    if (error || !data) throw error || new Error("没找到这本书");

    // 存一份到本地书架，方便下次直接从书架进（不用每次都带着链接）
    loadReadingBooks();
    let localBook = readingBooks.find(b => b.sharedId === code);
    if (!localBook) {
      localBook = { id: uid(), name: data.name, type: "shared", addedAt: Date.now(), progress: data.partner_progress || 0, content: data.content, sharedId: code };
      readingBooks.push(localBook);
      saveReadingBooks();
    }

    readingIsPartnerView = true;
    readingSharedId = code;
    openApp("page-app-reading");
    openReadingBook(localBook.id);
    return true;
  } catch (err) {
    console.error("打开分享的书失败:", err);
    showModal("打开失败", "这本共读的书可能已经失效了，让 TA 重新发一个链接试试。");
    return false;
  }
}

// 把本地阅读进度同步一份到云端，供对方看到"我读到哪了"
async function syncReadingProgressToCloud() {
  if (!readingSharedId) return;
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book) return;
  const client = getReadingClient();
  if (!client) return;
  const field = readingIsPartnerView ? "partner_progress" : "owner_progress";
  try {
    await client.from("shared_books").update({ [field]: book.progress || 0 }).eq("id", readingSharedId);
  } catch (e) {
    console.warn("同步阅读进度失败:", e);
  }
}

// 拉一次对方目前读到的位置，显示在进度条上
async function fetchPartnerProgress() {
  if (!readingSharedId) return;
  const client = getReadingClient();
  if (!client) return;
  try {
    const { data, error } = await client.from("shared_books").select("owner_progress, partner_progress").eq("id", readingSharedId).single();
    if (error || !data) return;
    const partnerVal = readingIsPartnerView ? data.owner_progress : data.partner_progress;
    const book = readingBooks.find(b => b.id === readingActiveBookId);
    if (!book || !book.content.length) return;
    const pct = Math.round((partnerVal / book.content.length) * 100);
    const marker = $("#readingPartnerMarker");
    if (marker) {
      marker.style.left = Math.min(100, Math.max(0, pct)) + "%";
      marker.title = `TA 读到了 ${pct}%`;
      marker.classList.remove("hidden");
    }
  } catch (e) { /* 静默失败即可，不打扰阅读 */ }
}

// ============================================================
// 一起看的网页链接（比如小说网站的某一章网址，不涉及上传文件）
// ============================================================
let readingLinks = [];

function loadReadingLinks() {
  try {
    readingLinks = JSON.parse(localStorage.getItem(LS.readingLinks) || "[]");
  } catch (e) { readingLinks = []; }
  return readingLinks;
}
function saveReadingLinksLocal() {
  try {
    localStorage.setItem(LS.readingLinks, JSON.stringify(readingLinks));
    scheduleCloudStateSync(LS.readingLinks, readingLinks);
  } catch (e) {}
}

function normalizeUrl(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

// 保存一个网页链接：本地存一份，同时尝试同步到云端生成一个可以分享给 TA 的短链接
async function saveReadingLink() {
  const urlInput = $("#readingLinkUrlInput");
  const noteInput = $("#readingLinkNoteInput");
  const url = normalizeUrl(urlInput.value);
  const note = noteInput.value.trim();

  if (!url) return showToast("先粘贴一个链接吧");
  try { new URL(url); } catch (e) { return showModal("链接好像不太对", "检查一下是不是完整的网址，比如要带上 https://"); }

  const id = uid();
  const link = { id, url, note, addedAt: Date.now() };
  loadReadingLinks();
  readingLinks.unshift(link);
  saveReadingLinksLocal();
  renderReadingLinkGrid();

  urlInput.value = "";
  noteInput.value = "";
  $("#readingLinkForm").classList.add("hidden");

  // 同步到云端，方便生成分享链接给 TA；就算失败，本地也已经存好了，不影响自己用
  const client = getReadingClient();
  if (client) {
    try {
      await client.from("shared_links").upsert({ id, url, note });
      const shareUrl = `${location.origin}${location.pathname}?link=${id}`;
      showShareLinkModal(shareUrl, "💌 一起看这个网页");
      return;
    } catch (err) {
      console.warn("同步链接到云端失败:", err);
    }
  }
  showToast("已保存到本机（云端暂时没连上，先自己看吧）");
}

function renderReadingLinkGrid() {
  const grid = $("#readingLinkGrid");
  if (!grid) return;
  loadReadingLinks();
  grid.innerHTML = "";
  readingLinks.forEach(link => {
    let host = link.url;
    try { host = new URL(link.url).hostname.replace(/^www\./, ""); } catch (e) {}
    const card = document.createElement("div");
    card.className = "reading-link-card";
    card.innerHTML = `
      <div class="reading-link-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 13a5 5 0 007.07 0l2.83-2.83a5 5 0 00-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 00-7.07 0L4.1 13.83a5 5 0 007.07 7.07L12.5 19.5"/></svg>
      </div>
      <div class="reading-link-info">
        <div class="reading-link-note">${escapeHtml(link.note || host)}</div>
        <div class="reading-link-url">${escapeHtml(host)}</div>
      </div>
      <div class="reading-link-actions">
        <button class="reading-link-action-btn" title="分享给TA">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-3.9M8.6 13.4l6.8 3.9"/></svg>
        </button>
        <button class="reading-link-action-btn danger" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".reading-link-action-btn")) return;
      window.open(link.url, "_blank");
    });
    card.querySelectorAll(".reading-link-action-btn")[0].addEventListener("click", async (e) => {
      e.stopPropagation();
      const client = getReadingClient();
      if (client) {
        try { await client.from("shared_links").upsert({ id: link.id, url: link.url, note: link.note }); } catch (err) {}
      }
      showShareLinkModal(`${location.origin}${location.pathname}?link=${link.id}`, "💌 一起看这个网页");
    });
    card.querySelectorAll(".reading-link-action-btn")[1].addEventListener("click", (e) => {
      e.stopPropagation();
      readingLinks = readingLinks.filter(l => l.id !== link.id);
      saveReadingLinksLocal();
      renderReadingLinkGrid();
    });
    grid.appendChild(card);
  });
}

// 通过分享链接打开一个"一起看的网页"：直接跳转过去，不需要停留在 App 里
async function tryOpenSharedLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get("link");
  if (!code) return false;

  const client = getReadingClient();
  if (!client) {
    showModal("打不开", "云端服务连不上，晚点再试试这个链接。");
    return false;
  }
  showToast("正在打开TA分享的网页...");
  try {
    const { data, error } = await client.from("shared_links").select("*").eq("id", code).single();
    if (error || !data) throw error || new Error("没找到这个链接");
    // 本地也存一份，方便下次直接从书架进
    loadReadingLinks();
    if (!readingLinks.find(l => l.id === code)) {
      readingLinks.unshift({ id: code, url: data.url, note: data.note, addedAt: Date.now() });
      saveReadingLinksLocal();
    }
    window.location.href = data.url;
    return true;
  } catch (err) {
    console.error("打开分享的网页失败:", err);
    showModal("打开失败", "这个链接可能已经失效了，让 TA 重新发一个试试。");
    return false;
  }
}

function showReadingLibrary() {
  loadReadingBooks();
  $("#readingLibraryView").classList.remove("hidden");
  $("#readingReaderView").classList.add("hidden");
  $("#readingChatToggleBtn").style.display = "none";
  $("#readingNotesToggleBtn").style.display = "none";
  $("#readingShareBtn").style.display = "none";
  $("#readingHeaderTitle").innerText = "📖 共读小说";
  $("#readingBackBtn").onclick = closeAppFromUI;
  readingIsPartnerView = false;
  readingSharedId = null;
  renderReadingBookGrid();
  renderReadingLinkGrid();
}

function renderReadingBookGrid() {
  const grid = $("#readingBookGrid");
  if (!readingBooks.length) {
    grid.innerHTML = `<div class="reading-empty-hint">还没有书。上传一本 txt 或 pdf，<br>就可以和 Leith 一起读了。</div>`;
    return;
  }
  grid.innerHTML = "";
  readingBooks.slice().reverse().forEach(book => {
    const pct = book.content.length ? Math.round((book.progress || 0) / book.content.length * 100) : 0;
    const card = document.createElement("div");
    card.className = "reading-book-card";
    card.innerHTML = `
      <div class="reading-book-spine">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5C6 4.5 9 4.5 12 6c3-1.5 6-1.5 8-.5v13c-2-1-5-1-8 .5-3-1.5-6-1.5-8-.5v-13z"/><path d="M12 6v13"/></svg>
      </div>
      <div class="reading-book-info">
        <div class="reading-book-name">${escapeHtml(book.name)}${book.sharedId ? ' <span class="reading-shared-badge">💌 共读</span>' : ""}</div>
        <div class="reading-book-meta">${pct > 0 ? `已读 ${pct}%` : "还没开始"} · ${book.type.toUpperCase()}</div>
      </div>
      <button class="reading-book-del" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </button>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".reading-book-del")) return;
      openReadingBook(book.id);
    });
    card.querySelector(".reading-book-del").addEventListener("click", (e) => {
      e.stopPropagation();
      readingBooks = readingBooks.filter(b => b.id !== book.id);
      saveReadingBooks();
      renderReadingBookGrid();
    });
    grid.appendChild(card);
  });
}

function initReading() {
  const fileInput = $("#readingFileInput");
  $("#readingUploadCard").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleReadingFileUpload);

  // 粘贴网页链接：点卡片展开小表单
  $("#readingLinkCard").addEventListener("click", () => {
    $("#readingLinkForm").classList.remove("hidden");
    $("#readingLinkUrlInput").focus();
  });
  $("#readingLinkCancelBtn").addEventListener("click", () => {
    $("#readingLinkForm").classList.add("hidden");
    $("#readingLinkUrlInput").value = "";
    $("#readingLinkNoteInput").value = "";
  });
  $("#readingLinkSaveBtn").addEventListener("click", saveReadingLink);

  $("#readingChatToggleBtn").addEventListener("click", openReadingChatDrawer);
  $("#readingChatCloseBtn").addEventListener("click", closeReadingChatDrawerFromUI);
  $("#readingChatOverlay").addEventListener("click", closeReadingChatDrawerFromUI);

  const chatInput = $("#readingChatInput");
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + "px";
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReadingChat(); }
  });
  $("#readingChatSendBtn").addEventListener("click", sendReadingChat);

  // 阅读进度：滚动时节流保存
  let saveTimer = null;
  $("#readingReaderBody").addEventListener("scroll", (e) => {
    if (!readingActiveBookId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveReadingProgress(e.target), 400);
  });

  $("#readingShareBtn").addEventListener("click", shareCurrentBook);
  $("#shareLinkCopyBtn").addEventListener("click", copyShareLink);
  $("#shareLinkCloseBtn").addEventListener("click", closeShareLinkModalFromUI);
  $("#shareLinkModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "shareLinkModalOverlay") closeShareLinkModalFromUI();
  });

  // ---- 划线 / 笔记 ----
  const readerBody = $("#readingReaderBody");
  readerBody.addEventListener("mouseup", handleReadingSelection);
  readerBody.addEventListener("touchend", () => setTimeout(handleReadingSelection, 10));
  document.addEventListener("mousedown", (e) => {
    if (!$("#readingSelectPopup").contains(e.target)) hideReadingSelectPopup();
  });

  $("#readingHighlightBtn").addEventListener("click", () => saveReadingSelectionAsNote(""));
  $("#readingNoteBtn").addEventListener("click", openReadingNoteModal);
  $("#readingNoteCancelBtn").addEventListener("click", closeReadingNoteModal);
  $("#readingNoteSaveBtn").addEventListener("click", () => {
    const text = $("#readingNoteTextInput").value.trim();
    saveReadingSelectionAsNote(text);
    closeReadingNoteModal();
  });
  $("#readingNoteModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "readingNoteModalOverlay") closeReadingNoteModal();
  });

  $("#readingNotesToggleBtn").addEventListener("click", openReadingNotesDrawer);
  $("#readingNotesCloseBtn").addEventListener("click", closeReadingNotesDrawerFromUI);
  $("#readingNotesOverlay").addEventListener("click", closeReadingNotesDrawerFromUI);

  // 正文里点已经划线的部分，直接跳到笔记列表定位它
  readerBody.addEventListener("click", (e) => {
    const mark = e.target.closest("mark.reading-hl");
    if (mark && mark.dataset.noteId) {
      openReadingNotesDrawer(mark.dataset.noteId);
    }
  });
}

async function handleReadingFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const isTxt = /\.txt$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  if (!isTxt && !isPdf) {
    showModal("格式不支持", "目前只支持 .txt 和 .pdf 文件。");
    e.target.value = "";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showModal("文件太大", "请上传 15MB 以内的文件，本机存储空间有限。");
    e.target.value = "";
    return;
  }

  showToast(isPdf ? "正在解析 PDF..." : "正在导入...");

  try {
    let content = "";
    if (isTxt) {
      content = await file.text();
    } else {
      content = await extractPdfText(file);
    }
    content = content.trim();
    if (!content) {
      showModal("没有读到文字", "这个文件里没有能提取出来的文字内容。");
      e.target.value = "";
      return;
    }
    const book = {
      id: uid(), name: file.name.replace(/\.(txt|pdf)$/i, ""),
      type: isTxt ? "txt" : "pdf",
      addedAt: Date.now(), progress: 0, content
    };
    loadReadingBooks();
    readingBooks.push(book);
    saveReadingBooks();
    renderReadingBookGrid();
    showToast("导入成功");
    openReadingBook(book.id);
  } catch (err) {
    console.error("读取文件失败:", err);
    showModal("导入失败", "文件读取出错了，换一个文件试试？");
  }
  e.target.value = "";
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("PDF 解析库未加载");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(" ");
    text += pageText + "\n\n";
  }
  return text;
}

function openReadingBook(bookId) {
  const book = readingBooks.find(b => b.id === bookId);
  if (!book) return;
  readingActiveBookId = bookId;
  readingChatHistory = [];
  readingSharedId = book.sharedId || null;
  // 只有真正从分享链接进来的那一次才算"对方视角"，否则从自己书架直接点开算"我是主人"
  if (!readingIsPartnerView) readingIsPartnerView = false;

  $("#readingLibraryView").classList.add("hidden");
  $("#readingReaderView").classList.remove("hidden");
  $("#readingChatToggleBtn").style.display = "flex";
  $("#readingNotesToggleBtn").style.display = "flex";
  $("#readingHeaderTitle").innerText = book.name;
  $("#readingShareBtn").style.display = "flex";

  const backToLibrary = () => {
    saveReadingProgress($("#readingReaderBody"));
    clearInterval(partnerProgressTimer);
    showReadingLibrary();
  };
  $("#readingBackBtn").onclick = () => { popNavLayerSilently(); backToLibrary(); };
  pushNavLayer(backToLibrary);

  const body = $("#readingReaderBody");
  renderReadingBodyWithHighlights(book, body);

  $("#readingChatBox").innerHTML = `<div class="reading-chat-hint">可以问问 Leith 对刚才这段的想法，或者让 ta 帮你回顾一下前面的剧情。</div>`;

  // 恢复阅读位置
  requestAnimationFrame(() => {
    if (book.progress > 0) {
      const ratio = book.progress / book.content.length;
      body.scrollTop = ratio * (body.scrollHeight - body.clientHeight);
    }
    updateReadingProgressUI(body);
  });

  // 如果这本书是共读的，定期看看对方读到哪了
  const partnerMarker = $("#readingPartnerMarker");
  if (partnerMarker) partnerMarker.classList.add("hidden");
  clearInterval(partnerProgressTimer);
  if (readingSharedId) {
    fetchPartnerProgress();
    partnerProgressTimer = setInterval(fetchPartnerProgress, 20000);
  }
}

function saveReadingProgress(bodyEl) {
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book || !bodyEl) return;
  const scrollable = bodyEl.scrollHeight - bodyEl.clientHeight;
  const ratio = scrollable > 0 ? bodyEl.scrollTop / scrollable : 0;
  book.progress = Math.round(ratio * book.content.length);
  saveReadingBooks();
  updateReadingProgressUI(bodyEl);
  if (readingSharedId) syncReadingProgressToCloud();
}

function updateReadingProgressUI(bodyEl) {
  const scrollable = bodyEl.scrollHeight - bodyEl.clientHeight;
  const ratio = scrollable > 0 ? bodyEl.scrollTop / scrollable : 0;
  const pct = Math.round(ratio * 100);
  $("#readingProgressFill").style.width = pct + "%";
  $("#readingProgressLabel").innerText = pct + "%";
}

// ============================================================
// 共读小说 —— 划线 & 笔记
// 笔记按书本独立存储：book.notes = [{id, start, end, quote, note, createdAt}]
// start/end 是在 book.content 里的字符偏移量，用来定位这段文字和恢复高亮
// ============================================================
let readingPendingSelection = null; // { start, end, quote } 当前选中但还没保存的文字

function renderReadingBodyWithHighlights(book, bodyEl) {
  const notes = (book.notes || []).slice().sort((a, b) => a.start - b.start);
  if (!notes.length) {
    bodyEl.innerText = book.content;
    return;
  }
  // 按笔记位置把正文切成片段，被划线的片段包一层 <mark>
  let html = "";
  let cursor = 0;
  notes.forEach(n => {
    if (n.start < cursor) return; // 防止笔记范围重叠导致乱码
    html += escapeHtml(book.content.slice(cursor, n.start));
    const noteClass = n.note ? " has-note" : "";
    html += `<mark class="reading-hl${noteClass}" data-note-id="${n.id}">${escapeHtml(book.content.slice(n.start, n.end))}</mark>`;
    cursor = n.end;
  });
  html += escapeHtml(book.content.slice(cursor));
  bodyEl.innerHTML = html;
}

function handleReadingSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { hideReadingSelectPopup(); return; }
  const text = sel.toString().trim();
  if (!text) { hideReadingSelectPopup(); return; }

  const book = readingBooks.find(b => b.id === readingActiveBookId);
  const bodyEl = $("#readingReaderBody");
  if (!book || !bodyEl.contains(sel.anchorNode)) { hideReadingSelectPopup(); return; }

  // 把选区换算成在 book.content 里的字符偏移量：累加选区之前所有文本节点的长度
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(bodyEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  const end = start + text.length;

  readingPendingSelection = { start, end, quote: text };

  const rect = range.getBoundingClientRect();
  const popup = $("#readingSelectPopup");
  popup.style.left = (rect.left + rect.width / 2) + "px";
  popup.style.top = (rect.top - 8) + "px";
  popup.classList.remove("hidden");
}

function hideReadingSelectPopup() {
  $("#readingSelectPopup").classList.add("hidden");
}

function openReadingNoteModal() {
  if (!readingPendingSelection) return;
  $("#readingNoteQuotePreview").innerText = readingPendingSelection.quote.length > 120
    ? readingPendingSelection.quote.slice(0, 120) + "…" : readingPendingSelection.quote;
  $("#readingNoteTextInput").value = "";
  $("#readingNoteModalOverlay").classList.remove("hidden");
  hideReadingSelectPopup();
  pushNavLayer(closeReadingNoteModal);
  setTimeout(() => $("#readingNoteTextInput").focus(), 100);
}
function closeReadingNoteModal() {
  $("#readingNoteModalOverlay").classList.add("hidden");
  popNavLayerSilently();
}

function saveReadingSelectionAsNote(noteText) {
  if (!readingPendingSelection) return;
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book) return;
  if (!book.notes) book.notes = [];

  // 避免和已有划线区间重叠——重叠了就不重复加，提示用户
  const { start, end, quote } = readingPendingSelection;
  const overlaps = book.notes.some(n => start < n.end && end > n.start);
  if (overlaps) {
    showToast("这段已经划过线了");
    readingPendingSelection = null;
    hideReadingSelectPopup();
    window.getSelection().removeAllRanges();
    return;
  }

  book.notes.push({ id: uid(), start, end, quote, note: noteText || "", createdAt: Date.now() });
  saveReadingBooks();
  renderReadingBodyWithHighlights(book, $("#readingReaderBody"));
  readingPendingSelection = null;
  hideReadingSelectPopup();
  window.getSelection().removeAllRanges();
  showToast(noteText ? "笔记已保存" : "已划线");
}

function openReadingNotesDrawer(scrollToNoteId) {
  $("#readingNotesOverlay").classList.add("open");
  $("#readingNotesDrawer").classList.add("open");
  pushNavLayer(closeReadingNotesDrawer);
  renderReadingNotesList(typeof scrollToNoteId === "string" ? scrollToNoteId : null);
}
function closeReadingNotesDrawer() {
  $("#readingNotesOverlay").classList.remove("open");
  $("#readingNotesDrawer").classList.remove("open");
}
function closeReadingNotesDrawerFromUI() { popNavLayerSilently(); closeReadingNotesDrawer(); }

function renderReadingNotesList(highlightNoteId) {
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  const list = $("#readingNotesList");
  const notes = (book && book.notes ? book.notes.slice() : []).sort((a, b) => a.start - b.start);
  if (!notes.length) {
    list.innerHTML = `<div class="reading-chat-hint">选中正文里的一段文字，可以划线或写下笔记，都会出现在这里。</div>`;
    return;
  }
  list.innerHTML = "";
  notes.forEach(n => {
    const item = document.createElement("div");
    item.className = "reading-note-item";
    if (n.id === highlightNoteId) item.style.borderColor = "var(--accent-dim)";
    item.innerHTML = `
      <div class="reading-note-item-quote">${escapeHtml(n.quote)}</div>
      ${n.note ? `<div class="reading-note-item-text">${escapeHtml(n.note)}</div>` : ""}
      <div class="reading-note-item-meta">
        <span class="reading-note-item-time">${formatMemoryTime(n.createdAt)}</span>
        <button class="reading-note-item-del" title="删除">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
        </button>
      </div>`;
    item.querySelector(".reading-note-item-del").onclick = (e) => {
      e.stopPropagation();
      deleteReadingNote(n.id);
    };
    item.addEventListener("click", () => jumpToReadingNote(n.id));
    list.appendChild(item);
  });
}

function deleteReadingNote(noteId) {
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book || !book.notes) return;
  book.notes = book.notes.filter(n => n.id !== noteId);
  saveReadingBooks();
  renderReadingBodyWithHighlights(book, $("#readingReaderBody"));
  renderReadingNotesList();
  showToast("已删除");
}

function jumpToReadingNote(noteId) {
  closeReadingNotesDrawerFromUI();
  requestAnimationFrame(() => {
    const mark = $("#readingReaderBody").querySelector(`mark[data-note-id="${noteId}"]`);
    if (mark) {
      mark.scrollIntoView({ block: "center", behavior: "smooth" });
      mark.style.boxShadow = "0 0 0 2px var(--accent)";
      setTimeout(() => { mark.style.boxShadow = ""; }, 1200);
    }
  });
}

let readingMemoryBlock = "";  // 本次打开共读聊天时，先加载一次已有的"共读记录"，聊天过程中复用，不用每条消息都重新查
let readingChatTurnsSinceLastSave = 0; // 距离上次自动存记忆过了几轮对话

function openReadingChatDrawer() {
  $("#readingChatOverlay").classList.add("open");
  $("#readingChatDrawer").classList.add("open");
  pushNavLayer(closeReadingChatDrawer);
  // 提前把已有的共读记忆查出来缓存着，聊天时直接用，不用每次都查
  if (window.Memory) {
    window.Memory.asReadingPromptBlock().then(block => { readingMemoryBlock = block; });
  }
}
function closeReadingChatDrawer() {
  $("#readingChatOverlay").classList.remove("open");
  $("#readingChatDrawer").classList.remove("open");
  // 关闭时，如果聊了点什么还没存过，自动总结存一条记忆，下次接着聊不用从头讲
  autoSaveReadingMemoryIfNeeded();
}
function closeReadingChatDrawerFromUI() { popNavLayerSilently(); closeReadingChatDrawer(); }

// 取阅读器当前视野附近的文本，只在"这次共读会话的第一条消息"里带一小段，
// 帮 AI 知道具体读到哪一段，后续消息就不再重复带原文，靠记忆和聊天上下文接着聊
function getReadingContextSnippet() {
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  if (!book) return "";
  const bodyEl = $("#readingReaderBody");
  const scrollable = bodyEl.scrollHeight - bodyEl.clientHeight;
  const ratio = scrollable > 0 ? bodyEl.scrollTop / scrollable : 0;
  const center = Math.round(ratio * book.content.length);
  const start = Math.max(0, center - 800);
  const end = Math.min(book.content.length, center + 300);
  return book.content.slice(start, end);
}

async function sendReadingChat() {
  const input = $("#readingChatInput");
  const text = input.value.trim();
  if (!text) return;

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");
  if (!apiKey || !provider || !model) return showModal("提示", "请先在设置里配置好服务商、密钥和模型。");

  const box = $("#readingChatBox");
  const hint = box.querySelector(".reading-chat-hint");
  if (hint) hint.remove();

  const userRow = document.createElement("div");
  userRow.className = "msg-row user";
  userRow.innerHTML = `<div class="bubble user" style="max-width:100%;font-size:14px;">${escapeHtml(text)}</div>`;
  box.appendChild(userRow);
  input.value = "";
  input.style.height = "auto";
  box.scrollTop = box.scrollHeight;

  const aiRow = document.createElement("div");
  aiRow.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.style.cssText = "max-width:100%;font-size:14px;";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  aiRow.appendChild(bubble);
  box.appendChild(aiRow);
  box.scrollTop = box.scrollHeight;

  const book = readingBooks.find(b => b.id === readingActiveBookId);
  const isFirstMessage = readingChatHistory.length === 0;

  // 只在这次会话的第一条消息里带一小段原文帮AI定位剧情；
  // 已经有共读记忆的话优先用记忆（更省token，且是提炼过的重点，不是大段原文）
  let contextPart = "";
  if (readingMemoryBlock) {
    contextPart = readingMemoryBlock;
  } else if (isFirstMessage) {
    const snippet = getReadingContextSnippet();
    contextPart = `以下是用户目前阅读位置附近的原文片段，供你参考语境（不要逐字复述，只用来理解剧情）：\n\n"""${snippet}"""`;
  }
  const systemPrompt = `你正在和用户一起读一本书，书名是《${book ? book.name : ""}》。${contextPart}\n\n请像一起读书的朋友一样，自然地聊聊剧情、人物、感受，简洁真诚，不要写成书评腔。`;

  readingChatHistory.push({ role: "user", content: text });

  try {
    let result;
    const controller = new AbortController();
    if (provider.apiStyle === "anthropic") {
      result = await streamAnthropic({
        provider, apiKey, model, temp, systemPrompt,
        messages: readingChatHistory, controller,
        onDelta: (acc) => { bubble.innerHTML = renderBubbleContent(acc); box.scrollTop = box.scrollHeight; }
      });
    } else {
      result = await streamOpenAICompatible({
        provider, apiKey, model, temp, systemPrompt,
        messages: readingChatHistory, controller,
        onDelta: (acc) => { bubble.innerHTML = renderBubbleContent(acc); box.scrollTop = box.scrollHeight; }
      });
    }
    const reply = result.text || "";
    bubble.innerHTML = renderBubbleContent(reply);
    readingChatHistory.push({ role: "assistant", content: reply });

    // 每条回复旁边加一个小按钮，想手动存进共读记忆随时可以点
    const saveBtn = document.createElement("button");
    saveBtn.className = "reading-chat-save-btn";
    saveBtn.title = "存进共读记忆";
    saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>`;
    saveBtn.onclick = () => manualSaveReadingReply(reply);
    aiRow.appendChild(saveBtn);
    readingChatTurnsSinceLastSave++;
    // 每聊够几轮就自动存一次记忆，不用等到关闭才存，防止中途退出App漏掉
    if (readingChatTurnsSinceLastSave >= 4) {
      autoSaveReadingMemoryIfNeeded();
    }
  } catch (err) {
    console.error("共读聊天失败:", err);
    bubble.innerText = "（没能回复，稍后再试试）";
  }
  box.scrollTop = box.scrollHeight;
}

// 把最近聊的内容自动提炼成一条"共读记录"存进记忆，不需要用户手动操作
async function autoSaveReadingMemoryIfNeeded() {
  if (!readingChatHistory.length || readingChatTurnsSinceLastSave === 0) return;
  if (!window.Memory) return;

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const model = getSelectedChatModel();
  if (!apiKey || !provider || !model) return; // 没配置好就不勉强总结

  const book = readingBooks.find(b => b.id === readingActiveBookId);
  const recentTurns = readingChatHistory.slice(-8); // 只总结最近几轮，避免越总结越贵
  const summaryPrompt = `请把下面这段关于共读一本书的对话总结成一句话（60字以内），提炼出讨论的重点、感想或进度，不要写"用户说""AI说"这种格式：\n${recentTurns.map(m => `${m.role}: ${m.content}`).join("\n")}`;

  try {
    const controller = new AbortController();
    let result;
    if (provider.apiStyle === "anthropic") {
      result = await streamAnthropic({ provider, apiKey, model, temp: 0.3, systemPrompt: "", messages: [{ role: "user", content: summaryPrompt }], controller, onDelta: () => {} });
    } else {
      result = await streamOpenAICompatible({ provider, apiKey, model, temp: 0.3, systemPrompt: "", messages: [{ role: "user", content: summaryPrompt }], controller, onDelta: () => {} });
    }
    const summary = (result.text || "").trim();
    if (summary) {
      await window.Memory.addReading(summary, book ? book.name : "");
      readingMemoryBlock = await window.Memory.asReadingPromptBlock(); // 更新缓存，让接下来的聊天能接上
    }
  } catch (e) {
    console.warn("共读记忆自动总结失败:", e);
  } finally {
    readingChatTurnsSinceLastSave = 0;
  }
}

// 手动把当前 AI 的某句回复存进共读记忆
async function manualSaveReadingReply(content) {
  if (!window.Memory) return;
  const book = readingBooks.find(b => b.id === readingActiveBookId);
  await window.Memory.addReading(content, book ? book.name : "");
  readingMemoryBlock = await window.Memory.asReadingPromptBlock();
  showToast("已存进共读记忆");
}


initTimeOfDayTheme();
initChatScrollTracking();
initBottomBar();
initGiveMoneyBtn();
initToggleAllowanceBtn();
initAddSavingsBtn();
initAddLimitedBtn();
initAddShelfBtn();
initAddAdultBtn();
initAddClosetBtn();
initShopFolds();
initAddItemModal();
initConfig();
initTheater();
initMemoryApp();
initDiaryBookControls();
initWidget();
initMoodBoard();
initReading();
initAttachments();
initHealthApp();
initFoldedCalendarApp();
initHealthCheck();
tryOpenSharedBookFromUrl();
tryOpenSharedLinkFromUrl();
$("#sendBtn").onclick = () => sendChat();
renderMemoryList();
renderStickerManageGrid();

// ============================================================
// Supabase 云端记忆状态显示
// ============================================================
function updateSupabaseStatus() {
  const el = $("#supabaseStatus");
  if (!el) return;
  if (window.Memory && window.Memory.isReady && window.Memory.isReady()) {
    el.innerHTML = "☁️ Leith 已接上云端记忆（对话 + 桌面 + 共读 + 健康记录同步）";
    el.style.borderColor = "var(--accent-dim)";
    el.style.color = "var(--accent)";
  } else {
    const err = (window.Memory && window.Memory.getError) ? window.Memory.getError() : "";
    el.innerHTML = err
      ? `⚠️ 云端记忆：未连接（${err}）`
      : "📦 云端记忆：未连接（使用本地模式）";
    el.style.borderColor = "var(--line)";
    el.style.color = "var(--paper-dim)";
  }
}

// 测试连接按钮
if ($("#testSupabaseBtn")) {
  $("#testSupabaseBtn").addEventListener("click", async () => {
    showToast("正在测试连接...");
    const ok = await window.testSupabaseConnection();
    if (ok) {
      window.Memory = SupabaseMemoryAdapter;
      showToast("✅ 云端连接成功");
      await restoreCloudAppState();
      renderMemoryList();
      await restoreCloudConversationIfNeeded();
    } else {
      if (window.isLeithLockEnabled && window.isLeithLockEnabled()) {
        showMemoryLockScreen("请先输入记忆密码");
      } else {
        showToast("❌ 连接失败，请检查网络和配置");
      }
    }
    updateSupabaseStatus();
  });
}

window.addEventListener("leith:supabase-ready", async (event) => {
  updateSupabaseStatus();
  if (event.detail && event.detail.ok) {
    if (!event.detail.dailyLocked) hideMemoryLockScreen();
    await restoreCloudAppState();
    renderMemoryList();
    await restoreCloudConversationIfNeeded();
    if (!event.detail.dailyLocked) {
      checkAndGenerateDiary({ silent: true }).catch(e => console.error("日记检查失败:", e));
    }
  } else if (event.detail && event.detail.locked) {
    if (isSharedReadingEntry()) hideMemoryLockScreen();
    else showMemoryLockScreen();
  }
});

// 每日锁屏期间：第一位密码输入后，在已有有效会话的保护下悄悄整理昨天；
// 新设备则会在成功解锁事件后走同一条幂等检查，不会重复生成。
window.addEventListener('leith:daily-unlock-typing', () => {
  checkAndGenerateDiary({ silent: true }).catch(e => console.error('后台日记生成失败:', e));
});
window.addEventListener('leith:memory-unlocked', () => {
  // 密码确认成功是最可靠的补写时机：即使早先网络/模型失败留下了短暂冷却，也立刻再试。
  checkAndGenerateDiary({ silent: true, forceRetry: true }).catch(e => console.error('解锁后日记生成失败:', e));
});
window.addEventListener('leith:diary-status', (event) => {
  const status = event.detail?.status;
  if (status === 'complete') {
    showToast('📔 Leith 已经写好昨日日记');
    if ($('#diaryBookPage')) renderDiaryBook().catch(() => {});
  } else if (status === 'retry') {
    showToast('日记这次没写成，Leith 会自动再试，不会跳过这一天');
  }
});

// Supabase 连接是异步的（DOMContentLoaded 触发），延迟刷新状态
setTimeout(updateSupabaseStatus, 2000);
setTimeout(updateSupabaseStatus, 5000);

// 每日日记：开屏尽量在用户看到聊天界面之前就出现，而不是加载完聊天界面后又突然打断——
// 先根据本地记录快速判断"今天有没有可能需要处理"，需要的话立刻显示开屏占位，
// 实际的检查和处理等云端连接稳定后再执行，执行完再让开屏淡出
(function scheduleDiaryCheckWithEarlySplash() {
  // 云端初始化/每日解锁事件负责首次检查；这里仅作为网络较慢时的兜底。
  setTimeout(() => {
    if (!document.hidden) checkAndGenerateDiary({ silent: true }).catch(e => console.error("日记检查失败:", e));
  }, 6000);
})();
setInterval(() => { if (!document.hidden) checkAndGenerateDiary({ silent: true }).catch(e => console.error("日记检查失败:", e)); }, 30 * 60 * 1000);
// 分层汇总检查频率低得多——内部本身已经做了"今天查过就跳过"，这里只要保证每次开App都会过一遍
setTimeout(() => { checkAndGenerateRollups().catch(e => console.error("日记汇总检查失败:", e)); }, 9000);
