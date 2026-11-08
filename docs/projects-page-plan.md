# My sketches page, project details, free limit

Follows `docs/cloud-plan.md` (phases 1–3 done: sign-in, cloud save,
autosave, conflicts). This plan replaces its phase 4.

## Goal

- A dedicated page where a signed-in user sees their projects as cards
  with a preview.
- Every saved project has a **title** and a **description of at least
  10 characters**.
- Free accounts: **3 projects** for now.
- Later: free projects feed a **public library**; **private projects**
  are a Premium feature.

## The page: `/app/projects/` ("My sketches")

A real page (own URL, works on reload, back button, shareable later),
in the editor's look, light and dark, phone-friendly. Reached from the
account button (avatar → *My sketches*) and after sign-in.

```
┌──────────────────────────────────────────────────────────────┐
│ OnSketch      My sketches                  [+ New]  (A) ▾     │
├──────────────────────────────────────────────────────────────┤
│ Free plan · 2 of 3 sketches used  ▓▓▓▓▓▓░░░   Upgrade →       │
│                                                              │
│ ┌────────────┐ ┌────────────┐ ┌ ─ ─ ─ ─ ─ ─┐                  │
│ │ [preview]  │ │ [preview]  │   + New        │                │
│ │            │ │            │ │   sketch    │                 │
│ │ Desk       │ │ Garden bed │   1 left       │                │
│ │ Standing…  │ │ Raised be… │ └ ─ ─ ─ ─ ─ ─┘                  │
│ │ 2 h ago ⋯  │ │ 3 days  ⋯  │                                  │
│ └────────────┘ └────────────┘                                  │
└──────────────────────────────────────────────────────────────┘
```

Each card shows:
| | why |
|---|---|
| **Preview** (16:10, the drawing fitted, theme-independent light background) | recognise a sketch at a glance |
| **Title** (1 line) and **description** (2 lines, clipped) | what it is; the description is what the public library will show |
| **Last changed** ("2 h ago") | find the latest work |
| **Visibility badge**: *Public* / *Private 🔒* | makes the free = public rule visible before the library exists |
| **Size hint**: entities · layers (small, muted) | optional, cheap from `data` |
| **⋯ menu**: Open, Edit details, Duplicate, Download JSON, Delete | |

Click on a card = open in the editor (`/app/?project=<id>`).
The card for the drawing currently linked in this browser gets an
*Open in editor* marker.

Header strip: plan, **usage meter "2 of 3 sketches"**, *Upgrade* link
(goes to a "Premium is coming" note until payments exist).
At the limit, the *New* card turns into an upsell card: "You've used
your 3 free sketches. Delete one, or go Premium for unlimited and
private sketches."

Empty state: a short pitch, *New sketch* and *Try the desk example*.

Later tabs on the same page: **Mine** | **Library** (public sketches of
everyone) | **Liked**.

## Saving: title and description required

The first save to the account (and *Edit details*) opens a form:

- **Title**: required, 3–80 characters (pre-filled from the project name).
- **Description**: required, **10–500 characters**, live counter
  ("7 / 10 minimum"); Save stays disabled below 10.
- **Preview** of the thumbnail.
- **Visibility**: see decisions below.

The title keeps syncing with the editor's project-name field. Autosave
afterwards changes only the drawing (and the thumbnail), never asks again.
Rules are enforced in the database too, so no client can skip them.

## Thumbnails

Rendered in the browser from the project (not a screenshot of the
viewport): fit to geometry, light theme, no grid / selection / handles,
**640 × 400 WebP** (~10–25 KB), refreshed with autosave at most once
every ~30 s and on page hide.

Stored in Supabase **Storage**, bucket `thumbnails`, path
`<owner_id>/<project_id>.webp`, so the list query stays small and the
library can use the CDN. Policies: owner writes their folder; anyone
reads thumbnails of public projects; owner reads their private ones.
Each row keeps `thumbnail_version` to bust caches.

## Database changes (`0002_project_details.sql`)

- `projects.description text` with `char_length(btrim(description)) between 10 and 500`
  (`not valid`, so existing rows are asked on their next save).
- `projects.name`: `char_length(btrim(name)) between 3 and 80`.
- `projects.thumbnail_version int`.
- `profiles.plan text default 'free' check (plan in ('free','premium'))`,
  writable only by the service role (future payment webhook), readable by
  the owner. Row created on sign-up by trigger.
- **Limit trigger**: before insert, a free user with 3 projects gets
  `OnSketch: free plan limit (3 projects)`; the editor shows the upsell.
  The number lives in one SQL function (`plan_project_limit(plan)`), so
  changing it is one line.
- **Visibility rule** (once decided): free users can't set `private`
  (trigger), Premium can.

## Editor changes

- Account menu: *My sketches* opens the page; the dialog's project list
  is replaced by it.
- `/app/?project=<id>` opens that project (keeps today's link / conflict
  logic).
- Save to account → details form; at the limit → upsell instead.
- Status bar title shows the cloud title.

## Phases

1. **Details + limit** — migration 0002, details form on first save and
   *Edit details*, limit trigger and upsell. Existing projects without a
   description get the form on next open.
2. **My sketches page** — `/app/projects/`, cards, usage meter, ⋯ actions,
   `?project=` deep link, account menu entry.
3. **Thumbnails** — renderer to WebP, Storage bucket + policies, upload
   with autosave, cards show them (placeholder until the first upload).
4. **Public library** — `/library/` (or a tab), read-only viewer
   `/app/?view=<id>`, *Duplicate to my sketches*, reporting/moderation,
   sitemap entries.
5. **Premium** — payments (Stripe Checkout + webhook → `profiles.plan`),
   private projects, higher/no limit.

Tests at each phase: unit (data layer, limit/visibility errors),
`tests/cloud.e2e.mjs` extended with the fake (form validation, limit,
page cards), plus a live signed-out check of the page.

## Decisions needed

1. **Free projects visibility now.** The library doesn't exist yet.
   Recommended: free projects are saved **public by default with a clear
   badge and a note in the save form** ("Free sketches will appear in
   the public library"), but the library page isn't built yet, so nothing
   is listed anywhere. Existing projects stay as they are (private ones
   stay private) until their owner opens them. Alternative: keep
   everything private until the library launches, then ask each user.
2. **Limit = 3 projects in total** (public + private), or 3 private and
   unlimited public? Recommended for now: 3 in total, simple to explain.
3. **"More than 10 characters"** applies to the description; title
   minimum 3. OK?
4. **Page URL**: `/app/projects/` (recommended) or `/projects/`.
