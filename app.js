// ============================================================
// app.js — Leith·Home 主逻辑
// v7：加入底部导航 + 小世界（钱包/商店/背包）框架
// ============================================================

const LS = {
  providers: "companion_providers_v1",
  activeProviderId: "companion_active_provider_v1",
  apiKey: "companion_api_key_v1",
  model: "companion_model_v1",
  customModel: "companion_custom_model_v1",
  temp: "companion_temp_v1",
  systemPrompt: "companion_system_prompt_v1",
  threads: "companion_threads_v1",
  activeThreadId: "companion_active_thread_v1",
  threadMsgPrefix: "companion_thread_msgs_",
  // 小世界
  worldAllowance: "companion_world_allowance_v1",   // 每日定额开关+金额
  worldWallets: "companion_world_wallets_v1",       // { [threadId]: number } Leith的零花钱
  worldInventories: "companion_world_inventories_v1", // { [threadId]: [{id,shop, name, emoji, price, boughtAt}] }
  worldAllowanceLog: "companion_world_allowance_log_v1", // { [dateStr]: [threadId, ...] } 防止重复发
  worldSavings: "companion_world_savings_v1",       // { [threadId]: number } 限定商品基金
  worldGiftRecords: "companion_world_gifts_v1",     // { [threadId]: [{id, name, emoji, price, giftedAt}] } Leith赠送区
  worldLimitedItems: "companion_world_limited_v1",  // [{id, name, emoji, price}] 全局限定商品区
  worldAdultItems: "companion_world_adult_v1",      // [{id, name, emoji, price}] 全局成人用品区
  worldAdultBought: "companion_world_adult_bought_v1", // { [threadId]: Set of itemIds } 每个窗口已买的成人用品
  worldNightstand: "companion_world_nightstand_v1", // { [threadId]: [{id, name, emoji, price, boughtAt}] } 床头柜
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

// 小世界规则（只注入一次到 system prompt，不随每条消息重复发送）
const WORLD_RULES = `【小世界规则】
[LGIFT:商品名] 送用户限定商品→限定基金扣款，商品下架进赠送区
[ABUY:商品名] 买成人用品→零花钱扣款，进床头柜，每窗口限买一次
[BUY:商店:商品名] Leith自己买东西→零花钱扣款进背包
商品名需匹配关键词；余额不足则失败；标记写在回复末尾`;

// 历史消息自动裁剪阈值（不再自动触发，仅保留函数供手动调用）
const MSG_PRUNE_THRESHOLD = 40;
const MSG_PRUNE_KEEP = 20;

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

// ============================================================
// 工具函数
// ============================================================
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function showModal(title, msg) {
  $("#modalTitle").innerText = title;
  $("#modalMsg").innerText = msg;
  $("#modalOverlay").classList.remove("hidden");
}
$("#closeModalBtn").onclick = () => $("#modalOverlay").classList.add("hidden");

let toastTimer = null;
function showToast(msg) {
  const t = $("#toast");
  t.innerText = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function escapeHtml(str) {
  const div = document.createElement("div");
  div.innerText = str;
  return div.innerHTML;
}

function renderBubbleContent(text) {
  // 先去掉 [BUY:...] [GIFT:...] [LGIFT:...] 标记（用户不需要看到这些）
  const cleaned = text.replace(/\[(?:BUY|GIFT|LGIFT|ABUY):[^\]]+\]/g, "").trim();
  const escaped = escapeHtml(cleaned);
  const parts = escaped.split(/("[^"]*")/g);
  return parts.map(p => {
    if (p.startsWith("\"") && p.endsWith("\"")) {
      return `<span class="dialogue-text">${p}</span>`;
    } else if (p.trim().length > 0) {
      return `<span class="action-text">${p}</span>`;
    }
    return p;
  }).join("");
}

// ============================================================
// 页面切换（底部导航）
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

  if (pageId === "page-world") renderWorldPage();
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
}

// 获取某个对话的 Leith 背包
function getInventory(threadId) {
  const invs = loadJSON(LS.worldInventories, {});
  return invs[threadId] || [];
}

function addInventoryItem(threadId, item) {
  const invs = loadJSON(LS.worldInventories, {});
  if (!invs[threadId]) invs[threadId] = [];
  invs[threadId].push({ ...item, id: uid(), boughtAt: Date.now() });
  saveJSON(LS.worldInventories, invs);
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
function getAdultBought(threadId) {
  const bought = loadJSON(LS.worldAdultBought, {});
  return bought[threadId] || [];
}
function addAdultBought(threadId, itemId) {
  const bought = loadJSON(LS.worldAdultBought, {});
  if (!bought[threadId]) bought[threadId] = [];
  if (!bought[threadId].includes(itemId)) bought[threadId].push(itemId);
  saveJSON(LS.worldAdultBought, bought);
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

// ===== 床头柜（每个对话独立）=====
function getNightstand(threadId) {
  const ns = loadJSON(LS.worldNightstand, {});
  return ns[threadId] || [];
}

function addNightstandItem(threadId, item) {
  const ns = loadJSON(LS.worldNightstand, {});
  if (!ns[threadId]) ns[threadId] = [];
  ns[threadId].push({ id: uid(), name: item.name, emoji: item.emoji, price: item.price, boughtAt: Date.now() });
  saveJSON(LS.worldNightstand, ns);
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
function renderWorldPage() {
  maybeGiveDailyAllowance();

  const threadId = getActiveThreadId();
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const giftRecords = getGiftRecords(threadId);
  const limitedItems = getLimitedItems();
  const adultItems = getAdultItems();
  const adultBought = getAdultBought(threadId);
  const nightstand = getNightstand(threadId);
  const allowanceCfg = getAllowanceConfig();

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
        renderWorldPage();
        showToast("已下架");
      });
    });
  }

  // 成人用品区（全局，但每窗口独立购买状态）
  const adultGrid = $("#adultGrid");
  const availableAdult = adultItems.filter(i => !adultBought.includes(i.id));
  if (!adultItems.length) {
    adultGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">🔞</div><p>还没有商品</p></div>`;
  } else if (!availableAdult.length) {
    adultGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">🔞</div><p>都买完了，去床头柜看</p></div>`;
  } else {
    adultGrid.innerHTML = availableAdult.map(item => `
      <div class="inventory-item">
        <div class="item-emoji">${item.emoji || "🔞"}</div>
        <div>${escapeHtml(item.name)}</div>
        <div class="item-name">你买免费 · Leith¥${item.price}</div>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <button class="btn btn-primary btn-sm" style="font-size:10px;padding:3px 8px;" data-adult-buy="${item.id}">购买</button>
          <button class="btn btn-danger btn-sm" style="font-size:10px;padding:3px 8px;" data-adult-del="${item.id}">下架</button>
        </div>
      </div>
    `).join("");
    adultGrid.querySelectorAll("[data-adult-buy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = adultItems.find(i => i.id === btn.dataset.adultBuy);
        if (!item) return;
        // 你买成人用品：免费，直接进床头柜
        addNightstandItem(threadId, { ...item, boughtBy: "user" });
        addAdultBought(threadId, item.id);
        showToast(`已购买 ${item.emoji} ${item.name}（免费）`);
        // 发送旁白给 Leith
        notifyLeithAdultPurchase(item.name);
        renderWorldPage();
      });
    });
    adultGrid.querySelectorAll("[data-adult-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (confirm("确定下架这个商品？")) {
          removeAdultItem(btn.dataset.adultDel);
          renderWorldPage();
          showToast("已下架");
        }
      });
    });
  }

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

  // 床头柜
  const nsGrid = $("#nightstandGrid");
  if (!nightstand.length) {
    nsGrid.innerHTML = `<div class="world-empty" style="grid-column:1/-1;"><div class="emoji">🛏️</div><p>还没有东西</p></div>`;
  } else {
    nsGrid.innerHTML = nightstand.map(item => `
      <div class="inventory-item">
        <div class="item-emoji">${item.emoji || "📦"}</div>
        <div>${escapeHtml(item.name)}</div>
        <div class="item-name">${item.boughtBy === "leith" ? "Leith买的" : "你买的"}</div>
      </div>
    `).join("");
  }
}

// 你买成人用品后，在对话框生成旁白并自动发给 Leith
function notifyLeithAdultPurchase(itemName) {
  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);

  // 生成旁白消息（用 user 角色，内容是旁白格式）
  const narration = `（Susie 买了一件${itemName}，放到了床头柜上。）`;
  const msg = { role: "user", content: narration, _id: uid() };
  messages.push(msg);
  renderMessage(msg);
  saveThreadMessages(threadId, messages);
  renderThreadList();

  // 自动触发 Leith 回复
  const box = $("#chatBox");
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  row.appendChild(bubble);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;

  // 调用 sendChat 的核心逻辑（不读 userInput，直接用旁白作为最后消息）
  setTimeout(() => autoRespondToNarration(threadId, bubble, row), 600);
}

// 自动回复旁白（复用 sendChat 的 API 逻辑）
async function autoRespondToNarration(threadId, bubble, row) {
  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const customModel = ($("#customModelInput").value || "").trim();
  const model = customModel || $("#modelSelect").value;
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
    const messages = getThreadMessages(threadId).filter(m => m.type !== "sticker");
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
    freshMessages.push({ role: "assistant", content: fullReply, _id: uid() });
    saveThreadMessages(threadId, freshMessages);
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
          freshMessages.push({ role: "assistant", content: partial, _id: uid() });
          saveThreadMessages(threadId, freshMessages);
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
    renderWorldPage();
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
    renderWorldPage();
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
    renderWorldPage();
    showToast(`限定商品基金 +¥${amount}`);
  });
}

// 限定商品上架按钮
function initAddLimitedBtn() {
  $("#addLimitedBtn").addEventListener("click", () => {
    const name = prompt("商品名称（你想买但舍不得买的东西）", "");
    if (name === null || !name.trim()) return;
    const priceStr = prompt("价格（数字）", "");
    if (priceStr === null) return;
    const price = parseInt(priceStr, 10);
    if (isNaN(price) || price <= 0) return showToast("请输入有效价格");
    addLimitedItem({ name: name.trim(), price });
    renderWorldPage();
    showToast(`已上架：${name}（¥${price}）`);
  });
}

// 成人用品添加按钮
function initAddAdultBtn() {
  $("#addAdultBtn").addEventListener("click", () => {
    const name = prompt("商品名称", "");
    if (name === null || !name.trim()) return;
    const priceStr = prompt("价格（数字）", "");
    if (priceStr === null) return;
    const price = parseInt(priceStr, 10);
    if (isNaN(price) || price <= 0) return showToast("请输入有效价格");
    addAdultItem({ name: name.trim(), price });
    renderWorldPage();
    showToast(`已添加：${name}（¥${price}）`);
  });
}

// 商店商品目录（具体商品）
const SHOP_CATALOG = {
  supermarket: {
    name: "超市",
    icon: "🏪",
    items: [
      { name: "可乐", emoji: "🥤", price: 5 },
      { name: "黄瓜味薯片", emoji: "🍟", price: 8 },
      { name: "明治雪吻巧克力", emoji: "🍫", price: 12 },
      { name: "草莓牛奶", emoji: "🥛", price: 10 },
      { name: "便利店饭团", emoji: "🍙", price: 7 },
      { name: "创可贴", emoji: "🩹", price: 6 },
      { name: "润唇膏", emoji: "💄", price: 25 },
    ]
  },
  cafe: {
    name: "咖啡&食物",
    icon: "🍰",
    items: [
      { name: "冰美式", emoji: "☕", price: 22 },
      { name: "燕麦拿铁", emoji: "☕", price: 28 },
      { name: "抹茶拿铁", emoji: "🍵", price: 30 },
      { name: "草莓奶油蛋糕", emoji: "🍰", price: 35 },
      { name: "火腿可颂", emoji: "🥐", price: 18 },
      { name: "提拉米苏", emoji: "🍮", price: 32 },
    ]
  },
  flower: {
    name: "花店",
    icon: "🌸",
    items: [
      { name: "三支红玫瑰", emoji: "🌹", price: 30 },
      { name: "一束向日葵", emoji: "🌻", price: 45 },
      { name: "白色雏菊", emoji: "🌼", price: 25 },
      { name: "薰衣草干花", emoji: "💜", price: 20 },
      { name: "熊童子多肉", emoji: "🪴", price: 15 },
      { name: "满天星花束", emoji: "✨", price: 35 },
    ]
  },
  bookstore: {
    name: "书店",
    icon: "📚",
    items: [
      { name: "《小王子》", emoji: "📖", price: 28 },
      { name: "《人间失格》", emoji: "📕", price: 32 },
      { name: "《飞鸟集》", emoji: "📗", price: 25 },
      { name: "明信片套装", emoji: "💌", price: 15 },
      { name: "Moleskine手账", emoji: "📓", price: 50 },
      { name: "黄铜书签", emoji: "🔖", price: 18 },
    ]
  }
};

function initShopCards() {
  document.querySelectorAll(".shop-card").forEach(card => {
    card.addEventListener("click", () => {
      const shopId = card.dataset.shop;
      const shop = SHOP_CATALOG[shopId];
      if (!shop) return;
      openShopDetailPage(shop, shopId);
    });
  });
}

// 打开商店详情页（不是弹窗，是页面内切换）
function openShopDetailPage(shop, shopId) {
  const threadId = getActiveThreadId();

  // 填充标题
  $("#shopDetailIcon").innerText = shop.icon;
  $("#shopDetailTitle").innerText = shop.name;

  // 填充商品列表
  const list = $("#shopItemsList");
  list.innerHTML = "";
  shop.items.forEach(item => {
    const row = document.createElement("div");
    row.className = "shop-item-row";
    row.innerHTML = `
      <div class="shop-item-info">
        <span class="shop-item-emoji">${item.emoji}</span>
        <div>
          <div class="shop-item-name">${escapeHtml(item.name)}</div>
          <div class="shop-item-price">¥${item.price}</div>
        </div>
      </div>
      <button class="shop-item-buy-btn" data-shop="${shopId}" data-item-name="${escapeHtml(item.name)}" data-item-emoji="${item.emoji}" data-item-price="${item.price}">送给他</button>
    `;
    list.appendChild(row);
  });

  // 绑定购买按钮（你买 = 不花钱，直接进 Leith 背包）
  list.querySelectorAll(".shop-item-buy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = {
        shop: btn.dataset.shop,
        name: btn.dataset.itemName,
        emoji: btn.dataset.itemEmoji,
        price: parseInt(btn.dataset.itemPrice, 10),
        giftedBy: "user",  // 你送的
      };
      giftToLeith(threadId, item);
      // 按钮变成"已送"状态
      btn.innerText = "已送 ✓";
      btn.style.background = "var(--bg-input)";
      btn.style.color = "var(--paper-dim)";
      btn.disabled = true;
    });
  });

  // 显示商店详情页，隐藏商店列表
  document.querySelector(".world-page").style.display = "none";
  $("#shopDetailPage").classList.add("active");
}

// 返回商店列表
function initShopBackBtn() {
  $("#shopBackBtn").addEventListener("click", () => {
    $("#shopDetailPage").classList.remove("active");
    document.querySelector(".world-page").style.display = "";
    renderWorldPage();  // 刷新背包
  });
}

// 你买东西送给 Leith（你不花钱，东西进他背包）
function giftToLeith(threadId, item) {
  addInventoryItem(threadId, item);
  showToast(`${item.emoji} ${item.name} 已送给 Leith`);
}

// ============================================================
// 判断运行环境
// ============================================================
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isPWAStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
      || navigator.standalone === true;
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
}

function getThreadMessages(threadId) {
  return loadJSON(LS.threadMsgPrefix + threadId, []);
}
function saveThreadMessages(threadId, messages) {
  saveJSON(LS.threadMsgPrefix + threadId, messages);
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

// 历史消息自动裁剪：超过阈值时保留最新 N 条
function pruneOldMessages(threadId) {
  const msgs = getThreadMessages(threadId);
  if (msgs.length <= MSG_PRUNE_THRESHOLD) return false;
  // 保留旁白消息（余额通知等），只裁剪普通消息
  const narrations = msgs.filter(m => m._isNarration);
  const regular = msgs.filter(m => !m._isNarration);
  const kept = regular.slice(-MSG_PRUNE_KEEP);
  saveThreadMessages(threadId, [...narrations, ...kept]);
  return true;
}

function createNewThread() {
  const threads = getThreads();
  const t = { id: uid(), name: `对话 ${threads.length + 1}`, createdAt: Date.now() };
  threads.push(t);
  saveThreads(threads);
  setActiveThreadId(t.id);
  renderThreadList();
  loadActiveThreadIntoChat();
  closeThreadPanel();
}

function deleteThread(id) {
  let threads = getThreads();
  if (threads.length <= 1) {
    showModal("无法删除", "至少需要保留一个对话。");
    return;
  }
  threads = threads.filter(t => t.id !== id);
  saveThreads(threads);
  localStorage.removeItem(LS.threadMsgPrefix + id);
  // 同时清掉钱包和背包
  const wallets = loadJSON(LS.worldWallets, {});
  delete wallets[id];
  saveJSON(LS.worldWallets, wallets);
  const invs = loadJSON(LS.worldInventories, {});
  delete invs[id];
  saveJSON(LS.worldInventories, invs);
  const savings = loadJSON(LS.worldSavings, {});
  delete savings[id];
  saveJSON(LS.worldSavings, savings);
  const gifts = loadJSON(LS.worldGiftRecords, {});
  delete gifts[id];
  saveJSON(LS.worldGiftRecords, gifts);
  const ns = loadJSON(LS.worldNightstand, {});
  delete ns[id];
  saveJSON(LS.worldNightstand, ns);
  const sav = loadJSON(LS.worldSavings, {});
  delete sav[id];
  saveJSON(LS.worldSavings, sav);
  const ab = loadJSON(LS.worldAdultBought, {});
  delete ab[id];
  saveJSON(LS.worldAdultBought, ab);

  if (getActiveThreadId() === id) {
    setActiveThreadId(threads[0].id);
    loadActiveThreadIntoChat();
  }
  renderThreadList();
}

function switchThread(id) {
  setActiveThreadId(id);
  renderThreadList();
  loadActiveThreadIntoChat();
  closeThreadPanel();
  // 如果当前在小世界页面，刷新钱包显示
  if (activePage === "page-world") renderWorldPage();
}

function renderThreadList() {
  const list = $("#threadList");
  const threads = getThreads().slice().sort((a, b) => b.createdAt - a.createdAt);
  const activeId = getActiveThreadId();
  list.innerHTML = "";
  threads.forEach(t => {
    const msgs = getThreadMessages(t.id);
    const last = msgs[msgs.length - 1];
    const preview = last ? (last.type === "sticker" ? "[表情包]" : last.content) : "还没有消息";

    const item = document.createElement("div");
    item.className = "thread-item" + (t.id === activeId ? " active" : "");
    item.innerHTML = `
      <div class="thread-info">
        <div class="thread-name">${escapeHtml(t.name)}</div>
        <div class="thread-preview">${escapeHtml(preview)}</div>
      </div>
      <button class="thread-del" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
      </button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".thread-del")) return;
      switchThread(t.id);
    });
    item.querySelector(".thread-del").addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`删除对话[${t.name}]？聊天记录也会一并删除。`)) {
        deleteThread(t.id);
      }
    });
    list.appendChild(item);
  });
}

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
    box.scrollTop = box.scrollHeight;
  }
  renderTokenBanner();
}

$("#newThreadBtn").onclick = createNewThread;

function openThreadPanel() {
  $("#threadPanel").classList.add("open");
  $("#threadOverlay").classList.add("open");
}
function closeThreadPanel() {
  $("#threadPanel").classList.remove("open");
  $("#threadOverlay").classList.remove("open");
}
$("#openThreadBtn").onclick = () => { renderThreadList(); openThreadPanel(); };
$("#closeThreadBtn").onclick = closeThreadPanel;
$("#threadOverlay").onclick = closeThreadPanel;

// ============================================================
// 服务商管理
// ============================================================
let providers = loadJSON(LS.providers, DEFAULT_PROVIDERS);
let activeProviderId = localStorage.getItem(LS.activeProviderId) || (providers[0] && providers[0].id);

function getActiveProvider() {
  return providers.find(p => p.id === activeProviderId) || providers[0];
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
  const savedModel = localStorage.getItem(LS.model);
  if (savedModel && active.models.includes(savedModel)) sel.value = savedModel;
}

function updateStatusLabel() {
  const active = getActiveProvider();
  const key = localStorage.getItem(LS.apiKey);
  $("#statusLabel").innerText = active ? (key ? `已连接 · ${active.name}` : `未连接 · ${active.name}`) : "未配置服务商";
}

// ============================================================
// 设置抽屉开关
// ============================================================
function openDrawer() {
  $("#settingsDrawer").classList.add("open");
  $("#drawerOverlay").classList.add("open");
}
function closeDrawer() {
  $("#settingsDrawer").classList.remove("open");
  $("#drawerOverlay").classList.remove("open");
}
$("#openSettingsBtn").onclick = openDrawer;
$("#closeDrawerBtn").onclick = closeDrawer;
$("#drawerOverlay").onclick = closeDrawer;

// ============================================================
// 配置加载 / 保存
// ============================================================
function initConfig() {
  const savedKey = localStorage.getItem(LS.apiKey);
  const savedTemp = localStorage.getItem(LS.temp);
  const savedSystemPrompt = localStorage.getItem(LS.systemPrompt);
  const savedCustomModel = localStorage.getItem(LS.customModel);

  if (savedKey) $("#apiKey").value = savedKey;
  if (savedTemp) { $("#tempInput").value = savedTemp; $("#tempVal").innerText = savedTemp; }
  if (savedSystemPrompt !== null) $("#systemPromptInput").value = savedSystemPrompt;
  if (savedCustomModel) $("#customModelInput").value = savedCustomModel;

  renderProviderList();
  populateModelSelect();
  updateStatusLabel();

  // 加载搜索代理配置
  const savedProxy = localStorage.getItem(SEARCH_PROXY_LS);
  if (savedProxy && $("#searchProxyInput")) $("#searchProxyInput").value = savedProxy;

  ensureAtLeastOneThread();
  renderThreadList();
  loadActiveThreadIntoChat();
}

$("#tempInput").addEventListener("input", (e) => { $("#tempVal").innerText = e.target.value; });

$("#saveConfigBtn").onclick = () => {
  const key = $("#apiKey").value.trim();
  if (!key) return showModal("提示", "API Key 不能为空。");
  localStorage.setItem(LS.apiKey, key);
  localStorage.setItem(LS.model, $("#modelSelect").value);
  localStorage.setItem(LS.customModel, $("#customModelInput").value.trim());
  localStorage.setItem(LS.temp, $("#tempInput").value);
  localStorage.setItem(LS.systemPrompt, $("#systemPromptInput").value);
  updateStatusLabel();
  showToast("配置已保存");
};

$("#clearKeyBtn").onclick = () => {
  localStorage.removeItem(LS.apiKey);
  $("#apiKey").value = "";
  updateStatusLabel();
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

function openStickerPanel() { renderStickerPickerGrid(); $("#stickerPanel").classList.add("open"); }
function closeStickerPanel() { $("#stickerPanel").classList.remove("open"); }
$("#openStickerPanelBtn").onclick = openStickerPanel;
$("#closeStickerPanelBtn").onclick = closeStickerPanel;

function sendSticker(sticker) {
  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  const msg = { role: "user", type: "sticker", content: sticker.label || "[表情包]", dataUrl: sticker.dataUrl, _id: uid() };
  messages.push(msg);
  renderMessage(msg);
  saveThreadMessages(threadId, messages);
  closeStickerPanel();
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
      bubble.innerText = msg.content;
    }
  }

  row.appendChild(bubble);

  // 用户消息：加编辑按钮
  if (msg.role === "user" && msg.type !== "sticker") {
    const editBtn = document.createElement("button");
    editBtn.className = "msg-action-btn";
    editBtn.title = "编辑";
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    editBtn.onclick = () => startEditMessage(row, msg);
    row.appendChild(editBtn);
  }

  // AI 消息：加重新生成按钮
  if (msg.role === "assistant") {
    const regenBtn = document.createElement("button");
    regenBtn.className = "msg-action-btn";
    regenBtn.title = "重新生成";
    regenBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`;
    regenBtn.onclick = () => regenerateMessage(msg._id);
    row.appendChild(regenBtn);
  }

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
  // 选取模式下隐藏编辑/重新生成按钮，避免遮挡 checkbox
  row.querySelectorAll(".msg-action-btn").forEach(b => b.style.display = "none");
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
    // 恢复编辑/重新生成按钮
    row.querySelectorAll(".msg-action-btn").forEach(b => b.style.display = "");
  });
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

  row.querySelectorAll(".msg-action-btn").forEach(b => b.style.display = "none");

  btnRow.querySelector("#cancelEditBtn").onclick = () => {
    bubble.innerText = originalText;
    row.querySelectorAll(".msg-action-btn").forEach(b => b.style.display = "");
  };

  btnRow.querySelector("#confirmEditBtn").onclick = () => {
    const newText = textarea.value.trim();
    if (!newText || newText === originalText) {
      bubble.innerText = originalText;
      row.querySelectorAll(".msg-action-btn").forEach(b => b.style.display = "");
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
  const customModel = ($("#customModelInput").value || "").trim();
  const model = customModel || $("#modelSelect").value;
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
    let messages = getThreadMessages(threadId).filter(m => m.type !== "sticker");
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
    freshMessages.push({ role: "assistant", content: fullReply, _id: uid() });
    saveThreadMessages(threadId, freshMessages);
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
          freshMessages.push({ role: "assistant", content: partial, _id: uid() });
          saveThreadMessages(threadId, freshMessages);
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
  const lineHeight = 22;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px sans-serif`;

  function wrapText(text, maxWidth) {
    const lines = [];
    let current = "";
    for (const ch of text) {
      const test = current + ch;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = ch;
      } else {
        current = test;
      }
      if (ch === "\n") { lines.push(current.slice(0, -1)); current = ""; }
    }
    if (current) lines.push(current);
    return lines;
  }

  const items = messages.map(m => {
    const isSticker = m.type === "sticker";
    const label = m.role === "user" ? "我" : "Leith";
    const text = isSticker ? "[表情包]" : m.content;
    const lines = isSticker ? [] : wrapText(text, maxBubbleWidth - 24);
    const bubbleHeight = isSticker ? 100 : (lines.length * lineHeight + 20);
    return { m, label, lines, isSticker, bubbleHeight };
  });

  const totalHeight = padding * 2 + items.reduce((sum, it) => sum + it.bubbleHeight + bubbleGap + 18, 0);

  const dpr = window.devicePixelRatio || 2;
  canvas.width = width * dpr;
  canvas.height = totalHeight * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = totalHeight + "px";
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#0D1017";
  ctx.fillRect(0, 0, width, totalHeight);

  let y = padding;
  for (const it of items) {
    const isUser = it.m.role === "user";
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#7C879C";
    ctx.textAlign = isUser ? "right" : "left";
    ctx.fillText(it.label, isUser ? width - padding : padding, y + 10);
    y += 18;

    const bubbleW = it.isSticker ? 100 : Math.min(maxBubbleWidth, Math.max(...it.lines.map(l => ctx.measureText(l).width), 0) + 24);
    const bubbleX = isUser ? width - padding - bubbleW : padding;

    ctx.beginPath();
    roundRect(ctx, bubbleX, y, bubbleW, it.bubbleHeight, 14);
    ctx.fillStyle = isUser ? "#4A7BB5" : "#161B26";
    ctx.fill();

    if (it.isSticker) {
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#7C879C";
      ctx.textAlign = "center";
      ctx.fillText("[表情包]", bubbleX + bubbleW / 2, y + it.bubbleHeight / 2 + 4);
    } else {
      ctx.font = "15px sans-serif";
      ctx.fillStyle = isUser ? "#0A1622" : "#E7ECF5";
      ctx.textAlign = "left";
      it.lines.forEach((line, i) => {
        ctx.fillText(line, bubbleX + 12, y + 24 + i * lineHeight);
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
let tokenBannerDismissedForThread = {};

function estimateTokens(threadId) {
  const messages = getThreadMessages(threadId);
  const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  return Math.round(totalChars / 1.7);
}

function renderTokenBanner() {
  const threadId = getActiveThreadId();
  const slot = $("#tokenBannerSlot");
  slot.innerHTML = "";

  if (tokenBannerDismissedForThread[threadId]) return;

  const estTokens = estimateTokens(threadId);
  if (estTokens < TOKEN_WARN_THRESHOLD) return;

  const banner = document.createElement("div");
  banner.className = "token-banner";
  banner.innerHTML = `
    <div class="token-banner-text">这个对话已经积累了约 <b>${estTokens.toLocaleString()}</b> token。继续聊没问题，只是提醒一下——如果有想保留的片段，可以先选取导出，再开一个新对话，读取会更轻快。</div>
    <div class="token-banner-actions">
      <button id="tokenBannerNewThread">开新对话</button>
      <button id="tokenBannerDismiss">知道了</button>
    </div>
  `;
  slot.appendChild(banner);

  banner.querySelector("#tokenBannerNewThread").onclick = () => {
    createNewThread();
  };
  banner.querySelector("#tokenBannerDismiss").onclick = () => {
    tokenBannerDismissedForThread[threadId] = true;
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
$("#sendBtn").onclick = () => sendChat();

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
    description: "搜索网页获取实时信息。搜不到就基于已有知识回答，不要重试。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，用英文或精炼的中文" }
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

async function duckDuckGoSearch(query) {
  // 第一路：Instant Answer API，原生 CORS，免代理，最稳
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
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
  } catch (e) { /* 降级 */ }

  // 第二路：HTML 版 + 代理降级
  const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const customProxy = getSearchProxy();
  const proxies = customProxy
    ? [{ url: customProxy, encode: true }]
    : FALLBACK_PROXIES;

  let lastErr = null;
  for (const proxy of proxies) {
    const fetchUrl = proxy.encode ? proxy.url + encodeURIComponent(targetUrl) : proxy.url + targetUrl;
    try {
      const resp = await fetch(fetchUrl, { headers: { "Accept": "text/html" } });
      if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status}`); continue; }
      const html = await resp.text();
      if (!html || html.length < 200) { lastErr = new Error("返回内容过短"); continue; }
      const parsed = parseDuckDuckGoHtml(html);
      if (parsed) return parsed;
      lastErr = new Error("解析不到结果");
    } catch (e) {
      lastErr = e;
    }
  }
  // 两路都失败，给 AI 一个明确反馈，让它别卡住
  return `搜索暂时不可用（${lastErr?.message || "网络问题"}）。请基于你已有的知识回答，或建议用户稍后再试、或换个搜索代理。`;
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

// 拼接联网相关的系统提示（时间感知 + 工具说明）
function buildWebPromptBlock() {
  if (!webEnabled) return "";
  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "short" });
  return `【联网】当前时间：${timeStr}。可用 web_search 工具搜索实时信息。`;
}

async function buildEffectiveSystemPrompt() {
  const base = localStorage.getItem(LS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
  const memoryBlock = window.Memory ? await window.Memory.asPromptBlock() : "";
  const worldBlock = buildWorldPromptBlock();
  const webBlock = buildWebPromptBlock();
  const noteBlock = buildSystemNotesBlock();
  // WORLD_RULES 只注入一次（不随消息重复）
  return [WORLD_RULES, base.trim(), memoryBlock.trim(), noteBlock.trim(), worldBlock.trim(), webBlock.trim()].filter(Boolean).join("\n\n");
}

// 提取最近 3 条旁白作为事件提醒
function buildSystemNotesBlock() {
  const threadId = getActiveThreadId();
  const msgs = getThreadMessages(threadId);
  const notes = msgs.filter(m => m._isNarration).slice(-3);
  if (!notes.length) return "";
  return "【近期事件】\n" + notes.map(m => `- ${m.content}`).join("\n");
}

// 小世界状态（精简版：只报数据，不含规则）
function buildWorldPromptBlock() {
  const threadId = getActiveThreadId();
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const giftRecords = getGiftRecords(threadId);
  const limitedItems = getLimitedItems();
  const adultItems = getAdultItems();
  const adultBought = getAdultBought(threadId);
  const nightstand = getNightstand(threadId);

  const gifts = giftRecords.length ? giftRecords.map(g => `${g.emoji}${g.name}`).join("、") : "无";
  const limited = limitedItems.length ? limitedItems.map(i => `${i.name}¥${i.price}`).join("、") : "无";
  const availableAdult = adultItems.filter(i => !adultBought.includes(i.id));
  const adult = availableAdult.length ? availableAdult.map(i => `${i.name}¥${i.price}`).join("、") : "无";
  const ns = nightstand.length ? nightstand.map(i => `${i.emoji}${i.name}`).join("、") : "空";

  return `【世界状态】零花钱¥${balance} 限定基金¥${savings} 床头柜:${ns}\n赠送记录:${gifts}\n限定商品:${limited}\n可买成人用品:${adult}`;
}

// 解析 AI 回复里的 [BUY:...] [LGIFT:...] [ABUY:...] 标记
function parseAIActions(text) {
  const actions = [];
  const buyRegex = /\[BUY:(\w+):([^\]]+)\]/g;
  const lgiftRegex = /\[LGIFT:([^\]]+)\]/g;
  const abuyRegex = /\[ABUY:([^\]]+)\]/g;

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
  return actions;
}

// 在所有商店里模糊查找商品（精确匹配优先，再模糊包含匹配）
function findItemInShops(itemName) {
  // 先精确匹配
  for (const shopId in SHOP_CATALOG) {
    const item = SHOP_CATALOG[shopId].items.find(i => i.name === itemName);
    if (item) return { ...item, shop: shopId };
  }
  // 再模糊匹配：商品名包含 AI 说的词，或反过来
  for (const shopId in SHOP_CATALOG) {
    const item = SHOP_CATALOG[shopId].items.find(i =>
      i.name.includes(itemName) || itemName.includes(i.name)
    );
    if (item) return { ...item, shop: shopId };
  }
  return null;
}

// 处理 AI 的购买/送礼动作
function handleAIActions(actions) {
  const threadId = getActiveThreadId();
  let needRefresh = false;
  actions.forEach(action => {
    if (action.type === "buy") {
      // Leith 自己买东西：先在指定商店找，找不到再全局模糊找
      let foundItem = null;
      const shop = SHOP_CATALOG[action.shop];
      if (shop) {
        const item = shop.items.find(i => i.name === action.itemName);
        if (item) foundItem = { ...item, shop: action.shop };
      }
      if (!foundItem) {
        foundItem = findItemInShops(action.itemName);
      }
      if (!foundItem) {
        showToast(`Leith 想买"${action.itemName}"但商店里没有`);
        return;
      }
      const balance = getWallet(threadId);
      if (balance < foundItem.price) {
        showToast(`Leith 想买 ${foundItem.name} 但零花钱不足`);
        return;
      }
      setWallet(threadId, balance - foundItem.price);
      addInventoryItem(threadId, { ...foundItem, giftedBy: "leith" });
      insertNarration(threadId, `🛒 Leith在商店买了 ${foundItem.emoji} ${foundItem.name}，花费¥${foundItem.price}。零钱包：¥${balance} → ¥${balance - foundItem.price}`);
      showToast(`Leith 买了 ${foundItem.emoji} ${foundItem.name}（¥${foundItem.price}）`);
      needRefresh = true;
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
      // Leith 买���人用品：从钱包扣，进床头柜
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
      removeAdultItem(adultItem.id);
      addNightstandItem(threadId, adultItem);
      insertNarration(threadId, `🔞 Leith买了成人用品 ${adultItem.emoji} ${adultItem.name}，花费¥${adultItem.price}。零钱包：¥${balance} → ¥${balance - adultItem.price}`);
      showToast(`Leith 买了 ${adultItem.emoji} ${adultItem.name}（¥${adultItem.price}）`);
      needRefresh = true;
    }
  });
  if (needRefresh && activePage === "page-world") renderWorldPage();
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

async function sendChat(overrideContent) {
  // 防止重复发送：如果正在回复中，直接忽略
  if (currentController) return showToast("请先等当前回复结束，或点停止");

  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const customModel = ($("#customModelInput").value || "").trim();
  const model = customModel || $("#modelSelect").value;
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");
  // 支持外部传入文本（编辑消息后重新发送用），否则读输入框
  // 注意：按钮点击时 event 会被当第一个参数传进来，要过滤掉
  const content = (typeof overrideContent === "string" ? overrideContent : userInput.value).trim();

  if (!apiKey) return showModal("提示", "请先在设置里填写并保存 API Key。");
  if (!provider) return showModal("提示", "请先在设置里添加一个服务商。");
  if (!model) return showModal("提示", "请先选择或填写一个模型名称。");
  if (!content) return;

  const threadId = getActiveThreadId();
  const messages = getThreadMessages(threadId);
  const userMsg = { role: "user", content, _id: uid() };
  messages.push(userMsg);
  renderMessage(userMsg);
  userInput.value = "";
  userInput.style.height = "auto";
  saveThreadMessages(threadId, messages);
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
    let textMessages = messages.filter(m => m.type !== "sticker");
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
          box.scrollTop = box.scrollHeight;
        }, tools });
      } else {
        result = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
          lastChunkTime = Date.now();
          hasReceivedContent = true;
          if (searchNotice) { searchNotice.remove(); searchNotice = null; }
          bubble.innerHTML = renderBubbleContent(acc);
          box.scrollTop = box.scrollHeight;
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
    freshMessages.push({ role: "assistant", content: fullReply, _id: uid() });
    saveThreadMessages(threadId, freshMessages);
    renderThreadList();
    renderTokenBanner();

    // 解析 AI 的购买/送礼动作
    const actions = parseAIActions(fullReply);
    if (actions.length) handleAIActions(actions);

    maybeAutoNameThread(threadId, content);
  } catch (err) {
    clearInterval(timeoutTimer);
    if (err.name === "AbortError") {
      if (hasReceivedContent) {
        const partial = bubble.innerText;
        if (partial.trim()) {
          const freshMessages = getThreadMessages(threadId);
          freshMessages.push({ role: "assistant", content: partial, _id: uid() });
          saveThreadMessages(threadId, freshMessages);
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

function maybeAutoNameThread(threadId, firstUserContent) {
  const threads = getThreads();
  const t = threads.find(x => x.id === threadId);
  if (!t || t.name !== "新的对话" && !/^对话 \d+$/.test(t.name)) return;
  t.name = firstUserContent.slice(0, 16) || t.name;
  saveThreads(threads);
  renderThreadList();
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
  // 累积 tool_calls（按 index 聚合，流式 delta 会分片到达）
  const toolCallAcc = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.replace("data: ", "").trim();
      if (jsonStr === "[DONE]") continue;
      try {
        const chunkJson = JSON.parse(jsonStr);
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
      } catch (e) {}
    }
  }
  const toolCalls = Object.keys(toolCallAcc).length
    ? Object.values(toolCallAcc).filter(tc => tc.function.name)
    : null;
  return { text: fullReply, toolCalls };
}

// ---- Anthropic 官方 ----
// 返回 { text, toolCalls } —— 兼容 Anthropic 的 tool_use 内容块
async function streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta, tools }) {
  // Anthropic 的 messages 格式：content 可以是字符串或 content blocks 数组
  // 需要：1) 把历史里的 tool_result 保留为正确格式 2) assistant 的 tool_use 消息保留为 content blocks
  const payloadMessages = messages.map(m => {
    if (Array.isArray(m.content)) return { role: m.role, content: m.content };
    return { role: m.role, content: m.content };
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
  // 当前 content block 的累积
  let currentBlock = null; // { type, text, toolUse: {id, name, input} }
  const toolUses = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.replace("data: ", "").trim();
      if (!jsonStr) continue;
      try {
        const evt = JSON.parse(jsonStr);
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
      } catch (e) {}
    }
  }
  // 转换成统一的 toolCalls 格式（兼容 OpenAI 风格的处理逻辑）
  const toolCalls = toolUses.length ? toolUses.map(tu => ({
    id: tu.id,
    function: { name: tu.name, arguments: JSON.stringify(tu.input) }
  })) : null;
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
// 初始化
// ============================================================
initBottomBar();
initGiveMoneyBtn();
initToggleAllowanceBtn();
initAddSavingsBtn();
initAddLimitedBtn();
initAddAdultBtn();
initShopCards();
initShopBackBtn();
initConfig();
renderMemoryList();
renderStickerManageGrid();
