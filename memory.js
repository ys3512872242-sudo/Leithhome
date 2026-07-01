// ============================================================
// 记忆系统接口层（Memory Adapter）
// ------------------------------------------------------------
// 设计目的：
//   app.js 里所有跟"记忆"相关的读写，都只通过下面这几个函数进行，
//   不直接碰 localStorage 或某个具体数据库。
//   这样以后接入 Supabase（或别的后端）时，只需要把这个文件内部
//   的实现换掉，外面调用的代码一行都不用改。
//
// 当前状态：本地实现（localStorage），数据不出这台设备。
// 后续状态：可以把 LocalMemoryAdapter 换成 SupabaseMemoryAdapter，
//   两者需要暴露完全相同的方法签名。
// ============================================================

const MEMORY_LS_KEY = "companion_memory_v1";

/**
 * 记忆条目的数据结构（无论本地还是云端实现都遵循这个形状）：
 * {
 *   id: string,
 *   type: "fact" | "preference" | "event" | "summary",  // 记忆类型，先预留几种常见分类
 *   content: string,       // 记忆内容本身
 *   source: string,        // 来源，比如某次对话的 id，方便溯源
 *   createdAt: number,     // 时间戳
 *   importance: number     // 0-1，重要程度，用于未来做记忆筛选/遗忘策略
 * }
 */

// ---------------- 本地实现 ----------------
const LocalMemoryAdapter = {
  async list() {
    try {
      const raw = localStorage.getItem(MEMORY_LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  async add(entry) {
    const all = await this.list();
    const record = {
      id: entry.id || Math.random().toString(36).slice(2, 10),
      type: entry.type || "fact",
      content: entry.content,
      source: entry.source || null,
      createdAt: entry.createdAt || Date.now(),
      importance: entry.importance ?? 0.5
    };
    all.push(record);
    localStorage.setItem(MEMORY_LS_KEY, JSON.stringify(all));
    return record;
  },

  async remove(id) {
    const all = await this.list();
    const filtered = all.filter(m => m.id !== id);
    localStorage.setItem(MEMORY_LS_KEY, JSON.stringify(filtered));
  },

  async clear() {
    localStorage.removeItem(MEMORY_LS_KEY);
  },

  // 未来用于"把哪些记忆塞进 system prompt"的筛选逻辑，
  // 目前先简单返回按重要度排序的前 N 条
  async getRelevant(limit = 10) {
    const all = await this.list();
    return all
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }
};

// ---------------- 云端实现占位（尚未接入）----------------
// 接入 Supabase 时，在这里实现同样的方法签名：
// const SupabaseMemoryAdapter = {
//   async list() { ... 从 supabase 表里查询 ... },
//   async add(entry) { ... insert 一行 ... },
//   async remove(id) { ... delete ... },
//   async clear() { ... },
//   async getRelevant(limit) { ... 可能带向量检索 ... }
// };

// ============================================================
// 当前生效的实现（切换后端时只改这一行）
// ============================================================
const MemoryAdapter = LocalMemoryAdapter;

// 供 app.js 使用的统一入口
window.Memory = MemoryAdapter;
