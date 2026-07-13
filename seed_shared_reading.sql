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

alter table shared_books enable row level security;

drop policy if exists "allow all for shared_books" on shared_books;
create policy "allow all for shared_books" on shared_books
  for all using (true) with check (true);

-- 一起看的网页链接（比如小说网站某一章的网址），比 shared_books 轻量很多，
-- 不存正文，只存网址本身，双方各自点开浏览器看同一个网页
create table if not exists shared_links (
  id            text primary key,        -- 短码
  url           text not null,           -- 网页链接
  note          text,                    -- 备注，比如"看到第12章"
  created_at    timestamptz default now()
);

alter table shared_links enable row level security;

drop policy if exists "allow all for shared_links" on shared_links;
create policy "allow all for shared_links" on shared_links
  for all using (true) with check (true);
