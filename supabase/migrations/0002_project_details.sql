-- OnSketch: project details, plans and the free limit, thumbnails.
-- Run after 0001 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
--  * Every project has a title (3–80 characters) and a description
--    (10–500 characters). Older projects without a description keep
--    working; the editor asks for one.
--  * Plans: free (3 projects, public only) or premium (unlimited, may be
--    private). A user's plan is in account_plans, which only the service
--    role (a future payment webhook) can write. No row = free.
--  * The revision (used to refuse stale saves) only moves when the
--    drawing itself changes, so editing the title or description never
--    causes a conflict.
--  * Thumbnails: private Storage bucket "thumbnails", one WebP per project
--    at <owner id>/<project id>.webp.

alter table public.projects add column if not exists description text;
alter table public.projects alter column visibility set default 'public';

/* ---- Plans ---- */
create table if not exists public.account_plans (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  plan       text not null default 'free' check (plan in ('free', 'premium')),
  updated_at timestamptz not null default now()
);
alter table public.account_plans enable row level security;
drop policy if exists "own plan" on public.account_plans;
create policy "own plan" on public.account_plans for select to authenticated using (user_id = auth.uid());
-- No insert / update / delete policies: only the service role changes plans.

create or replace function public.plan_of(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select plan from public.account_plans where user_id = uid), 'free');
$$;

-- Projects allowed per plan (null = no limit). Change the limit here.
create or replace function public.plan_project_limit(plan text)
returns integer language sql immutable as $$
  select case plan when 'premium' then null else 3 end;
$$;

/* ---- Rules checked on every insert / update ---- */
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
    raise exception 'OnSketch: private sketches are a Premium feature.' using errcode = 'insufficient_privilege';
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

drop trigger if exists projects_check on public.projects;
create trigger projects_check before insert or update on public.projects
  for each row execute function public.projects_check();

/* ---- Revision only moves with the drawing ---- */
create or replace function public.projects_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.data is distinct from old.data then new.revision := old.revision + 1;
  else new.revision := old.revision; end if;
  new.owner_id   := old.owner_id;
  new.created_at := old.created_at;
  return new;
end $$;

/* ---- Thumbnails ---- */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbnails', 'thumbnails', false, 300000, array['image/webp', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = 300000, allowed_mime_types = array['image/webp', 'image/png'];

drop policy if exists "thumbnails: owner writes"  on storage.objects;
drop policy if exists "thumbnails: owner updates" on storage.objects;
drop policy if exists "thumbnails: owner deletes" on storage.objects;
drop policy if exists "thumbnails: read"          on storage.objects;

create policy "thumbnails: owner writes" on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbnails: owner updates" on storage.objects for update to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbnails: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);
-- Your own thumbnails, and those of public projects.
create policy "thumbnails: read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'thumbnails' and (
    (storage.foldername(objects.name))[1] = auth.uid()::text
    or exists (select 1 from public.projects p      -- objects.name: p has a "name" column too
               where p.visibility = 'public'
                 and p.owner_id::text = (storage.foldername(objects.name))[1]
                 and p.id::text || '.webp' = storage.filename(objects.name))));
