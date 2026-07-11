// ============================================================
// 记忆系统接口层（Memory Adapter）— 分层记忆架构
// ------------------------------------------------------------
// app.js 里所有跟"记忆"和"表情包"相关的读写，都只通过这里的函数进行。
//
// 记忆分层（通过 thread_id 区分，不需要改表结构）：
//   ┌─────────────────────────────────────────────────────┐
//   │ profile  │ 人设档案 │ 始终加载 │ 精简事实，每条<50字  │
//   │ core     │ 核心记忆 │ 始终加载 │ 用户手动添加的重要事 │
//   │ archive  │ 归档信件 │ 不进上下文 │ 完整原文，仅UI可查看 │
//   │ <threadId> │ 短期记忆 │ 按对话加载 │ 当前对话消息       │
//   │ <threadId> │ 对话摘要 │ 按对话加载 │ 压缩后的长期摘要    │
//   └─────────────────────────────────────────────────────┘
//
// Supabase 表结构：
//   memories (
//     id          bigint generated always as identity primary key,
//     created_at  timestamptz default now(),
//     type        text not null,         -- 'long_term' | 'short_term'
//     content     text not null,
//     thread_id   text default 'global', -- 'profile' | 'core' | 'archive' | <对话ID>
//     role        text default 'user'     -- 'user' | 'assistant' | 'summary' | 'archive'
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
const MEMORY_LS_KEY = 'companion_memory_v2';       // 本地降级用（core）
const PROFILE_LS_KEY = 'companion_profile_v1';      // 本地降级用（profile）

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

// 粗略估算 token 数（中文约1字=1.5token，英文约4字符=1token）
function estimateTokens(text) {
  if (!text) return 0;
  const cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - cnChars;
  return Math.ceil(cnChars * 1.5 + otherChars / 4);
}

// 记忆注入的 token 预算（超过则从尾部截断低优先级条目）
const MEMORY_TOKEN_BUDGET = 800;

// ============================================================
// Supabase 记忆适配器
// ============================================================
const SupabaseMemoryAdapter = {
  // ============================================================
  // 第一层：人设档案（profile）— 始终加载，精简事实
  // ============================================================
  async listProfile() {
    if (!supabaseReady) return readLS(PROFILE_LS_KEY, []);
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('thread_id', 'profile')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载人设档案失败:', e);
      return readLS(PROFILE_LS_KEY, []);
    }
  },

  async addProfile(content) {
    const trimmed = content.trim();
    const local = readLS(PROFILE_LS_KEY, []);
    const record = { id: genId(), content: trimmed, createdAt: Date.now() };
    local.push(record);
    if (supabaseReady) {
      try {
        const { error } = await supabaseClient
          .from('memories')
          .insert([{ content: trimmed, type: 'long_term', thread_id: 'profile', role: 'profile' }]);
        if (error) throw error;
      } catch (e) {
        console.error('人设档案上传失败:', e);
      }
    }
    writeLS(PROFILE_LS_KEY, local);
    return record;
  },

  async removeProfile(id) {
    const local = readLS(PROFILE_LS_KEY, []);
    writeLS(PROFILE_LS_KEY, local.filter(m => m.id !== id));
    if (supabaseReady) {
      try {
        const numId = parseInt(id, 10);
        if (!isNaN(numId)) {
          await supabaseClient.from('memories').delete().eq('id', numId);
        }
      } catch (e) {
        console.error('删除人设档案失败:', e);
      }
    }
  },

  async clearProfile() {
    localStorage.removeItem(PROFILE_LS_KEY);
    if (supabaseReady) {
      try {
        await supabaseClient
          .from('memories')
          .delete()
          .eq('type', 'long_term')
          .eq('thread_id', 'profile');
      } catch (e) {
        console.error('清空人设档案失败:', e);
      }
    }
  },

  // ============================================================
  // 第二层：核心记忆（core）— 用户手动添加，始终加载
  // ============================================================
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
    const local = readLS(MEMORY_LS_KEY, []);
    const record = { id: genId(), content: trimmed, createdAt: Date.now(), pinned: true };
    local.push(record);
    if (supabaseReady) {
      try {
        const { error } = await supabaseClient
          .from('memories')
          .insert([{ content: trimmed, type: 'long_term', thread_id: 'core', role: 'user' }]);
        if (error) throw error;
      } catch (e) {
        console.error('核心记忆上传失败:', e);
      }
    }
    writeLS(MEMORY_LS_KEY, local);
    return record;
  },

  async remove(id) {
    const local = readLS(MEMORY_LS_KEY, []);
    writeLS(MEMORY_LS_KEY, local.filter(m => m.id !== id));
    if (supabaseReady) {
      try {
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

  // ============================================================
  // 第三层：归档信件（archive）— 完整原文，不进 system prompt
  // ============================================================
  async listArchive() {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('thread_id', 'archive')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载归档失败:', e);
      return [];
    }
  },

  async addArchive(content) {
    const trimmed = content.trim();
    if (!supabaseReady) return;
    try {
      const { error } = await supabaseClient
        .from('memories')
        .insert([{ content: trimmed, type: 'long_term', thread_id: 'archive', role: 'archive' }]);
      if (error) throw error;
    } catch (e) {
      console.error('归档上传失败:', e);
    }
  },

  async removeArchive(id) {
    if (!supabaseReady) return;
    try {
      const numId = parseInt(id, 10);
      if (!isNaN(numId)) {
        await supabaseClient.from('memories').delete().eq('id', numId);
      }
    } catch (e) {
      console.error('删除归档失败:', e);
    }
  },

  // ============================================================
  // 拼接 system prompt 用的记忆块（profile + core，带 token 预算）
  // ============================================================
  async asPromptBlock() {
    // 并行加载 profile 和 core
    const [profileList, coreList] = await Promise.all([
      this.listProfile(),
      this.list()
    ]);

    if (!profileList.length && !coreList.length) return '';

    // 人设档案放前面（最重要），核心记忆放后面
    const profileLines = profileList.map(m => `- ${m.content}`);
    const coreLines = coreList.map(m => `- ${m.content}`);

    let lines = [];
    let tokensUsed = 0;
    let profileTruncated = false;
    let coreTruncated = false;

    // 先填人设档案
    for (const line of profileLines) {
      const t = estimateTokens(line);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) {
        profileTruncated = true;
        break;
      }
      lines.push(line);
      tokensUsed += t;
    }

    // 再填核心记忆
    for (const line of coreLines) {
      const t = estimateTokens(line);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) {
        coreTruncated = true;
        break;
      }
      lines.push(line);
      tokensUsed += t;
    }

    let result = `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines.join('\n')}`;
    if (profileTruncated || coreTruncated) {
      result += '\n（部分记忆因篇幅已省略）';
    }
    return result;
  },

  // ============================================================
  // 短期记忆（对话消息）
  // ============================================================
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

  // ============================================================
  // 记忆压缩（滑动窗口：压缩旧消息，保留最近消息）
  // ============================================================
  async compressMemory(threadId, messages, llmCallback) {
    if (!messages || messages.length < 10) return;
    console.log('🧠 Leith 正在整理记忆...');

    // 滑动窗口：压缩前半部分，保留后半部分
    const compressCount = Math.floor(messages.length / 2);
    const toCompress = messages.slice(0, compressCount);
    const toKeep = messages.slice(compressCount);

    // 1. 构造总结提示词
    const summaryPrompt = `请把下面的对话总结成一段简短的话（80字以内），提取关键信息：事实、决定、情感、偏好。不要用"用户说""AI说"这种格式，直接写成对事实的描述。\n对话内容：\n${toCompress.map(msg => `${msg.role}: ${msg.content}`).join('\n')}`;

    let summary = '';
    if (typeof llmCallback === 'function') {
      try {
        summary = await llmCallback(summaryPrompt);
      } catch (e) {
        console.error('记忆压缩 LLM 调用失败:', e);
        return;
      }
    }

    if (!summary || !summary.trim()) return;

    // 3. 保存为长期记忆摘要
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

    // 4. 只删除已压缩的短期记忆，保留最近的
    if (supabaseReady) {
      try {
        // 获取该 thread 最旧的 compressCount 条短期记忆，删除它们
        const { data: oldRows } = await supabaseClient
          .from('memories')
          .select('id')
          .eq('type', 'short_term')
          .eq('thread_id', threadId || 'global')
          .order('created_at', { ascending: true })
          .limit(compressCount);
        if (oldRows && oldRows.length) {
          const idsToDelete = oldRows.map(r => r.id);
          await supabaseClient.from('memories').delete().in('id', idsToDelete);
        }
      } catch (e) {
        console.error('清理旧短期记忆失败:', e);
      }
    }

    // 5. 通知 app.js 更新本地消息（只保留 toKeep）
    return { keptMessages: toKeep };
  },

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
      return data.map(item => item.content).join('\n- ');
    } catch (e) {
      console.error('加载长期摘要失败:', e);
      return '';
    }
  },

  // 列出对话摘要（用于树状可视化）
  async listSummary(threadId) {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('role', 'summary')
        .eq('thread_id', threadId || 'global')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载对话摘要失败:', e);
      return [];
    }
  },

  // 列出短期记忆（带 id/时间，用于树状可视化）
  async listShortTermDetail(threadId, limit = 30) {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'short_term')
        .eq('thread_id', threadId || 'global')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        role: item.role || 'user',
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载短期记忆详情失败:', e);
      return [];
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
  async listProfile() {
    return readLS(PROFILE_LS_KEY, []);
  },
  async addProfile(content) {
    const all = await this.listProfile();
    const record = { id: genId(), content: content.trim(), createdAt: Date.now() };
    all.push(record);
    writeLS(PROFILE_LS_KEY, all);
    return record;
  },
  async removeProfile(id) {
    const all = await this.listProfile();
    writeLS(PROFILE_LS_KEY, all.filter(m => m.id !== id));
  },
  async clearProfile() {
    localStorage.removeItem(PROFILE_LS_KEY);
  },
  async listArchive() { return []; },
  async addArchive() {},
  async removeArchive() {},

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
    const [profileList, coreList] = await Promise.all([this.listProfile(), this.list()]);
    if (!profileList.length && !coreList.length) return '';
    const lines = [
      ...profileList.map(m => `- ${m.content}`),
      ...coreList.map(m => `- ${m.content}`)
    ];
    return `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines.join('\n')}`;
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
window.Memory = LocalMemoryAdapter;
window.Stickers = LocalStickerAdapter;

window.addEventListener('DOMContentLoaded', async () => {
  const ok = await testSupabaseConnection();
  if (ok) {
    window.Memory = SupabaseMemoryAdapter;
    console.log('🧠 记忆系统已切换为 Supabase 云端模式');
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

window.testSupabaseConnection = testSupabaseConnection;
window.SupabaseMemoryAdapter = SupabaseMemoryAdapter;
window.getSupabaseClient = () => supabaseClient;
