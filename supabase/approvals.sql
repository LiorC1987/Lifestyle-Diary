-- Life Diary: new accounts wait for the admin's approval.
-- Run once after setup.sql, in the Supabase SQL editor. Safe to run again.
--
-- Anyone can still create an account, but until the admin approves it the
-- account cannot save a diary or photos online, and cannot ask Claude for
-- summaries. The admin is the account with the email below; it approves or
-- turns down accounts on the "Manage accounts" screen in the app.

create schema if not exists private;
grant usage on schema private to authenticated;

create table if not exists public.accounts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  is_admin     boolean not null default false,
  requested_at timestamptz not null default now(),
  decided_at   timestamptz
);
alter table public.accounts enable row level security;
-- No one reads or changes this table directly; only the functions below do.
revoke all on public.accounts from anon, authenticated;
grant all on public.accounts to service_role;

-- Every new sign-up starts as pending.
create or replace function private.add_account() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.add_account();

-- Accounts made before this file was run are approved, and the admin is marked.
insert into public.accounts (user_id, status, decided_at)
  select id, 'approved', now() from auth.users
  on conflict (user_id) do nothing;
update public.accounts a set is_admin = true, status = 'approved', decided_at = coalesce(a.decided_at, now())
  from auth.users u where u.id = a.user_id and lower(u.email) = 'liorcaspi@gmail.com';

create or replace function private.is_admin() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a where a.user_id = (select auth.uid()) and a.is_admin);
$$;
create or replace function private.is_approved() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a where a.user_id = (select auth.uid()) and a.status = 'approved');
$$;
revoke all on function private.is_admin() from public, anon;
revoke all on function private.is_approved() from public, anon;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.is_approved() to authenticated;

-- What the app asks after signing in: this account's status, and for the admin,
-- how many accounts are waiting.
create or replace function public.my_access() returns json
  language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'status', coalesce(a.status, 'pending'),
    'admin', coalesce(a.is_admin, false),
    'waiting', case when coalesce(a.is_admin, false)
      then (select count(*) from public.accounts p where p.status = 'pending') else 0 end)
  from (select 1) one left join public.accounts a on a.user_id = (select auth.uid());
$$;

-- The admin's list of accounts, waiting ones first.
create or replace function public.admin_list_accounts()
  returns table (user_id uuid, email text, status text, is_admin boolean,
                 requested_at timestamptz, decided_at timestamptz, last_sign_in_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Only the admin can see the accounts.' using errcode = '42501';
  end if;
  return query
    select a.user_id, u.email::text, a.status, a.is_admin, a.requested_at, a.decided_at, u.last_sign_in_at
    from public.accounts a join auth.users u on u.id = a.user_id
    order by (a.status = 'pending') desc, a.requested_at desc;
end $$;

-- The admin approves, turns down, or takes back an account.
create or replace function public.admin_set_status(target uuid, new_status text) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Only the admin can change accounts.' using errcode = '42501';
  end if;
  if new_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Unknown status: %', new_status;
  end if;
  if exists (select 1 from public.accounts where user_id = target and is_admin) then
    raise exception 'The admin account cannot be changed here.';
  end if;
  update public.accounts
    set status = new_status, decided_at = case when new_status = 'pending' then null else now() end
    where user_id = target;
  if not found then raise exception 'There is no such account.'; end if;
end $$;

revoke all on function public.my_access() from public, anon;
revoke all on function public.admin_list_accounts() from public, anon;
revoke all on function public.admin_set_status(uuid, text) from public, anon;
grant execute on function public.my_access() to authenticated;
grant execute on function public.admin_list_accounts() to authenticated;
grant execute on function public.admin_set_status(uuid, text) to authenticated;

-- The diary and the photos are saved online only for approved accounts.
drop policy if exists "Own diary: read" on public.diaries;
drop policy if exists "Own diary: add" on public.diaries;
drop policy if exists "Own diary: change" on public.diaries;
drop policy if exists "Own diary: delete" on public.diaries;
create policy "Own diary: read" on public.diaries for select to authenticated
  using ((select auth.uid()) = user_id and (select private.is_approved()));
create policy "Own diary: add" on public.diaries for insert to authenticated
  with check ((select auth.uid()) = user_id and (select private.is_approved()));
create policy "Own diary: change" on public.diaries for update to authenticated
  using ((select auth.uid()) = user_id and (select private.is_approved()))
  with check ((select auth.uid()) = user_id and (select private.is_approved()));
create policy "Own diary: delete" on public.diaries for delete to authenticated
  using ((select auth.uid()) = user_id and (select private.is_approved()));

drop policy if exists "Own photos: read" on storage.objects;
drop policy if exists "Own photos: add" on storage.objects;
drop policy if exists "Own photos: change" on storage.objects;
drop policy if exists "Own photos: delete" on storage.objects;
create policy "Own photos: read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_approved()));
create policy "Own photos: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_approved()));
create policy "Own photos: change" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_approved()))
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_approved()));
create policy "Own photos: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.is_approved()));
