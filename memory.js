// ============================================================
// 记忆系统接口层（Memory Adapter）
// ------------------------------------------------------------
// app.js 里所有跟"记忆"和"表情包"相关的读写，都只通过这里的函数进行。
// 以后接 Supabase 或其他后端时，只需要把内部实现换掉，
// 外部调用代码不用改。
//
// 当前状态：本地实现（localStorage）。
// ============================================================

const MEMORY_LS_KEY = "companion_memory_v2";
const STICKER_LS_KEY = "companion_stickers_v1";

/**
 * 核心记忆条目结构：
 * {
 *   id: string,
 *   content: string,      // 记忆内容，用户自己写的
 *   createdAt: number,
 *   pinned: boolean        // 是否为"核心"记忆（始终注入 system prompt）
 * }
 *
 * 表情包条目结构：
 * {
 *   id: string,
 *   label: string,         // 标签/使用场景，例如"开心""委屈"
 *   dataUrl: string,       // base64 图片数据（本地存储用）
 *   createdAt: number
 * }
 */

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function writeLS(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}
function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------- 本地实现：核心记忆 ----------------
const LocalMemoryAdapter = {
  async list() {
    return readLS(MEMORY_LS_KEY, []);
  },

  async add(content) {
    const all = await this.list();
    const record = {
      id: genId(),
      content: content.trim(),
      createdAt: Date.now(),
      pinned: true
    };
    all.push(record);
    writeLS(MEMORY_LS_KEY, all);
    return record;
  },

  async remove(id) {
    const all = await this.list();
    writeLS(MEMORY_LS_KEY, all.filter(m => m.id !== id));
  },

  async clear() {
    localStorage.removeItem(MEMORY_LS_KEY);
  },

  // 拼接成一段文字，供插入 system prompt 使用
  async asPromptBlock() {
    const all = await this.list();
    if (!all.length) return "";
    const lines = all.map(m => `- ${m.content}`).join("\n");
    return `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines}`;
  }
};

// ---------------- 本地实现：表情包 ----------------
const LocalStickerAdapter = {
  async list() {
    return readLS(STICKER_LS_KEY, []);
  },

  async add({ label, dataUrl }) {
    const all = await this.list();
    const record = { id: genId(), label: label || "", dataUrl, createdAt: Date.now() };
    all.push(record);
    writeLS(STICKER_LS_KEY, all);
    return record;
  },

  async updateLabel(id, label) {
    const all = await this.list();
    const item = all.find(s => s.id === id);
    if (item) item.label = label;
    writeLS(STICKER_LS_KEY, all);
  },

  async remove(id) {
    const all = await this.list();
    writeLS(STICKER_LS_KEY, all.filter(s => s.id !== id));
  }
};

// ---------------- 云端实现占位（尚未接入）----------------
// 接入 Supabase 时，实现同样方法签名的 SupabaseMemoryAdapter /
// SupabaseStickerAdapter，把下面两行指向新的实现即可。

window.Memory = LocalMemoryAdapter;
window.Stickers = LocalStickerAdapter;
