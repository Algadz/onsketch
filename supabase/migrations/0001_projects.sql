-- OnSketch cloud projects.
-- Run in the Supabase dashboard: SQL Editor → paste → Run. Safe to run
-- again. It upgrades the `projects` table of the earlier OnSketch (id,
-- owner_id, name, visibility, share_code, data, created_at, updated_at)
-- in place, or creates it on a fresh project. Existing rows are kept.
--
-- One row per project. The whole project file (Project.toJSON()) lives in
-- `data`; files are small (tens of KB), so jsonb beats Storage objects:
-- one round trip, atomic saves, and row-level security for free.

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default 'Untitled',
  visibility  text not null default 'private',
  share_code  text,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Bumped by the trigger below on every update. The editor saves with
-- "where revision = <the one I loaded>", so a save from a stale tab (or
-- another device) is refused instead of silently overwriting.
alter table public.projects add column if not exists revision integer not null default 1;
alter table public.projects alter column owner_id set default auth.uid();

create index if not exists projects_owner_updated_idx
  on public.projects (owner_id, updated_at desc);

create or replace function public.projects_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.revision   := old.revision + 1;
  new.owner_id   := old.owner_id;     -- a project never changes hands
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.projects_touch();

-- Row-level security: you see and change your own projects; anyone
-- (signed in or not) can read a project marked public.
-- Policies are permissive (OR-ed), so any other policy on this table
-- still applies on top of these: check with
--   select policyname, cmd, roles, qual, with_check from pg_policies where tablename = 'projects';
alter table public.projects enable row level security;

-- Policies of the earlier OnSketch, replaced by the ones below.
drop policy if exists "Projects are readable by owner or public" on public.projects;
drop policy if exists "Projects are deletable by owner"          on public.projects;
drop policy if exists "owner reads"   on public.projects;
drop policy if exists "public reads"  on public.projects;
drop policy if exists "owner inserts" on public.projects;
drop policy if exists "owner updates" on public.projects;
drop policy if exists "owner deletes" on public.projects;

create policy "owner reads"   on public.projects for select to authenticated using (owner_id = auth.uid());
create policy "public reads"  on public.projects for select to anon, authenticated using (visibility = 'public');
create policy "owner inserts" on public.projects for insert to authenticated with check (owner_id = auth.uid());
create policy "owner updates" on public.projects for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner deletes" on public.projects for delete to authenticated using (owner_id = auth.uid());

-- Keep a project file reasonable (5 MB).
alter table public.projects drop constraint if exists projects_data_size;
alter table public.projects add constraint projects_data_size check (octet_length(data::text) <= 5000000) not valid;
