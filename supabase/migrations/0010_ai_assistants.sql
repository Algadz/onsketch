-- OnSketch: limits for AI assistants (the MCP server, supabase/functions/mcp).
-- Run in the Supabase dashboard: SQL Editor → paste → Run. Safe to run again.
--
-- Assistants sign in through Supabase Auth's OAuth 2.1 server. The token
-- they get is an ordinary user token, so the policies above would let it
-- do anything the user can. Tokens issued to an OAuth client carry its
-- id in the `client_id` claim; the user's own sessions in the app don't.
-- These restrictive policies (AND-ed with the others) keep assistants to
-- what the consent page (/oauth/consent/) says: create, read and change
-- sketches. They can't delete anything, touch the profile or likes,
-- or change whether a sketch is public.
--
-- Check the claim name once on your project: approve an assistant, then
-- decode its access token (jwt.io) and look for "client_id". If it has
-- another name, change public.via_assistant() below.

create or replace function public.via_assistant()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'client_id', '') <> ''
$$;

-- Projects: no deleting.
drop policy if exists "assistants: no deletes" on public.projects;
create policy "assistants: no deletes" on public.projects as restrictive
  for delete to authenticated using (not public.via_assistant());

-- Versions (history kept on every save): no deleting.
drop policy if exists "assistants: no deletes" on public.project_versions;
create policy "assistants: no deletes" on public.project_versions as restrictive
  for delete to authenticated using (not public.via_assistant());

-- Profiles and likes: hands off.
drop policy if exists "assistants: no inserts" on public.public_profiles;
drop policy if exists "assistants: no updates" on public.public_profiles;
drop policy if exists "assistants: no deletes" on public.public_profiles;
create policy "assistants: no inserts" on public.public_profiles as restrictive for insert to authenticated with check (not public.via_assistant());
create policy "assistants: no updates" on public.public_profiles as restrictive for update to authenticated using (not public.via_assistant());
create policy "assistants: no deletes" on public.public_profiles as restrictive for delete to authenticated using (not public.via_assistant());

drop policy if exists "assistants: no inserts" on public.project_likes;
drop policy if exists "assistants: no deletes" on public.project_likes;
create policy "assistants: no inserts" on public.project_likes as restrictive for insert to authenticated with check (not public.via_assistant());
create policy "assistants: no deletes" on public.project_likes as restrictive for delete to authenticated using (not public.via_assistant());

-- Thumbnails: no deleting (the app uploads them; assistants don't).
drop policy if exists "assistants: no thumbnail deletes" on storage.objects;
create policy "assistants: no thumbnail deletes" on storage.objects as restrictive
  for delete to authenticated using (bucket_id <> 'thumbnails' or not public.via_assistant());

-- A sketch's visibility is the user's choice: an assistant sets it when it
-- creates one (after asking, see the MCP server) but can't change it after.
create or replace function public.projects_assistant_guard()
returns trigger language plpgsql as $$
begin
  if public.via_assistant() and new.visibility is distinct from old.visibility then
    raise exception 'OnSketch: an assistant can''t change whether a sketch is public. Change it in OnSketch.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists projects_assistant_guard on public.projects;
create trigger projects_assistant_guard before update on public.projects
  for each row execute function public.projects_assistant_guard();
