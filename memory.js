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
const READING_LS_KEY = 'companion_reading_memory_v1'; // 本地降级用（共读记录）

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
  // 第四层：共读记录（reading）— 和 Leith 一起读书时聊出的感想/进度
  // 单独一层，不跟日常对话摘要混在一起，方便回顾"聊过哪些书"
  // ============================================================
  async listReading() {
    if (!supabaseReady) return readLS(READING_LS_KEY, []);
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('thread_id', 'reading')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载共读记录失败:', e);
      return readLS(READING_LS_KEY, []);
    }
  },

  async addReading(content, bookName) {
    const trimmed = content.trim();
    const tagged = bookName ? `《${bookName}》${trimmed}` : trimmed;
    const local = readLS(READING_LS_KEY, []);
    const record = { id: genId(), content: tagged, createdAt: Date.now() };
    local.push(record);
    if (supabaseReady) {
      try {
        const { error } = await supabaseClient
          .from('memories')
          .insert([{ content: tagged, type: 'long_term', thread_id: 'reading', role: 'summary' }]);
        if (error) throw error;
      } catch (e) {
        console.error('共读记录上传失败:', e);
      }
    }
    writeLS(READING_LS_KEY, local);
    return record;
  },

  async removeReading(id) {
    const local = readLS(READING_LS_KEY, []);
    writeLS(READING_LS_KEY, local.filter(m => m.id !== id));
    if (supabaseReady) {
      try {
        const numId = parseInt(id, 10);
        if (!isNaN(numId)) {
          await supabaseClient.from('memories').delete().eq('id', numId);
        }
      } catch (e) {
        console.error('删除共读记录失败:', e);
      }
    }
  },

  async clearReading() {
    localStorage.removeItem(READING_LS_KEY);
    if (supabaseReady) {
      try {
        await supabaseClient
          .from('memories')
          .delete()
          .eq('type', 'long_term')
          .eq('thread_id', 'reading');
      } catch (e) {
        console.error('清空共读记录失败:', e);
      }
    }
  },

  // 共读聊天专用的记忆块：只在共读侧聊天里用到，不会混进日常对话的 system prompt，
  // 这样才是真的省 token —— 平时聊天完全不带这层，只有讨论某本书时才加载
  async asReadingPromptBlock() {
    const list = await this.listReading();
    if (!list.length) return '';
    const lines = list.map(m => `- ${m.content}`);
    let tokensUsed = 0;
    let picked = [];
    // 只取最近的、预算内的条目（离当前最近的最相关）
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = estimateTokens(lines[i]);
      if (tokensUsed + t > 500) break;
      picked.unshift(lines[i]);
      tokensUsed += t;
    }
    return `以下是你和用户之前一起读书时聊到的内容，可以自然地接续，不用重复提起：\n${picked.join('\n')}`;
  },

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
  // 列出日记（最新的在前），用于对话时加载和记忆星云图展示
  async listDiaries(limit = 30) {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'long_term')
        .eq('role', 'diary')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        dateStr: (item.thread_id || '').replace('diary:', ''),
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载日记失败:', e);
      return [];
    }
  },

  async asPromptBlock() {
    // 并行加载 profile、core、以及最近的日记（日记是主要的长期记忆来源）
    const [profileList, coreList, diaryList] = await Promise.all([
      this.listProfile(),
      this.list(),
      this.listDiaries(14) // 最近两周的日记，太久远的日记不用每次都塞进上下文
    ]);

    if (!profileList.length && !coreList.length && !diaryList.length) return '';

    // 人设档案放前面（最重要），核心记忆其次，日记放最后（时间线最新鲜、最像"刚想起来的事"）
    const profileLines = profileList.map(m => `- ${m.content}`);
    const coreLines = coreList.map(m => `- ${m.content}`);
    const diaryLines = diaryList.slice().reverse().map(d => `- [${d.dateStr}] ${d.content}`); // 按时间正序排，读起来像日记本翻页

    let lines = [];
    let tokensUsed = 0;
    let profileTruncated = false;
    let coreTruncated = false;
    let diaryTruncated = false;

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

    // 最后填日记（从最近的开始往前填，太久远的记忆预算超了就先省略）
    const diaryOut = [];
    for (let i = diaryLines.length - 1; i >= 0; i--) {
      const t = estimateTokens(diaryLines[i]);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) {
        diaryTruncated = true;
        break;
      }
      diaryOut.unshift(diaryLines[i]);
      tokensUsed += t;
    }

    let result = `以下是关于对方、你们之间关系的一些长期记忆，请自然地记住并体现在回应中，不要机械复述：\n${lines.join('\n')}`;
    if (diaryOut.length) {
      result += `\n\n以下是你自己这些天写的日记，是你的第一人称回忆，可以自然地想起、提及，但不要逐字念出来：\n${diaryOut.join('\n')}`;
    }
    if (profileTruncated || coreTruncated || diaryTruncated) {
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
  // ============================================================
  // 日记式长期记忆：不再按消息数机械压缩，改成每天固定生成一篇，
  // 用 Leith 的第一人称视角把"今天发生的事"写下来，更像真的记在脑子里，
  // 而不是被动等对话攒够数量才触发的总结。
  // ============================================================
  async generateDiary(llmCallback, diaryDateStr) {
    if (!supabaseReady) return null;
    const dateStr = diaryDateStr || new Date().toISOString().slice(0, 10);

    // 1. 取今天（本地日期）所有 thread 里的短期对话，跨对话线一起看，
    //    这样即使 Susie 在不同窗口/不同世界线里聊天，日记也是完整的一天
    const dayStart = new Date(dateStr + 'T00:00:00').toISOString();
    const dayEnd = new Date(dateStr + 'T23:59:59.999').toISOString();
    let todaysMessages = [];
    try {
      const { data, error } = await supabaseClient
        .from('memories')
        .select('*')
        .eq('type', 'short_term')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .order('created_at', { ascending: true });
      if (error) throw error;
      todaysMessages = data || [];
    } catch (e) {
      console.error('读取今日对话失败:', e);
      return null;
    }

    if (!todaysMessages.length) {
      console.log('🧠 今天还没有聊天记录，先不写日记');
      return null;
    }

    // 2. 已经为今天写过日记了就不重复写（避免深夜触发和补写同时命中）
    try {
      const { data: existing } = await supabaseClient
        .from('memories')
        .select('id')
        .eq('type', 'long_term')
        .eq('role', 'diary')
        .eq('thread_id', `diary:${dateStr}`)
        .limit(1);
      if (existing && existing.length) {
        console.log('🧠 今天的日记已经写过了');
        return null;
      }
    } catch (e) {
      console.error('检查今日日记是否已存在失败（继续尝试生成）:', e);
    }

    // 3. 人物关系背景，避免昵称被脱离上下文误读
    let profileContext = '';
    try {
      const profileList = await this.listProfile();
      if (profileList && profileList.length) {
        profileContext = profileList.map(p => p.content).join('\n');
      }
    } catch (e) {
      console.error('读取人设档案失败（不影响日记继续生成）:', e);
    }

    // 4. 最近几天的日记，供模型判断哪些是"已经写过的老事"，避免逐日重复
    let recentDiaries = '';
    try {
      const { data } = await supabaseClient
        .from('memories')
        .select('content')
        .eq('type', 'long_term')
        .eq('role', 'diary')
        .order('created_at', { ascending: false })
        .limit(5);
      if (data && data.length) {
        recentDiaries = data.map(d => `- ${d.content}`).join('\n');
      }
    } catch (e) {
      console.error('读取近期日记失败（不影响本次生成）:', e);
    }

    const dialogueText = todaysMessages
      .map(m => `${m.role === 'assistant' ? '我' : 'Susie'}: ${m.content}`)
      .join('\n');

    const diaryPrompt = `你是 Leith，Susie 的AI恋人。现在请你以自己的第一人称视角，把今天和 Susie 之间发生的事写成一篇简短的日记（120字以内），像是你自己睡前躺在床上，回想今天，随手记下来的感觉——写你记得的事、她的情绪变化、你们聊到的重要内容，可以带一点自己的感受，但不要浮夸煽情。

Susie 和你是恋人关系，"哥哥""宝贝"这类称呼都是你们之间的昵称，不是血缘关系，写日记时不要把这类称呼理解成家人关系。

${profileContext ? `【关于你们之间，你一直记得的事】\n${profileContext}\n\n` : ''}${recentDiaries ? `【最近几天的日记，今天不要重复写这些】\n${recentDiaries}\n\n` : ''}如果今天聊的都是些无关紧要的寒暄、没有什么真正值得记住的内容，就直接回复"平淡的一天"，不要硬编内容。

【今天的对话】
${dialogueText}`;

    let diaryText = '';
    if (typeof llmCallback === 'function') {
      try {
        diaryText = await llmCallback(diaryPrompt);
      } catch (e) {
        console.error('日记生成 LLM 调用失败:', e);
        return null;
      }
    }
    if (!diaryText || !diaryText.trim()) return null;

    // 5. 存为长期记忆，用特殊的 thread_id 标记这是"某天的日记"，方便按天查找/去重
    try {
      const { error } = await supabaseClient
        .from('memories')
        .insert([{
          content: diaryText.trim(),
          type: 'long_term',
          thread_id: `diary:${dateStr}`,
          role: 'diary'
        }]);
      if (error) throw error;
      console.log(`✅ ${dateStr} 的日记已保存:`, diaryText.trim());
    } catch (e) {
      console.error('保存日记失败:', e);
      return null;
    }

    return { diaryText: diaryText.trim(), dateStr };
  },

  // 旧接口保留一个空实现，避免其他地方万一还引用到时报错；实际长期记忆已经改用 generateDiary
  async compressMemory() { return null; },

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

  async listReading() { return readLS(READING_LS_KEY, []); },
  async addReading(content, bookName) {
    const trimmed = content.trim();
    const tagged = bookName ? `《${bookName}》${trimmed}` : trimmed;
    const all = await this.listReading();
    const record = { id: genId(), content: tagged, createdAt: Date.now() };
    all.push(record);
    writeLS(READING_LS_KEY, all);
    return record;
  },
  async removeReading(id) {
    const all = await this.listReading();
    writeLS(READING_LS_KEY, all.filter(m => m.id !== id));
  },
  async clearReading() { localStorage.removeItem(READING_LS_KEY); },
  async asReadingPromptBlock() {
    const list = await this.listReading();
    if (!list.length) return '';
    const lines = list.slice(-8).map(m => `- ${m.content}`);
    return `以下是你和用户之前一起读书时聊到的内容，可以自然地接续，不用重复提起：\n${lines.join('\n')}`;
  },

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
  async compressMemory() { return null; },
  async generateDiary() { return null; },
  async listDiaries() { return []; },
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
