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

function addWallet(threadId, delta) {
  const now = getWallet(threadId);
  setWallet(threadId, Math.max(0, now + delta));
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
    showToast(`已给 Leith ¥${amount}`);
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
  if (!row.querySelector(".msg-checkbox")) {
    const cb = document.createElement("div");
    cb.className = "msg-checkbox" + (selectedMessageIds.has(msgId) ? " checked" : "");
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

    userInput.value = newText;
    userInput.focus();
    loadActiveThreadIntoChat();
    sendChat();
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
  sendBtn.disabled = false;

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
        lastChunkTime = Date.now();
        hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
    } else {
      fullReply = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta: (acc) => {
        lastChunkTime = Date.now();
        hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
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
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalSendHTML;
    sendBtn.style.background = originalSendBg;
    sendBtn.style.border = originalSendBorder;
    sendBtn.style.color = originalSendColor;
    sendBtn.onclick = originalSendHandler;
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
$("#sendBtn").onclick = sendChat;

async function buildEffectiveSystemPrompt() {
  const base = localStorage.getItem(LS.systemPrompt) || "";
  const memoryBlock = window.Memory ? await window.Memory.asPromptBlock() : "";
  const worldBlock = buildWorldPromptBlock();
  return [base.trim(), memoryBlock.trim(), worldBlock.trim()].filter(Boolean).join("\n\n");
}

// 把小世界状态拼成提示词，让 Leith 能感知到
function buildWorldPromptBlock() {
  const threadId = getActiveThreadId();
  const balance = getWallet(threadId);
  const savings = getSavings(threadId);
  const giftRecords = getGiftRecords(threadId);
  const limitedItems = getLimitedItems();
  const adultItems = getAdultItems();
  const adultBought = getAdultBought(threadId);
  const nightstand = getNightstand(threadId);

  let giftDesc = "还没有送过用户礼物";
  if (giftRecords.length) {
    giftDesc = giftRecords.map(g => `${g.emoji} ${g.name}`).join("、");
  }

  let limitedList = "\n（空）";
  if (limitedItems.length) {
    limitedList = "\n" + limitedItems.map(i => `  ${i.name} ¥${i.price}`).join("\n");
  }

  // 成人用品只显示这个窗口还没买的
  const availableAdult = adultItems.filter(i => !adultBought.includes(i.id));
  let adultList = "\n（都买完了）";
  if (availableAdult.length) {
    adultList = "\n" + availableAdult.map(i => `  ${i.name} ¥${i.price}`).join("\n");
  }

  let nsDesc = "空的";
  if (nightstand.length) {
    nsDesc = nightstand.map(i => `${i.emoji} ${i.name}`).join("、");
  }

  return `【你的小世界状态】
- 你的零花钱：¥${balance}（你买成人用品从这里扣）
- 限定商品基金：¥${savings}（你送用户限定商品从这里扣）
- 你送过用户的礼物：${giftDesc}
- 床头柜里有：${nsDesc}

【限定商品区】（用户想买但舍不得买的东西，你可以送用户，送了就消失）：${limitedList}

【成人用品区】（还没买的，你可以买，买了进床头柜，用户买的话免费）：${adultList}

【重要规则】
1. 送用户限定商品：回复末尾加 [LGIFT:商品名]，例如 [LGIFT:Switch游戏机]
   → 从限定商品基金扣钱，商品从货架消失，进用户的"Leith赠送区"。要慎重！
2. 买成人用品：回复末尾加 [ABUY:商品名]，例如 [ABUY:丝带]
   → 从你的零花钱扣钱，商品进"床头柜"。每个窗口只能买一次。
3. 商品名要和清单一致（可以不完全相同，但要包含关键词）。
4. 余额不够就不能买/不能送。
5. 送礼物要慎重，在合适的时机。
6. 标记写在回复最末尾，不影响正常对话。`;
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

async function sendChat() {
  const apiKey = localStorage.getItem(LS.apiKey);
  const provider = getActiveProvider();
  const customModel = ($("#customModelInput").value || "").trim();
  const model = customModel || $("#modelSelect").value;
  const temp = parseFloat(localStorage.getItem(LS.temp) || "0.7");
  const content = userInput.value.trim();

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
  sendBtn.disabled = true;

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

  // 发送按钮变成停止按钮
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
    const textMessages = messages.filter(m => m.type !== "sticker");

    let fullReply = "";
    if (provider.apiStyle === "anthropic") {
      fullReply = await streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
        lastChunkTime = Date.now();
        hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
    } else {
      fullReply = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
        lastChunkTime = Date.now();
        hasReceivedContent = true;
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
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
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalSendHTML;
    sendBtn.style.background = originalSendBg;
    sendBtn.style.border = originalSendBorder;
    sendBtn.style.color = originalSendColor;
    sendBtn.onclick = originalSendHandler;
  }
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
async function streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta }) {
  const payloadMessages = [];
  if (systemPrompt.trim()) payloadMessages.push({ role: "system", content: systemPrompt });
  payloadMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

  const resp = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: payloadMessages, stream: true, temperature: temp }),
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
        const deltaText = chunkJson.choices?.[0]?.delta?.content || "";
        fullReply += deltaText;
        onDelta(fullReply);
      } catch (e) {}
    }
  }
  return fullReply;
}

// ---- Anthropic 官方 ----
async function streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages, controller, onDelta }) {
  const payloadMessages = messages.map(m => ({ role: m.role, content: m.content }));

  const resp = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model, max_tokens: 2048,
      system: systemPrompt.trim() || undefined,
      messages: payloadMessages, temperature: temp, stream: true
    }),
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
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          fullReply += evt.delta.text;
          onDelta(fullReply);
        }
      } catch (e) {}
    }
  }
  return fullReply;
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
