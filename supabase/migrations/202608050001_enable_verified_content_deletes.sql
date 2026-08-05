begin;

drop policy if exists "leith unlocked delete memories" on public.memories;
create policy "leith unlocked delete memories"
on public.memories
for delete
to anon, authenticated
using ((select public.leith_session_valid()));

drop policy if exists "leith unlocked delete diary entries" on public.diary_entries;
create policy "leith unlocked delete diary entries"
on public.diary_entries
for delete
to anon, authenticated
using ((select public.leith_session_valid()));

commit;
