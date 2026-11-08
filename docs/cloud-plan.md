# Accounts and cloud projects (Supabase)

Goal: sign in, keep projects in the cloud, open them from any device,
without breaking the editor's offline, no-build, GitHub Pages setup.

## Principles

- **Optional.** Signed out, the editor works exactly as today
  (`localStorage` autosave, Import / Export JSON). With `app/src/cloud/config.js`
  empty, no account UI is shown and supabase-js is never downloaded.
- **No build step.** supabase-js is loaded as an ES module from jsDelivr
  (pinned version) the first time the cloud is used.
- **Security in the database.** The publishable key is public; everything
  rests on row-level security (`supabase/migrations/`). No server code.
- **Local first.** The browser copy stays the working copy; the cloud is
  synced from it, so a dropped connection never loses work.

## Data model

`public.projects` (see `supabase/migrations/0001_projects.sql`):

| column | |
|---|---|
| `id` uuid | primary key |
| `owner_id` uuid | `auth.users`, defaults to the caller |
| `name` text | copied from the project for listing |
| `data` jsonb | the project file (`Project.toJSON()`, version 3), ≤ 5 MB |
| `visibility` | `private` (default) or `public` (read-only for anyone) |
| `revision` int | bumped by a trigger on every update; saves are conditional on it |
| `created_at`, `updated_at` | |

Policies: owners read / insert / update / delete their rows; anyone reads
`public` rows. Thumbnails (phase 4) would go to a Storage bucket
`thumbnails/<user>/<project>.png` with the same owner rule.

## Phases

### Phase 1: foundation ✅ (this change)
- SQL migration: table, trigger, RLS policies.
- `app/src/cloud/config.js`: project URL and publishable key (empty = off).
- `app/src/cloud/cloud.js`: lazy client, sign in (email link / code, OAuth),
  sign out, list / load / create / save (with revision check) / rename /
  visibility / delete. `ConflictError` when a save is stale.
- `tests/unit/cloud.test.js`: the data layer against a fake client.

### Phase 2: account UI (needs the Supabase project details)
- Menu bar: **Sign in** button (account chip with avatar / email once signed
  in; menu: My projects, Sign out). Phone layout: same entries in the ⋯ menu.
- Sign-in dialog: email → "check your inbox" (magic link, plus the 6-digit
  code for phones where the link opens another browser); Google / GitHub
  buttons for the providers that are enabled.
- Return from the email / OAuth redirect lands back in `/app/` signed in
  (PKCE, `detectSessionInUrl`).
- e2e: the sign-in dialog and account menu with a stubbed client.

### Phase 3: cloud projects
- **My projects** window: list (name, last changed), Open, Rename, Delete,
  New. The open project's cloud id and revision are kept with the local copy
  (`localStorage`), so a reload continues the same cloud project.
- **Save to cloud**: the first save of a local drawing creates the row;
  afterwards autosave also pushes to the cloud (debounced, ~3 s after the
  last change, and on page hide), status pill shows *Saved* / *Saving…* /
  *Offline, saved in this browser*.
- Conflicts (another tab or device saved first): ask *Keep mine* (save over
  theirs) / *Load theirs* / *Save mine as a copy*.
- First sign-in with a drawing open: offer to upload it.
- Sign out: the local copy stays; cloud ids are forgotten.

### Phase 4: sharing and polish
- Visibility toggle; public link `/app/?p=<id>` opens a read-only copy
  (Save makes it yours: *Duplicate to my projects*).
- Thumbnails in the projects list (canvas → PNG → Storage).
- Optional limits (e.g. projects per free account) enforced in SQL.
- Account deletion (Supabase cascade removes the projects).

## Supabase project setup (done once, by the owner)

1. SQL Editor → run `supabase/migrations/0001_projects.sql`.
2. Authentication → URL configuration: Site URL `https://onsketch.io/app/`;
   redirect URLs `https://onsketch.io/app/**` and `http://localhost:8080/app/**`.
3. Authentication → Providers: Email on (magic link). Optional: Google,
   GitHub (each needs an OAuth app; callback
   `https://<project-ref>.supabase.co/auth/v1/callback`).
4. Authentication → Emails: optionally a custom SMTP sender (the built-in one
   is rate-limited to a few emails per hour) and the magic-link template with
   `{{ .Token }}` so the code is in the mail too.
5. Put the project URL and publishable key in `app/src/cloud/config.js`.
