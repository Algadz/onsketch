-- OnSketch: free sketches may be private.
--
-- Run this file once in the Supabase SQL Editor (safe to run again).
--
-- Before: the free plan held 3 sketches, all public; private was Pro only.
-- Now:    the free plan holds 3 sketches, each private or public (the
--         owner chooses, as on Pro). Pro stays unlimited and adds the
--         real-size exports (DXF, printing to scale) in the app.
--
--  * projects_check(): the "private needs Pro" rule is gone. Titles,
--    descriptions and the free limit of 3 are checked as before.
--  * plan_rules(): what the plans allow, read by the app. Until this
--    function exists the app keeps the old rule (free = public only), so
--    the app and the database can never disagree.
--
-- Nothing changes for existing sketches: public ones stay public until
-- their owner makes them private.

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

  if tg_op = 'INSERT' and lim is not null then
    perform pg_advisory_xact_lock(hashtext(new.owner_id::text));
    select count(*) into owned from public.projects where owner_id = new.owner_id;
    if owned >= lim then
      raise exception 'OnSketch: free plan limit (% projects).', lim using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

-- What the plans allow, for the app (signed in or not).
create or replace function public.plan_rules()
returns jsonb language sql stable as $$
  select jsonb_build_object('free_private', true, 'free_limit', public.plan_project_limit('free'));
$$;
grant execute on function public.plan_rules() to anon, authenticated;

-- Tell the API layer about plan_rules() right away.
notify pgrst, 'reload schema';
