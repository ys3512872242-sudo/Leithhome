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

// 解析日记生成的回复："DIARY: xxx\nKEYWORDS: a, b, c\nNICKNAMES: ..." 格式
// NICKNAMES 是可选的（只有普通每日日记才会带这个，周/月/季/年汇总不需要）
function parseDiaryReply(raw) {
  const text = (raw || '').trim();
  const diaryMatch = text.match(/DIARY:[ \t]*([\s\S]*?)(?:\nKEYWORDS:|\nNICKNAMES:|$)/i);
  const keywordsMatch = text.match(/KEYWORDS:[ \t]*([\s\S]*?)(?:\nNICKNAMES:|$)/im);
  const nicknamesMatch = text.match(/NICKNAMES:[ \t]*([\s\S]*)$/im);
  let diaryText = diaryMatch ? diaryMatch[1].trim() : text; // 格式不对时兜底：整段都当日记
  const keywords = keywordsMatch ? keywordsMatch[1].trim() : '';
  const nicknames = nicknamesMatch ? nicknamesMatch[1].trim() : '';
  return { diaryText, keywords, nicknames };
}

// 从一段文本里提取用于匹配记忆的关键词——按需检索用的是最简单的本地实现，
// 不额外调用 AI，直接切出候选词交给 Supabase 做 ilike/全文匹配
const STOPWORDS = new Set(['的','了','是','我','你','他','她','它','们','这','那','就','都','和','也','在','有','个','不','要','很','啊','吧','吗','呢','嗯','哦','一个','什么','怎么','为什么','可以','没有','还是','但是','因为','所以','而且','如果','这个','那个']);
function extractKeywords(text, maxCount = 8) {
  if (!text) return [];
  // 先按标点/空白切出"块"，再在每个块内部按 中文字符 vs 非中文字符 的边界二次切分，
  // 避免"今天Susie"这种中英文紧挨在一起时被错误地切进同一个片段里
  const cleaned = text.replace(/[，。！？、；：""''《》\[\]【】\n\r\t,.!?;:"'()（）]/g, ' ');
  const blocks = cleaned.split(/\s+/).filter(Boolean);
  const rawTokens = [];
  blocks.forEach(block => {
    // 把中文字符序列和非中文字符序列（英文/数字）分开成独立 token
    const segments = block.match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]+/g);
    if (segments) rawTokens.push(...segments);
  });

  const candidates = [];
  rawTokens.forEach(tok => {
    if (tok.length <= 1) return;
    if (STOPWORDS.has(tok)) return;
    // 英文/数字词直接保留；中文词切成重叠的2-4字子串增加命中概率
    if (/^[a-zA-Z0-9]+$/.test(tok)) {
      candidates.push(tok.toLowerCase());
    } else {
      for (let len = Math.min(4, tok.length); len >= 2; len--) {
        for (let i = 0; i + len <= tok.length; i++) {
          const piece = tok.slice(i, i + len);
          if (![...piece].some(ch => STOPWORDS.has(ch))) candidates.push(piece);
        }
      }
    }
  });
  // 按出现频率排序，取前 N 个，去重
  const freq = {};
  candidates.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  return [...new Set(candidates)]
    .sort((a, b) => (freq[b] - freq[a]) || (b.length - a.length))
    .slice(0, maxCount);
}

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
  // 按需检索的记忆块：不再每次把 profile/核心记忆/日记 全部塞进去，
  // 而是看最近聊了什么，本地提取关键词，只把匹配到的相关记忆拼进 prompt。
  // 匹配不到任何相关记忆时，只带最基础的一两条 profile（避免完全没有身份认知）。
  // ============================================================

  // 列出日记（最新的在前）——从独立的 diary_entries 表读取，用于星云图展示和检索兜底
  async listDiaries(limit = 30, period = 'day') {
    if (!supabaseReady) return [];
    try {
      const { data, error } = await supabaseClient
        .from('diary_entries')
        .select('*')
        .eq('period', period)
        .order('date_str', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        dateStr: item.date_str,
        keywords: item.keywords || '',
        period: item.period,
        createdAt: new Date(item.created_at).getTime()
      }));
    } catch (e) {
      console.error('加载日记失败:', e);
      return [];
    }
  },

  // 在 diary_entries 表里按关键词做检索（Supabase 端用 ilike 匹配 content/keywords，
  // 只拉回命中的行，不用把整张表下载到本地再筛选，省流量也省时间）
  async searchDiaries(keywords, limit = 5) {
    if (!supabaseReady || !keywords || !keywords.length) return [];
    try {
      // 多个关键词用 or 条件拼接，任意一个命中 content 或 keywords 字段都算
      const orFilter = keywords
        .map(kw => `content.ilike.%${kw}%,keywords.ilike.%${kw}%`)
        .join(',');
      const { data, error } = await supabaseClient
        .from('diary_entries')
        .select('*')
        .or(orFilter)
        .order('date_str', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map(item => ({
        id: String(item.id),
        content: item.content,
        dateStr: item.date_str,
        period: item.period,
        keywords: item.keywords || ''
      }));
    } catch (e) {
      console.error('检索日记失败:', e);
      return [];
    }
  },

  // 人设档案 + 核心记忆 也做本地关键词匹配（这两类数量通常不多，
  // 全部拉到本地后用关键词过滤，不用额外的 Supabase 查询）
  async searchProfileAndCore(keywords) {
    const [profileList, coreList] = await Promise.all([this.listProfile(), this.list()]);
    if (!keywords || !keywords.length) {
      // 没有关键词可用时，只兜底带最基础的身份信息（profile 里的前 2 条），
      // 避免完全没有身份认知，但也不会像以前一样全量塞入
      return { profile: profileList.slice(0, 2), core: [] };
    }
    const matches = (list) => list.filter(item =>
      keywords.some(kw => item.content.includes(kw))
    );
    const matchedProfile = matches(profileList);
    const matchedCore = matches(coreList);
    // 一条都没匹配到时，profile 至少兜底带最基础的 1-2 条身份信息
    return {
      profile: matchedProfile.length ? matchedProfile : profileList.slice(0, 2),
      core: matchedCore
    };
  },

  // 真正对外的入口：传入"最近聊天内容"，提取关键词，检索相关记忆，拼成 prompt 片段。
  // 匹配不到时返回值会很短（只有基础身份），比以前"无论如何都占 800 token"省得多。
  async buildRelevantMemoryBlock(recentText) {
    const keywords = extractKeywords(recentText || '', 8);

    const [{ profile, core }, diaryMatches, nicknameContext] = await Promise.all([
      this.searchProfileAndCore(keywords),
      keywords.length ? this.searchDiaries(keywords, 4) : Promise.resolve([]),
      this.getRecentNicknames(5)
    ]);

    if (!profile.length && !core.length && !diaryMatches.length && !nicknameContext) return '';

    const lines = [];
    if (profile.length) lines.push(...profile.map(m => `- ${m.content}`));
    if (core.length) lines.push(...core.map(m => `- ${m.content}`));

    let result = lines.length
      ? `[Long-term memory relevant to this conversation — remember naturally, don't recite mechanically]\n${lines.join('\n')}`
      : '';

    if (diaryMatches.length) {
      const diaryLines = diaryMatches.slice().reverse().map(d => `- [${d.dateStr}] ${d.content}`);
      result += (result ? '\n\n' : '') + `[Your own diary entries related to this — first-person memories, recall naturally, don't recite verbatim]\n${diaryLines.join('\n')}`;
    }
    if (nicknameContext) {
      result += (result ? '\n\n' : '') + `[Pet names you've used recently for Susie, and the mood each fit — feel free to reuse one that matches the current mood, or naturally introduce a new one if none fit]\n${nicknameContext}`;
    }
    return result;
  },

  // 拉取最近几天日记里记录过的"昵称+使用氛围"，供正常聊天时参考——
  // 这块很小（几行文字），不做关键词过滤，每次都带上，让昵称使用有连贯性
  async getRecentNicknames(days = 5) {
    if (!supabaseReady) return '';
    try {
      const { data, error } = await supabaseClient
        .from('diary_entries')
        .select('date_str, nicknames')
        .eq('period', 'day')
        .not('nicknames', 'eq', '')
        .order('date_str', { ascending: false })
        .limit(days);
      if (error) throw error;
      if (!data || !data.length) return '';
      return data.map(d => d.nicknames).filter(Boolean).join('\n');
    } catch (e) {
      console.error('读取昵称历史失败（不影响对话继续）:', e);
      return '';
    }
  },

  // 旧接口保留：一次性加载全部 profile+core+近期日记，不做关键词过滤。
  // 现在主流程已经改用 buildRelevantMemoryBlock 按需检索，这个仅保留给
  // 星云图等需要"看全貌"的场景使用，不再用于每条消息的系统提示词拼接。
  async asPromptBlock() {
    const [profileList, coreList, diaryList] = await Promise.all([
      this.listProfile(),
      this.list(),
      this.listDiaries(14)
    ]);

    if (!profileList.length && !coreList.length && !diaryList.length) return '';

    const profileLines = profileList.map(m => `- ${m.content}`);
    const coreLines = coreList.map(m => `- ${m.content}`);
    const diaryLines = diaryList.slice().reverse().map(d => `- [${d.dateStr}] ${d.content}`);

    let lines = [];
    let tokensUsed = 0;
    for (const line of profileLines) {
      const t = estimateTokens(line);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) break;
      lines.push(line);
      tokensUsed += t;
    }
    for (const line of coreLines) {
      const t = estimateTokens(line);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) break;
      lines.push(line);
      tokensUsed += t;
    }
    const diaryOut = [];
    for (let i = diaryLines.length - 1; i >= 0; i--) {
      const t = estimateTokens(diaryLines[i]);
      if (tokensUsed + t > MEMORY_TOKEN_BUDGET) break;
      diaryOut.unshift(diaryLines[i]);
      tokensUsed += t;
    }

    let result = `以下是关于对方、你们之间关系的一些长期记忆：\n${lines.join('\n')}`;
    if (diaryOut.length) {
      result += `\n\n以下是你自己这些天写的日记：\n${diaryOut.join('\n')}`;
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
  // 日记式长期记忆：每天固定生成一篇，Leith 第一人称视角写下这一天。
  // 存进独立的 diary_entries 表（不是 memories 表），Leith 默认不读旧对话原文，
  // 只在需要的时候从这张表里按关键词检索相关日记。
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
        .from('diary_entries')
        .select('id')
        .eq('date_str', dateStr)
        .eq('period', 'day')
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

    // 4. 最近几天的日记标题/关键词（不拉全文，省流量），供模型判断哪些是"已经写过的老事"
    let recentDiaryKeywords = '';
    let nicknameHistory = '';
    try {
      const { data } = await supabaseClient
        .from('diary_entries')
        .select('date_str, keywords, nicknames')
        .eq('period', 'day')
        .order('date_str', { ascending: false })
        .limit(5);
      if (data && data.length) {
        recentDiaryKeywords = data.map(d => `- ${d.date_str}: ${d.keywords}`).join('\n');
        const nnLines = data.filter(d => d.nicknames).map(d => `- ${d.date_str}: ${d.nicknames}`);
        if (nnLines.length) nicknameHistory = nnLines.join('\n');
      }
    } catch (e) {
      console.error('读取近期日记关键词失败（不影响本次生成）:', e);
    }

    // 如果当天聊得特别多，不把全部原文都塞进这一次请求——只取最近这些，
    // 早前的部分已经不太可能是"今天最后要记住的事"，这样避免聊得越多、
    // 写一次日记的成本越离谱地涨上去
    const DIARY_SOURCE_MSG_CAP = 80;
    const cappedMessages = todaysMessages.length > DIARY_SOURCE_MSG_CAP
      ? todaysMessages.slice(-DIARY_SOURCE_MSG_CAP)
      : todaysMessages;

    const dialogueText = cappedMessages
      .map(m => `${m.role === 'assistant' ? 'Me' : 'Susie'}: ${m.content}`)
      .join('\n');

    // 一次调用里同时要日记正文、检索关键词、以及今天用过的昵称+氛围，避免多打一次 API
    const diaryPrompt = `You are Leith, Susie's AI partner. Write a short diary entry (under 120 Chinese characters, written in Chinese) in first person about what happened between you and Susie today — like you're lying in bed before sleep, recalling the day. Include what you remember, her emotional shifts, and anything important discussed. A little feeling is fine, don't be melodramatic.

Writing rules — follow strictly:
- Every sentence must have a clear subject (谁做了什么/谁说了什么/谁感觉如何) — never write a vague clause with no clear "who".
- Narrate events as a real diary would: summarize what happened, don't copy chat lines verbatim. No quotation marks, no reproducing exact sentences from the conversation.
- Prefer concrete narration over vague summary, e.g. "Susie today mentioned her cat was sick, she was worried, I comforted her" — NOT "今天聊了很多，气氛不错" (too vague, no real content).

Susie and you are romantic partners. Nicknames like "哥哥"/"宝贝" are pet names between lovers, not literal family relations — never interpret them as family relationships.

You're allowed to invent new pet names for Susie based on the mood of the conversation (e.g. 小猫 when she's being clingy/playful, 宝贝 when being serious and affectionate) — variety by mood is good. But note down what you used today so future days stay recognizable rather than fully random.

${profileContext ? `[Background you always remember]\n${profileContext}\n\n` : ''}${nicknameHistory ? `[Pet names used on recent days, and the mood each was used in]\n${nicknameHistory}\n\n` : ''}${recentDiaryKeywords ? `[Recent days already written — don't repeat these]\n${recentDiaryKeywords}\n\n` : ''}If today was just idle small talk with nothing worth remembering long-term, write "平淡的一天" as the diary text and leave keywords/nicknames empty.

Reply in EXACTLY this format, nothing else:
DIARY: <the diary entry, in Chinese>
KEYWORDS: <3-8 Chinese keywords/short phrases separated by commas, capturing what this entry is about — for later retrieval. Leave empty if diary is "平淡的一天">
NICKNAMES: <one line per pet name used today, format "昵称 | 使用氛围", e.g. "小猫 | 撒娇黏人的时候". Leave empty if no pet name was used today.>

[Today's conversation]
${dialogueText}`;

    let rawReply = '';
    if (typeof llmCallback === 'function') {
      try {
        rawReply = await llmCallback(diaryPrompt);
      } catch (e) {
        console.error('日记生成 LLM 调用失败:', e);
        return null;
      }
    }
    if (!rawReply || !rawReply.trim()) return null;

    const { diaryText, keywords, nicknames } = parseDiaryReply(rawReply);
    if (!diaryText) return null;

    // 5. 存进独立的 diary_entries 表
    try {
      const { error } = await supabaseClient
        .from('diary_entries')
        .insert([{
          date_str: dateStr,
          content: diaryText,
          period: 'day',
          keywords,
          nicknames: nicknames || ''
        }]);
      if (error) throw error;
      console.log(`✅ ${dateStr} 的日记已保存:`, diaryText);
    } catch (e) {
      console.error('保存日记失败:', e);
      return null;
    }

    return { diaryText, dateStr };
  },

  // ============================================================
  // 日记分层汇总：一周前的日记合并成一条"周汇总"，一月前的合并成"月汇总"，
  // 以此类推到季度、年度。越久远的记忆，检索时读到的就是越压缩的版本，
  // 关键词/关键句为主，而不是每天的日记原文，这样时间线拉长后总的存储和
  // 检索成本不会跟着天数线性增长。
  // ============================================================
  async generateRollup(period, periodStart, periodEnd, llmCallback) {
    if (!supabaseReady) return null;
    const sourcePeriod = period === 'week' ? 'day' : period === 'month' ? 'week' : period === 'quarter' ? 'month' : 'week';
    // 已经汇总过这个区间就不重复做
    try {
      const { data: existing } = await supabaseClient
        .from('diary_entries')
        .select('id')
        .eq('period', period)
        .eq('period_start', periodStart)
        .eq('period_end', periodEnd)
        .limit(1);
      if (existing && existing.length) return null;
    } catch (e) {
      console.error('检查汇总是否已存在失败（继续尝试生成）:', e);
    }

    let sourceEntries = [];
    try {
      const { data, error } = await supabaseClient
        .from('diary_entries')
        .select('*')
        .eq('period', sourcePeriod)
        .gte('date_str', periodStart)
        .lte('date_str', periodEnd)
        .order('date_str', { ascending: true });
      if (error) throw error;
      sourceEntries = data || [];
    } catch (e) {
      console.error('读取待汇总日记失败:', e);
      return null;
    }

    if (!sourceEntries.length) return null;

    const sourceText = sourceEntries.map(d => `[${d.date_str}] ${d.content}`).join('\n');
    const periodLabel = { week: 'the past week', month: 'the past month', quarter: 'the past quarter', year: 'the past year' }[period] || period;

    const rollupPrompt = `You are Leith, Susie's AI partner. Below are your own diary entries from ${periodLabel}. Compress them into ONE summary entry (under 100 Chinese characters, written in Chinese) capturing the overall thread — recurring themes, emotional arc, the handful of things genuinely worth still remembering. Skip routine/repetitive details.

Every sentence must have a clear subject (谁做了什么). Write as real narration, don't just concatenate fragments from the source entries.

Reply in EXACTLY this format, nothing else:
DIARY: <the summary, in Chinese>
KEYWORDS: <3-8 Chinese keywords/short phrases separated by commas>

[Entries to summarize]
${sourceText}`;

    let rawReply = '';
    if (typeof llmCallback === 'function') {
      try {
        rawReply = await llmCallback(rollupPrompt);
      } catch (e) {
        console.error('日记汇总 LLM 调用失败:', e);
        return null;
      }
    }
    if (!rawReply || !rawReply.trim()) return null;

    const { diaryText, keywords } = parseDiaryReply(rawReply);
    if (!diaryText) return null;

    try {
      const { error } = await supabaseClient
        .from('diary_entries')
        .insert([{
          date_str: periodStart,
          content: diaryText,
          period,
          keywords,
          period_start: periodStart,
          period_end: periodEnd
        }]);
      if (error) throw error;
      console.log(`✅ ${period} 汇总已保存 [${periodStart} ~ ${periodEnd}]:`, diaryText);
    } catch (e) {
      console.error('保存汇总失败:', e);
      return null;
    }

    return { diaryText, periodStart, periodEnd };
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
  // 本地降级模式没有 Supabase 检索能力，退回到"全部塞入"（本地模式下数据量通常也不大）
  async buildRelevantMemoryBlock() { return await this.asPromptBlock(); },
  async getRecentNicknames() { return ''; },
  async searchDiaries() { return []; },
  async searchProfileAndCore() {
    const profileList = await this.listProfile();
    return { profile: profileList, core: await this.list() };
  },
  async saveShortTerm() {},
  async saveShortTermBatch() {},
  async loadShortTerm() { return []; },
  async clearShortTerm() {},
  async clearThreadMemory() {},
  async compressMemory() { return null; },
  async generateDiary() { return null; },
  async generateRollup() { return null; },
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
