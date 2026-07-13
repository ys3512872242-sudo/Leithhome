-- ============================================================
-- 共读小说 · 一起看的链接（云端同步）
-- 在 Supabase SQL Editor 中执行此文件一次即可
-- ============================================================

create table if not exists shared_books (
  id            text primary key,        -- 分享链接里的短码，比如 "a1b2c3"
  name          text not null,            -- 书名
  content       text not null,            -- 全文内容（txt/pdf 提取后的纯文本）
  created_at    timestamptz default now(),
  owner_progress    integer default 0,    -- 分享者（创建链接的人）的阅读进度（字符偏移量）
  partner_progress  integer default 0     -- 打开链接的另一半的阅读进度
);

-- 打开这张表的匿名读写权限（和 memories 表的策略保持一致，仅限你们两人使用的私人小工具）
alter table shared_books enable row level security;

drop policy if exists "allow all for shared_books" on shared_books;
create policy "allow all for shared_books" on shared_books
  for all using (true) with check (true);
