-- OnSketch: public usernames chosen by the user.
-- Run after 0003 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
-- Until now the editor created a profile automatically from the Google
-- account name and picture. Nothing is published under a name or picture
-- the user didn't choose any more:
--  * public_profiles.username: chosen by the user on first sign-in,
--    3–24 characters (letters, digits, _ . -), unique ignoring case, a few
--    names reserved. The library shows it; without one, "OnSketch user".
--  * avatar_url is only set when the user ticks "Show my picture".
--    Profiles created automatically before (no username) lose it now.
--  * username_available(name): exact, case-insensitive check for the
--    sign-up form (a LIKE query would treat _ as a wildcard).

alter table public.public_profiles add column if not exists username text;
alter table public.public_profiles alter column display_name drop not null;
create unique index if not exists public_profiles_username_key on public.public_profiles (lower(username));

update public.public_profiles set avatar_url = null where username is null;

create or replace function public.public_profiles_touch()
returns trigger language plpgsql as $$
begin
  if new.display_name is not null then new.display_name := btrim(regexp_replace(new.display_name, '\s+', ' ', 'g')); end if;
  if new.username is not null then
    new.username := btrim(new.username);
    if new.username !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$' then
      raise exception 'OnSketch: a username has 3 to 24 letters, digits, _ . or - and starts with a letter or digit.' using errcode = 'check_violation';
    end if;
    if lower(new.username) in ('admin', 'administrator', 'onsketch', 'support', 'help', 'moderator', 'mod', 'staff', 'team',
                               'root', 'system', 'official', 'library', 'anonymous', 'null', 'undefined', 'onsketch_user') then
      raise exception 'OnSketch: this username is reserved.' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.public_profiles
                     where lower(username) = lower(btrim(name)) and user_id is distinct from auth.uid());
$$;
grant execute on function public.username_available(text) to anon, authenticated;

create or replace view public.library_sketches as
  select p.id, p.owner_id, p.name, p.description, p.created_at, p.updated_at,
         coalesce(a.username, 'OnSketch user') as author_name,
         case when a.username is not null then a.avatar_url end as author_avatar,
         (select count(*) from public.project_likes l where l.project_id = p.id)::integer as likes
    from public.projects p
    left join public.public_profiles a on a.user_id = p.owner_id
   where p.visibility = 'public' and p.description is not null;
grant select on public.library_sketches to anon, authenticated;
