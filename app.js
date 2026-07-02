// ============================================================
// 存储 key
// ============================================================
const LS = {
  providers: "companion_providers_v1",
  activeProviderId: "companion_active_provider_v1",
  apiKey: "companion_api_key_v1",
  model: "companion_model_v1",
  customModel: "companion_custom_model_v1",
  temp: "companion_temp_v1",
  systemPrompt: "companion_system_prompt_v1",
  threads: "companion_threads_v1",       // 线程列表元信息
  activeThreadId: "companion_active_thread_v1",
  threadMsgPrefix: "companion_thread_msgs_"  // + threadId
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
  const escaped = escapeHtml(text);
  const parts = escaped.split(/(“[^”]*”)/g);
  return parts.map(p => {
    if (p.startsWith("“") && p.endsWith("”")) {
      return `<span class="dialogue-text">${p}</span>`;
    } else if (p.trim().length > 0) {
      return `<span class="action-text">${p}</span>`;
    }
    return p;
  }).join("");
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
      if (confirm(`删除对话「${t.name}」？聊天记录也会一并删除。`)) {
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
      if (confirm(`确认删除服务商「${p.name}」？`)) {
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
  const apiStyle = confirm("这个服务商是 Anthropic 官方接口风格吗？\n「确定」= Anthropic 官方 /messages 结构\n「取消」= OpenAI 兼容 /chat/completions 结构") ? "anthropic" : "openai";

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
    bubble.className = `bubble sticker`;
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

  if (selectMode) {
    applySelectableUI(row, msg._id);
  }

  row.addEventListener("click", () => {
    if (!selectMode) return;
    toggleMessageSelect(row, msg._id);
  });

  box.appendChild(row);
  if (!opts.noScroll) box.scrollTop = box.scrollHeight;
  return bubble;
}

function applySelectableUI(row, msgId) {
  row.classList.add("selectable");
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
  document.querySelectorAll(".msg-row.selectable").forEach(row => row.classList.remove("selectable"));
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

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Leith对话片段_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("已导出为文字文件");
  exitSelectMode();
};

$("#exportImageBtn").onclick = async () => {
  const selected = getSelectedMessagesInOrder();
  if (!selected.length) return showToast("先选几条消息吧");
  await exportSelectionAsImage(selected);
  exitSelectMode();
};

// 用原生 canvas 手绘对话截图，避免引入第三方截图库
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

  // 预计算每条消息的高度
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

  // 背景
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
    const a = document.createElement("a");
    a.href = url;
    a.download = `Leith对话截图_${new Date().toISOString().slice(0,10)}.png`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("截图已保存");
  }, "image/png");
}

// ============================================================
// Token 用量估算 + 提醒（非强制）
// ============================================================
const TOKEN_WARN_THRESHOLD = 6000; // 粗略估算的字符数阈值，达到后提示
let tokenBannerDismissedForThread = {};

function estimateTokens(threadId) {
  const messages = getThreadMessages(threadId);
  const totalChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
  // 粗略换算：中文场景下 1 token 大约对应 1.5-2 个字符，这里取一个中间值仅供参考
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
// 自动扩展输入框高度 + 回车发送
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
  return [base.trim(), memoryBlock.trim()].filter(Boolean).join("\n\n");
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
  const timeoutTimer = setTimeout(() => controller.abort(), 30000);

  try {
    const systemPrompt = await buildEffectiveSystemPrompt();
    // 表情包消息不发给模型（模型收不到图片内容），仅发送文字消息历史
    const textMessages = messages.filter(m => m.type !== "sticker");

    let fullReply = "";
    if (provider.apiStyle === "anthropic") {
      fullReply = await streamAnthropic({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
    } else {
      fullReply = await streamOpenAICompatible({ provider, apiKey, model, temp, systemPrompt, messages: textMessages, controller, onDelta: (acc) => {
        bubble.innerHTML = renderBubbleContent(acc);
        box.scrollTop = box.scrollHeight;
      }});
    }
    clearTimeout(timeoutTimer);

    const freshMessages = getThreadMessages(threadId);
    freshMessages.push({ role: "assistant", content: fullReply, _id: uid() });
    saveThreadMessages(threadId, freshMessages);
    renderThreadList();
    renderTokenBanner();

    // 首次有内容时，尝试用第一句话给对话线程自动命名
    maybeAutoNameThread(threadId, content);
  } catch (err) {
    clearTimeout(timeoutTimer);
    row.remove();
    if (err.name === "AbortError") {
      showModal("请求超时", "30 秒内没有收到响应，检查网络或稍后重试。");
    } else {
      showModal("请求失败", err.message || "网络错误，请检查服务商地址、密钥或跨域设置。");
    }
  } finally {
    sendBtn.disabled = false;
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

// ---- OpenAI 兼容结构 ----
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

// ---- Anthropic 官方结构 ----
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
initConfig();
renderMemoryList();
renderStickerManageGrid();
