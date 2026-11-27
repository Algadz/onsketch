-- OnSketch: version history of cloud sketches, and remixes.
-- Run after 0008 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
-- Version history
--  * project_versions keeps earlier states of a sketch's drawing. The
--    editor saves a few seconds after every change, so a version is not
--    kept for every save: when a save changes the drawing and the
--    sketch's newest version is more than 10 minutes old, the drawing as
--    it was *before* that save is kept (the trigger below). So a session
--    of work after a pause starts with a version of how it was, and long
--    sessions get one every 10 minutes.
--  * Named versions ("Save version…", OnSketch Pro): the drawing as it is
--    now, with a name and an optional note, kept for good
--    (save_version). Pro can also name an automatic one (name_version).
--  * restore_version(id) keeps the current drawing as a version, then
--    puts the old one back (so a restore can itself be undone).
--  * How many are kept (prune_versions, after each new version):
--      free:  the 3 newest automatic versions;
--      Pro:   all of the last 24 hours, then the newest of each day for
--             30 days, then the newest of each month.
--    Named versions are never removed (they stay if Pro ends).
--  * Only the sketch's owner reads or deletes them; they are written by
--    the trigger and the functions here (security definer), never
--    directly.
--
-- Remixes
--  * projects.remixed_from: the public sketch a sketch was remixed from
--    (opened from the library and saved as one's own). Set when the
--    remix is created, only to a sketch that is public (or one's own);
--    it can be cleared, not changed. If the original is deleted it
--    becomes null.
--  * library_sketches adds: remixes (how many sketches were saved from
--    this one) and, for a remix whose original is still public, the
--    original's id, title and author.

/* ---- Version history ---- */
create table if not exists public.project_versions (
  id         bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  saved_at   timestamptz not null,               -- when this state of the drawing was saved
  created_at timestamptz not null default now(),  -- when it became a version
  kind       text not null default 'auto' check (kind in ('auto', 'named', 'restore')),
  name       text check (name is null or char_length(name) between 1 and 80),
  note       text check (note is null or char_length(note) <= 500),
  data       jsonb not null
);
create index if not exists project_versions_project_idx on public.project_versions (project_id, saved_at desc);
create index if not exists project_versions_owner_idx on public.project_versions (owner_id);

alter table public.project_versions enable row level security;
drop policy if exists "versions: owner reads"   on public.project_versions;
drop policy if exists "versions: owner deletes" on public.project_versions;
create policy "versions: owner reads"   on public.project_versions for select to authenticated using (owner_id = auth.uid());
create policy "versions: owner deletes" on public.project_versions for delete to authenticated using (owner_id = auth.uid());
-- No insert / update policies: versions are written by the functions below.

/** Thins out a sketch's automatic versions (see the top of this file). */
create or replace function public.prune_versions(pid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  owner uuid := (select owner_id from public.projects where id = pid);
begin
  if owner is null then return; end if;
  if public.plan_of(owner) = 'premium' then
    delete from public.project_versions v
     where v.project_id = pid and v.kind <> 'named' and v.saved_at < now() - interval '1 day'
       and v.id not in (
         select distinct on (case when saved_at >= now() - interval '30 days'
                                  then date_trunc('day', saved_at) else date_trunc('month', saved_at) end) id
           from public.project_versions
          where project_id = pid and kind <> 'named' and saved_at < now() - interval '1 day'
          order by (case when saved_at >= now() - interval '30 days'
                         then date_trunc('day', saved_at) else date_trunc('month', saved_at) end), saved_at desc);
  else
    delete from public.project_versions v
     where v.project_id = pid and v.kind <> 'named'
       and v.id not in (select id from public.project_versions
                         where project_id = pid and kind <> 'named'
                         order by saved_at desc, id desc limit 3);
  end if;
end $$;
revoke execute on function public.prune_versions(uuid) from public, anon, authenticated;

/** After a save that changed the drawing: keeps the drawing as it was
 *  before, at most once every 10 minutes per sketch. */
create or replace function public.projects_keep_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.data is distinct from old.data and not exists (
       select 1 from public.project_versions
        where project_id = new.id and created_at > now() - interval '10 minutes') then
    insert into public.project_versions (project_id, owner_id, saved_at, kind, data)
    values (old.id, old.owner_id, old.updated_at, 'auto', old.data);
    perform public.prune_versions(new.id);
  end if;
  return null;
end $$;
drop trigger if exists projects_keep_version on public.projects;
create trigger projects_keep_version after update of data on public.projects
  for each row execute function public.projects_keep_version();

/** Checks that the signed-in user owns sketch `pid`. */
create or replace function public._own_project(pid uuid)
returns public.projects language plpgsql security definer set search_path = public as $$
declare p public.projects;
begin
  select * into p from public.projects where id = pid;
  if p.id is null or p.owner_id is distinct from auth.uid() then
    raise exception 'OnSketch: this sketch is not in your account.' using errcode = 'insufficient_privilege';
  end if;
  return p;
end $$;
revoke execute on function public._own_project(uuid) from public, anon, authenticated;

/** "Save version…" (Pro): the sketch's drawing as it is now, named. */
create or replace function public.save_version(pid uuid, vname text, vnote text default null)
returns setof public.project_versions language plpgsql security definer set search_path = public as $$
declare
  p public.projects := public._own_project(pid);
  n text := nullif(btrim(regexp_replace(coalesce(vname, ''), '\s+', ' ', 'g')), '');
  t text := nullif(btrim(coalesce(vnote, '')), '');
begin
  if public.plan_of(auth.uid()) <> 'premium' then
    raise exception 'OnSketch: named versions are an OnSketch Pro feature.' using errcode = 'insufficient_privilege';
  end if;
  if n is null or char_length(n) > 80 then
    raise exception 'OnSketch: a version name has 1 to 80 characters.' using errcode = 'check_violation';
  end if;
  if char_length(t) > 500 then
    raise exception 'OnSketch: the note can have at most 500 characters.' using errcode = 'check_violation';
  end if;
  return query
    insert into public.project_versions (project_id, owner_id, saved_at, kind, name, note, data)
    values (p.id, p.owner_id, p.updated_at, 'named', n, t, p.data)
    returning *;
end $$;
grant execute on function public.save_version(uuid, text, text) to authenticated;

/** Names (or renames) a version, which is then kept for good (Pro).
 *  An empty name turns a named version back into an automatic one. */
create or replace function public.name_version(vid bigint, vname text, vnote text default null)
returns setof public.project_versions language plpgsql security definer set search_path = public as $$
declare
  v public.project_versions;
  n text := nullif(btrim(regexp_replace(coalesce(vname, ''), '\s+', ' ', 'g')), '');
  t text := nullif(btrim(coalesce(vnote, '')), '');
begin
  select * into v from public.project_versions where id = vid and owner_id = auth.uid();
  if v.id is null then raise exception 'OnSketch: no such version.' using errcode = 'no_data_found'; end if;
  if public.plan_of(auth.uid()) <> 'premium' then
    raise exception 'OnSketch: named versions are an OnSketch Pro feature.' using errcode = 'insufficient_privilege';
  end if;
  if char_length(n) > 80 or char_length(t) > 500 then
    raise exception 'OnSketch: a version name has 1 to 80 characters, a note at most 500.' using errcode = 'check_violation';
  end if;
  return query
    update public.project_versions
       set name = n, note = case when n is null then null else t end,
           kind = case when n is null then 'auto' else 'named' end
     where id = vid
    returning *;
end $$;
grant execute on function public.name_version(bigint, text, text) to authenticated;

/** Puts version `vid` back as the sketch's drawing. The drawing as it was
 *  is kept as a version first. Returns the sketch's new revision. */
create or replace function public.restore_version(vid bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v public.project_versions;
  p public.projects;
  rev integer;
begin
  select * into v from public.project_versions where id = vid and owner_id = auth.uid();
  if v.id is null then raise exception 'OnSketch: no such version.' using errcode = 'no_data_found'; end if;
  p := public._own_project(v.project_id);
  insert into public.project_versions (project_id, owner_id, saved_at, kind, data)
  values (p.id, p.owner_id, p.updated_at, 'restore', p.data);
  -- The title stays; only the drawing comes back (its name follows the sketch).
  update public.projects
     set data = jsonb_set(v.data, '{name}', to_jsonb(p.name))
   where id = p.id
  returning revision into rev;
  perform public.prune_versions(p.id);
  return rev;
end $$;
grant execute on function public.restore_version(bigint) to authenticated;

/* ---- Remixes ---- */
alter table public.projects add column if not exists remixed_from uuid references public.projects (id) on delete set null;
create index if not exists projects_remixed_from_idx on public.projects (remixed_from) where remixed_from is not null;

create or replace function public.projects_remix_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.remixed_from is distinct from old.remixed_from and new.remixed_from is not null then
    new.remixed_from := old.remixed_from;            -- can be cleared, not changed
  end if;
  if tg_op = 'INSERT' and new.remixed_from is not null and not exists (
       select 1 from public.projects o
        where o.id = new.remixed_from and o.id <> new.id
          and (o.visibility = 'public' or o.owner_id = coalesce(new.owner_id, auth.uid()))) then
    new.remixed_from := null;                         -- unknown or private: no credit, no error
  end if;
  return new;
end $$;
drop trigger if exists projects_remix_check on public.projects;
create trigger projects_remix_check before insert or update on public.projects
  for each row execute function public.projects_remix_check();

create or replace view public.library_sketches as
  select p.id, p.owner_id, p.name, p.description, p.created_at, p.updated_at,
         coalesce(a.username, 'OnSketch user') as author_name,
         case when a.username is not null then a.avatar_url end as author_avatar,
         (select count(*) from public.project_likes l where l.project_id = p.id)::integer as likes,
         (select count(*) from public.projects r where r.remixed_from = p.id)::integer as remixes,
         o.id as remixed_from,
         o.name as remixed_from_name,
         case when o.id is not null then coalesce(oa.username, 'OnSketch user') end as remixed_from_author
    from public.projects p
    left join public.public_profiles a on a.user_id = p.owner_id
    left join public.projects o on o.id = p.remixed_from and o.visibility = 'public' and o.description is not null
    left join public.public_profiles oa on oa.user_id = o.owner_id
   where p.visibility = 'public' and p.description is not null;
grant select on public.library_sketches to anon, authenticated;

notify pgrst, 'reload schema';
