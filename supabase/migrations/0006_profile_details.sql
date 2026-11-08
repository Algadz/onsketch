-- OnSketch: richer public profiles and a profile page per user.
-- Run after 0005 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
--  * public_profiles gets bio (≤ 280 characters), country (ISO 3166-1
--    alpha-2 code, e.g. FR) and website (http(s) URL ≤ 200). All optional,
--    all public, checked by the trigger.
--  * public_profile(name): one user's public profile by username (ignoring
--    case) with their number of public sketches and thumbs-up received,
--    for the profile page /library/?u=<username>.

alter table public.public_profiles add column if not exists bio     text;
alter table public.public_profiles add column if not exists country text;
alter table public.public_profiles add column if not exists website text;

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
  new.bio := nullif(btrim(regexp_replace(coalesce(new.bio, ''), '[ \t]+', ' ', 'g')), '');
  if char_length(new.bio) > 280 then
    raise exception 'OnSketch: the description can have at most 280 characters.' using errcode = 'check_violation';
  end if;
  new.country := nullif(upper(btrim(coalesce(new.country, ''))), '');
  if new.country is not null and new.country !~ '^[A-Z]{2}$' then
    raise exception 'OnSketch: unknown country.' using errcode = 'check_violation';
  end if;
  new.website := nullif(btrim(coalesce(new.website, '')), '');
  if new.website is not null and (new.website !~ '^https?://[^\s/$.?#][^\s]*$' or char_length(new.website) > 200) then
    raise exception 'OnSketch: the website must be a link starting with https:// (200 characters at most).' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.public_profile(name text)
returns table (user_id uuid, username text, avatar_url text, bio text, country text, website text,
               joined_at timestamptz, sketches integer, likes integer)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.username, p.avatar_url, p.bio, p.country, p.website, p.created_at,
         (select count(*) from public.projects x
           where x.owner_id = p.user_id and x.visibility = 'public' and x.description is not null)::integer,
         (select count(*) from public.project_likes l join public.projects x on x.id = l.project_id
           where x.owner_id = p.user_id and x.visibility = 'public')::integer
    from public.public_profiles p
   where p.username is not null and lower(p.username) = lower(btrim(name));
$$;
grant execute on function public.public_profile(text) to anon, authenticated;
