// ============================================================
// 记忆系统接口层（Memory Adapter）
// ------------------------------------------------------------
// app.js 里所有跟"记忆"和"表情包"相关的读写，都只通过这里的函数进行。
// 当前状态：Supabase 云端记忆 + localStorage 本地表情包。
//
// Supabase 表结构（需要在 Supabase 仪表板创建）：
//   memories (
//     id          bigint generated always as identity primary key,
//     created_at  timestamptz default now(),
//     type        text not null,         -- 'long_term' | 'short_term'
//     content     text not null,         -- 记忆内容
//     thread_id   text default 'global', -- 对话线程ID（短期记忆按对话隔离）
//     role        text default 'user'     -- 消息角色（短期记忆用）
//   )
// ============================================================

// ---- Supabase 配置 ----
const SUPABASE_URL = 'https://kiphsgskorznxjdcjsos.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpcGhzZ3Nrb3J6bnhqZGNqc29zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODQzNDAsImV4cCI6MjA5OTI2MDM0MH0.7g_nvTFSqn5Xv7BStds8ESQ6__wL027MVKIAj1azWfY';

let supabaseClient = null;
let supabaseReady = false;
let supabaseConnectError = '';

// 初始化 Supabase 客户端
function initSupabase() {
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    console.warn('⚠️ Supabase SDK 未加载，记忆系统降级为本地模式');
    return false;
  }
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return true;
  } catch (e) {
    console.error('Supabase 初始化失败:', e);
    supabaseConnectError = e.message;
    return false;
  }
}

// 测试 Supabase 连接
async function testSupabaseConnection() {
  if (!initSupabase()) {
    supabaseReady = false;
    return false;
  }
  try {
    const { data, error } = await supabaseClient
      .from('memories')
      .select('*')
      .limit(1);
    if (error) {
      console.error('❌ Leith 连接云端大脑失败:', error);
      supabaseConnectError = error.message;
      supabaseReady = false;
      // 不弹窗打断用户，只在控制台提示
      return false;
    } else {
      console.log('✅ Leith 连接云端成功！');
      supabaseReady = true;
      supabaseConnectError = '';
      return true;
    }
  } catch (e) {
    console.error('❌ Supabase 连接异常:', e);
    supabaseConnectError = e.message;
    supabaseReady = false;
    return false;
  }
}

// ---- 本地存储工具（表情包仍用本地） ----
const STICKER_LS_KEY = 'companion_stickers_v1';
const MEMORY_LS_KEY = 'companion_memory_v2'; // 本地降级用

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

// ============================================================
// Supabase 记忆适配器
// ============================================================
const SupabaseMemoryAdapter = {
  // ---- 核心记忆（用户手动写入的长期记忆，type='long_term', thread_id='core'）----
  async list() {
    if (!supabaseReady) return readLS(MEMORY_LS_KEY, []);
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('thread_id', 'core')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        createdAt: new Date(item.created_at).getTime(),
        pinned: true
      }));
    } catch (e) {
      console.error('加载核心记忆失败:', e);
      return readLS(MEMORY_LS_KEY, []);
    }
  },

  async add(content) {
    const trimmed = content.trim();
    // 先存本地（防止网络失败丢数据）
    const local = readLS(MEMORY_LS_KEY, []);
    const record = { id: genId(), content: trimmed, createdAt: Date.now(), pinned: true };
    local.push(record);

    if (supabaseReady) {
      try {
        const { error } = await supabaseClient
          .from('memories')
          .insert([{ content: trimmed, type: 'long_term', thread_id: 'core', role: 'user' }]);
        if (error) throw error;
        // 云端成功后，可以从本地缓存中移除（避免重复），但保留以备离线
      } catch (e) {
        console.error('核心记忆上传失败:', e);
        // 失败时保留在本地，稍后可重试
      }
    }
    writeLS(MEMORY_LS_KEY, local);
    return record;
  },

  async remove(id) {
    // 本地删除
    const local = readLS(MEMORY_LS_KEY, []);
    writeLS(MEMORY_LS_KEY, local.filter(m => m.id !== id));

    if (supabaseReady) {
      try {
        // id 可能是本地的 genId 或云端返回的数字 ID
        // 尝试按数字 ID 删，如果是纯数字就用它
        const numId = parseInt(id, 10);
        if (!isNaN(numId)) {
          await supabaseClient.from('memories').delete().eq('id', numId);
        }
      } catch (e) {
        console.error('删除记忆失败:', e);
      }
    }
  },

  async clear() {
    localStorage.removeItem(MEMORY_LS_KEY);
    if (supabaseReady) {
      try {
        await supabaseClient
          .from('memories')
          .delete()
          .eq('type', 'long_term')
          .eq('thread_id', 'core');
      } catch (e) {
        console.error('清空记忆失败:', e);
      }
    }
  },

  // 拼接成一段文字，供插入 system prompt 使用
  async asPromptBlock() {
    const all = await this.list();
    if (!all.length) return '';
    const lines = all.map(m => `- ${m.content}`).join('\n');
    return `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines}`;
  },

  // ---- 短期记忆（对话消息，type='short_term', thread_id=对话ID）----
  // 保存单条短期记忆
  async saveShortTerm(threadId, role, content) {
    if (!supabaseReady) return;
    try {
      const { error } = await supabaseClient
        .from('memories')
        .insert([{
          content: content,
          type: 'short_term',
          thread_id: threadId || 'global',
          role: role || 'user'
        }]);
      if (error) throw error;
    } catch (e) {
      console.error('短期记忆上传失败:', e);
    }
  },

  // 批量保存短期记忆
  async saveShortTermBatch(threadId, messages) {
    if (!supabaseReady || !messages.length) return;
    try {
      const rows = messages.map(m => ({
        content: m.content,
        type: 'short_term',
        thread_id: threadId || 'global',
        role: m.role || 'user'
      }));
      const { error } = await supabaseClient.from('memories').insert(rows);
      if (error) throw error;
    } catch (e) {
      console.error('批量短期记忆上传失败:', e);
    }
  },

  // 加载某个对话的短期记忆
  async loadShortTerm(threadId, limit = 50) {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'short_term')
        .eq('thread_id', threadId || 'global')
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(item => ({
        role: item.role || 'user',
        content: item.content
      }));
    } catch (e) {
      console.error('加载短期记忆失败:', e);
      return [];
    }
  },

  // 清空某个对话的短期记忆
  async clearShortTerm(threadId) {
    if (!supabaseReady) return;
    try {
      const { error } = await supabaseClient
        .from('memories')
        .delete()
        .eq('type', 'short_term')
        .eq('thread_id', threadId || 'global');
      if (error) throw error;
      console.log('✅ 短期记忆已清空');
    } catch (e) {
      console.error('清理短期记忆失败:', e);
    }
  },

  // 清空某个对话的全部记忆（短期+长期摘要）
  async clearThreadMemory(threadId) {
    if (!supabaseReady) return;
    try {
      await supabaseClient
        .from('memories')
        .delete()
        .eq('thread_id', threadId || 'global');
    } catch (e) {
      console.error('清空对话记忆失败:', e);
    }
  },

  // ---- 记忆压缩 ----
  // 将短期记忆压缩为长期摘要，然后清空短期记忆
  async compressMemory(threadId, messages, llmCallback) {
    if (!messages || !messages.length) return;
    console.log('🧠 Leith 正在整理记忆...');

    // 1. 构造总结提示词
    const summaryPrompt = `请把下面的对话总结成一段简短的话（50字以内），提取关键信息，不要用"用户说""AI说"这种格式，直接写成对事实的描述。\n对话内容：\n${messages.map(msg => `${msg.role}: ${msg.content}`).join('\n')}`;

    let summary = '';
    // 2. 调用 LLM 总结（llmCallback 由 app.js 传入）
    if (typeof llmCallback === 'function') {
      try {
        summary = await llmCallback(summaryPrompt);
      } catch (e) {
        console.error('记忆压缩 LLM 调用失败:', e);
        return;
      }
    }

    if (!summary || !summary.trim()) return;

    // 3. 保存为长期记忆摘要（type='long_term', thread_id=对话ID）
    try {
      const { error } = await supabaseClient
        .from('memories')
        .insert([{
          content: summary.trim(),
          type: 'long_term',
          thread_id: threadId || 'global',
          role: 'summary'
        }]);
      if (error) throw error;
      console.log(`✅ 记忆已压缩并保存 [long_term]:`, summary.trim());
    } catch (e) {
      console.error('保存记忆摘要失败:', e);
    }

    // 4. 清空短期记忆
    await this.clearShortTerm(threadId);
  },

  // 加载某个对话的长期摘要（压缩后的记忆）
  async loadLongTermSummary(threadId) {
    if (!supabaseReady) return '';
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('thread_id', threadId || 'global')
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (!data || !data.length) return '';
      // 拼接所有摘要
      return data.map(item => item.content).join('\n- ');
    } catch (e) {
      console.error('加载长期摘要失败:', e);
      return '';
    }
  },

  // 连接状态
  isReady() {
    return supabaseReady;
  },

  getError() {
    return supabaseConnectError;
  }
};

// ============================================================
// 本地记忆适配器（降级方案）
// ============================================================
const LocalMemoryAdapter = {
  async list() {
    return readLS(MEMORY_LS_KEY, []);
  },
  async add(content) {
    const all = await this.list();
    const record = { id: genId(), content: content.trim(), createdAt: Date.now(), pinned: true };
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
  async asPromptBlock() {
    const all = await this.list();
    if (!all.length) return '';
    const lines = all.map(m => `- ${m.content}`).join('\n');
    return `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines}`;
  },
  async saveShortTerm() {},
  async saveShortTermBatch() {},
  async loadShortTerm() { return []; },
  async clearShortTerm() {},
  async clearThreadMemory() {},
  async compressMemory() {},
  async loadLongTermSummary() { return ''; },
  isReady() { return false; },
  getError() { return ''; }
};

// ============================================================
// 本地表情包适配器
// ============================================================
const LocalStickerAdapter = {
  async list() {
    return readLS(STICKER_LS_KEY, []);
  },
  async add({ label, dataUrl }) {
    const all = await this.list();
    const record = { id: genId(), label: label || '', dataUrl, createdAt: Date.now() };
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

// ============================================================
// 导出：优先用 Supabase，连接失败则降级为本地
// ============================================================
// 先用本地（同步可用），异步连接成功后切换为 Supabase
window.Memory = LocalMemoryAdapter;
window.Stickers = LocalStickerAdapter;

// 页面加载时异步测试连接
window.addEventListener('DOMContentLoaded', async () => {
  const ok = await testSupabaseConnection();
  if (ok) {
    window.Memory = SupabaseMemoryAdapter;
    console.log('🧠 记忆系统已切换为 Supabase 云端模式');
    // 重新渲染记忆列表
    if (typeof renderMemoryList === 'function') {
      renderMemoryList();
    }
  } else {
    console.warn('🧠 记忆系统使用本地模式（Supabase 未连接）');
    if (supabaseConnectError) {
      console.warn('连接错误:', supabaseConnectError);
    }
  }
});

// 暴露测试函数供 app.js 调用
window.testSupabaseConnection = testSupabaseConnection;
window.SupabaseMemoryAdapter = SupabaseMemoryAdapter;
