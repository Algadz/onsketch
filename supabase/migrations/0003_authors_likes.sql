-- OnSketch: authors and thumbs-up in the public library.
-- Run after 0002 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
--  * public_profiles: the name (and picture) shown next to a user's public
--    sketches. Anyone can read it; each user writes only their own.
--    Never holds the email address.
--  * project_likes: one thumbs-up per user per public sketch, not on your
--    own. Each user sees only their own likes; counts are public through
--    the library view.
--  * library_sketches: public sketches with a description, with author
--    name / picture and like count. It runs with its owner's rights (so
--    it can count likes) and only ever returns public rows.

create table if not exists public.public_profiles (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 40),
  avatar_url   text check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.public_profiles enable row level security;
drop policy if exists "profiles: anyone reads"  on public.public_profiles;
drop policy if exists "profiles: own insert"    on public.public_profiles;
drop policy if exists "profiles: own update"    on public.public_profiles;
drop policy if exists "profiles: own delete"    on public.public_profiles;
create policy "profiles: anyone reads" on public.public_profiles for select to anon, authenticated using (true);
create policy "profiles: own insert"   on public.public_profiles for insert to authenticated with check (user_id = auth.uid());
create policy "profiles: own update"   on public.public_profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profiles: own delete"   on public.public_profiles for delete to authenticated using (user_id = auth.uid());

create or replace function public.public_profiles_touch()
returns trigger language plpgsql as $$
begin
  new.display_name := btrim(regexp_replace(new.display_name, '\s+', ' ', 'g'));
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists public_profiles_touch on public.public_profiles;
create trigger public_profiles_touch before insert or update on public.public_profiles
  for each row execute function public.public_profiles_touch();

create table if not exists public.project_likes (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_likes_user_idx on public.project_likes (user_id);
alter table public.project_likes enable row level security;
drop policy if exists "likes: own read"   on public.project_likes;
drop policy if exists "likes: own insert" on public.project_likes;
drop policy if exists "likes: own delete" on public.project_likes;
create policy "likes: own read" on public.project_likes for select to authenticated using (user_id = auth.uid());
-- Only public sketches, and not your own.
create policy "likes: own insert" on public.project_likes for insert to authenticated
  with check (user_id = auth.uid() and exists (
    select 1 from public.projects p where p.id = project_id and p.visibility = 'public' and p.owner_id <> auth.uid()));
create policy "likes: own delete" on public.project_likes for delete to authenticated using (user_id = auth.uid());

drop view if exists public.library_sketches;
create view public.library_sketches as
  select p.id, p.owner_id, p.name, p.description, p.created_at, p.updated_at,
         coalesce(a.display_name, 'OnSketch user') as author_name,
         a.avatar_url as author_avatar,
         (select count(*) from public.project_likes l where l.project_id = p.id)::integer as likes
    from public.projects p
    left join public.public_profiles a on a.user_id = p.owner_id
   where p.visibility = 'public' and p.description is not null;
grant select on public.library_sketches to anon, authenticated;
