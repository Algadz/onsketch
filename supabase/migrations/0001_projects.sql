-- OnSketch cloud projects (phase 1).
-- Run once in the Supabase dashboard: SQL Editor → paste → Run
-- (or `supabase db push` with the Supabase CLI linked to the project).
--
-- One row per project. The whole project file (Project.toJSON(), version 3)
-- lives in `data`; files are small (tens of KB), so jsonb beats Storage
-- objects: one round trip, atomic saves, and row-level security for free.

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default 'Untitled' check (char_length(name) between 1 and 200),
  data        jsonb not null check (octet_length(data::text) <= 5000000),
  visibility  text not null default 'private' check (visibility in ('private', 'public')),
  -- Bumped by the trigger on every update. The editor saves with
  -- "where revision = <the one I loaded>", so a save from a stale tab
  -- (or another device) is refused instead of silently overwriting.
  revision    integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

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
alter table public.projects enable row level security;

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
