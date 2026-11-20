-- OnSketch: private sketches are Pro only again.
--
-- Run this file once in the Supabase SQL Editor (safe to run again).
--
-- Before (0007): the free plan held 3 sketches, each private or public.
-- Now:           the free plan's sketches are public; making a sketch
--                private (a new one, or switching a public one) needs Pro.
--
-- Free sketches already private stay private (the check only applies when
-- a sketch becomes private), and their owners can still make them public.
-- Titles, descriptions and the free limit of 3 are checked as before.
-- plan_rules() says free_private = false (the app no longer reads it, but
-- other clients may).

create or replace function public.projects_check()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  plan  text := public.plan_of(coalesce(new.owner_id, auth.uid()));
  lim   integer := public.plan_project_limit(plan);
  owned integer;
begin
  new.name := btrim(coalesce(new.name, ''));
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if char_length(new.name) not between 3 and 80 then
      raise exception 'OnSketch: the title must be 3 to 80 characters.' using errcode = 'check_violation';
    end if;
  end if;

  if new.description is not null then new.description := btrim(new.description); end if;
  if tg_op = 'INSERT' or new.description is distinct from old.description then
    if new.description is null or char_length(new.description) not between 10 and 500 then
      raise exception 'OnSketch: the description must be 10 to 500 characters.' using errcode = 'check_violation';
    end if;
  end if;

  if new.visibility not in ('private', 'public') then
    raise exception 'OnSketch: unknown visibility %.', new.visibility using errcode = 'check_violation';
  end if;

  if new.visibility = 'private' and plan <> 'premium'
     and (tg_op = 'INSERT' or old.visibility is distinct from 'private') then
    raise exception 'OnSketch: private sketches are an OnSketch Pro feature.' using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' and lim is not null then
    perform pg_advisory_xact_lock(hashtext(new.owner_id::text));
    select count(*) into owned from public.projects where owner_id = new.owner_id;
    if owned >= lim then
      raise exception 'OnSketch: free plan limit (% projects).', lim using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

create or replace function public.plan_rules()
returns jsonb language sql stable as $$
  select jsonb_build_object('free_private', false, 'free_limit', public.plan_project_limit('free'));
$$;
grant execute on function public.plan_rules() to anon, authenticated;

notify pgrst, 'reload schema';
