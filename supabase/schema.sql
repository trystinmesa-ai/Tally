-- Tally cloud storage. Paste into Supabase: SQL Editor -> New query -> Run.
-- One row per saved item (a transaction, category, schedule, budget or setting).
-- Mirrors the app's IndexedDB stores, so the app can sync them as-is.

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  store      text        not null check (store in ('categories', 'transactions', 'recurring', 'budgets', 'meta')),
  id         text        not null,
  data       jsonb       not null,
  deleted    boolean     not null default false,  -- kept so deletes sync to your other devices
  updated_at timestamptz not null default now(),
  primary key (user_id, store, id)
);

create index if not exists records_user_updated on public.records (user_id, updated_at);

-- Let signed-in users reach the table through the Data API (needed when the
-- project's "Automatically expose new tables" option is off). Signed-out
-- visitors (anon) get no access at all.
revoke all on public.records from anon;
grant select, insert, update, delete on public.records to authenticated;

-- Row Level Security: a signed-in user can only see and change their own rows.
-- Without a login, nothing can be read or written.
alter table public.records enable row level security;

drop policy if exists "own rows: read"   on public.records;
drop policy if exists "own rows: insert" on public.records;
drop policy if exists "own rows: update" on public.records;
drop policy if exists "own rows: delete" on public.records;

create policy "own rows: read"   on public.records for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.records for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.records for delete to authenticated using ((select auth.uid()) = user_id);

-- Keep updated_at current on every change (used to sync only what changed).
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.touch_updated_at();
