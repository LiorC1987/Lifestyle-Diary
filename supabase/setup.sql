-- Life Diary: database setup for the online accounts.
-- Run once in the Supabase project (SQL editor). Safe to run again.

-- One diary per person. Only that person can read or write it.
create table if not exists public.diaries (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null,
  modified_at bigint not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.diaries enable row level security;
grant select, insert, update, delete on public.diaries to authenticated;
revoke all on public.diaries from anon;

drop policy if exists "Own diary: read" on public.diaries;
drop policy if exists "Own diary: add" on public.diaries;
drop policy if exists "Own diary: change" on public.diaries;
drop policy if exists "Own diary: delete" on public.diaries;
create policy "Own diary: read" on public.diaries for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Own diary: add" on public.diaries for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Own diary: change" on public.diaries for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Own diary: delete" on public.diaries for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.touch_updated_at() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists diaries_touch on public.diaries;
create trigger diaries_touch before update on public.diaries
  for each row execute function public.touch_updated_at();

-- Meal photos: a private bucket with one folder per person, named after their account.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];

drop policy if exists "Own photos: read" on storage.objects;
drop policy if exists "Own photos: add" on storage.objects;
drop policy if exists "Own photos: change" on storage.objects;
drop policy if exists "Own photos: delete" on storage.objects;
create policy "Own photos: read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Own photos: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Own photos: change" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Own photos: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Summaries written by Claude (through the "summarize" server function).
-- People can read their own; only the server function, with the secret key, adds them.
create table public.summaries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  period text not null check (period in ('day', 'week', 'month')),
  start_date date not null,
  end_date date not null,
  text text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
create index summaries_lookup on public.summaries (user_id, period, start_date, created_at desc);
create index summaries_recent on public.summaries (user_id, created_at desc);
alter table public.summaries enable row level security;
revoke all on public.summaries from anon;
revoke all on public.summaries from authenticated;
grant select, delete on public.summaries to authenticated;
grant all on public.summaries to service_role;
create policy "Own summaries: read" on public.summaries
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Own summaries: delete" on public.summaries
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Per-day calorie estimates sent along with each Claude summary (for the balance history).
create table public.daily_estimates (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  eaten_kcal integer,
  burned_kcal integer,
  protein_g integer,
  carbs_g integer,
  fat_g integer,
  source_period text,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.daily_estimates enable row level security;
revoke all on public.daily_estimates from anon;
revoke all on public.daily_estimates from authenticated;
grant select on public.daily_estimates to authenticated;
grant all on public.daily_estimates to service_role;
create policy "Own estimates: read" on public.daily_estimates
  for select to authenticated using ((select auth.uid()) = user_id);

-- One row per screenshot read by Claude, for the daily limit. Only the server function uses it.
create table public.screenshot_reads (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index screenshot_reads_recent on public.screenshot_reads (user_id, created_at desc);
alter table public.screenshot_reads enable row level security;
revoke all on public.screenshot_reads from anon;
revoke all on public.screenshot_reads from authenticated;
grant all on public.screenshot_reads to service_role;
