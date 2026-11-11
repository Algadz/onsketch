# OnSketch

Browser-based parametric 2D sketcher: SolidWorks-style geometric constraints
and dimensions, with Paint.NET-style layers and a fill tool.

- `index.html` is the landing page; `app/` is the editor.
- No build step. `app/index.html` loads `app/src/main.js` as native ES modules,
  so GitHub Pages serves the repo as is.

## Develop

```bash
npm install          # dev tools only (eslint)
npm run serve        # http://localhost:8080/app/
npm test             # unit tests (node:test, no browser)
npm run test:e2e     # drives the editor in headless Chromium (needs playwright)
npm run test:ink     # text, text boxes, groups and linked ink, driven like a user
npm run test:arrow   # arrows (snapping, attached ends, end handles), resize and turn
npm run test:display # grid / snap / dimensions / relations saved with the project
npm run test:image   # imported images: picker, 3 MB limit, drop, paste, transparency, resize / turn, link
npm run test:clipboard # Ctrl+C / X / V for ink, across tabs and from other apps (text, images)
npm run test:linedim # Smart Dimension between two parallel lines
npm run test:layers  # relations and dimensions between layers, hiding a layer
node tests/style.e2e.mjs  # restyling arrows / texts after drawing, touch tap-through guard
npm run test:mobile  # phone / tablet layout and touch input on emulated devices
npm run test:cloud   # account and cloud projects against a fake Supabase
npm run lint
npm run stamp        # after changing anything in app/: refresh cache-busting hashes
node scripts/landing-shots.mjs # regenerate landing page images (hero + examples carousel)
node scripts/build-examples.mjs # regenerate app/examples/*.json (opened with /app/?example=<slug>)
```

While the modules load, `app/index.html` shows only a clean shell: an
inline script sets the saved theme and the phone layout before the first
paint, `html.booting` hides the menu bar buttons, windows and status bar,
and a "Loading the editor…" note appears only after 0.4 s. `main.js`
removes the class once the windows are placed and fades the interface in;
if the editor fails to start (or takes over 12 s), the note offers Reload.

`app/index.html` carries an import map that points every module at
`file.js?v=<content hash>`, so browsers never mix a fresh page with stale
cached modules after a deploy. `npm test` fails if the stamp is out of date.

## Interface

- **Menu bar**: New / Open / Save with the save status, edit actions, project name, view toggles (grid, snap,
  dimensions `M`, relations `K`, zoom, theme) and toggles for each window.
  Grid, snap, dimensions, relations and dimension names are **saved with
  the project**: a drawing opens the way it was left, in this browser, from
  the account on another device, or as an example. Toggling isn't an undo
  step and undo never flips them back. A new sketch, or a file saved before
  this existed, starts from the current setup. The light / dark theme is a
  per-device preference.
- **Options bar** (second row): settings for the active tool, as in Paint.NET.
  Line weight, line type and construction while drawing; a short hint with
  Select (Mirror and Offset are in the Tools window); step-by-step help for
  Smart Dimension; Fill / Erase for the Fill tool.
- **Floating windows** over the canvas, dragged by their title bar and
  remembered per browser: Tools, Colors, Layers, Properties, Equations.
  *Reset window layout* puts them back.
- **Properties** reads top to bottom: what is selected, its values (X / Y,
  length and angle, centre and diameter, construction, layer), Relations,
  Dimensions. Relation buttons are toggles: lit with ✓ when the relation
  already holds (click again to remove it), dashed when it holds for part
  of the selection, so a relation is never added twice. Under them, every
  relation on the selection; hover highlights it on the canvas, click
  selects it, × removes it. Dimensions are edited in place (a value or
  `=equation`); only missing ones are offered. Typing a length or diameter
  changes the driving dimension when there is one. A selected relation or
  dimension shows what it ties, its value, Driven, and Delete.
- **Line colour always shows state**, as in SolidWorks: blue under-defined,
  black fully defined, red over-defined, pink construction, orange selected.
- **Sketch** window: Fill (B), Pen (N), Marker (G) and Eraser (E), with the
  size of the current tool (or Fill / Erase for the bucket). Strokes are
  vector, in world units, on the active layer and drawn on top of its
  shapes; the solver, dimensions, snapping and the Fill tool ignore them.
  The eraser removes whole strokes on the active layer. With the Select
  tool, strokes on the active layer are selected like shapes (click,
  Ctrl / Shift-click, box), dragged, deleted, and edited in Properties
  (colour, opacity, width, layer); geometry under the cursor wins, and
  selected ink moves along when a selected shape is dragged. Roadmap:
  `docs/sketch-tools-plan.md`.
- **Text (T)**, in the Sketch window: click to type a label where you
  click, Enter or Esc finishes, Shift+Enter adds a line, clicking away
  finishes (an empty new text leaves nothing behind). The editor is an
  inline box drawn exactly like the result. Click a text with the Text
  tool, or double-click it with Select, to edit it. Size (picked in
  screen px, stored in world units so it scales with the drawing), Bold,
  and a **box**: None / Box / Outlined, with a box colour: *Paper* (the
  canvas colour, so a label masks the lines behind it in both themes),
  light tints, or any colour; the outline is in the text colour.
  Properties edits the text, size, bold, box and box colour of the
  selected texts. Text is ink: the eraser removes it, the solver ignores it.
- **Style is always editable** (arrows and texts): draw or write first,
  then pick the style. A new arrow or text is selected as soon as it is
  made (a text even while you type: Bold, Box or a colour don't close the
  box), and the style controls (Sketch window, options bar, Colors)
  restyle the selected arrows and texts with the Select, Arrow or Text
  tool, and show their style. With the Arrow tool a click (no drag) on an
  arrow selects it; with the Text tool a click on a text edits it; with
  Select, the options bar shows the style of selected arrows or texts.
  A change also sets the style of the next one. Starting the next one or
  Esc deselects; Delete removes. Each restyle is one undo step.
- **Arrow (W)**, in the Sketch window: drag from where the arrow starts
  to what it points at (the head goes where you release; a click without
  a drag draws nothing; Shift keeps 15° steps; Esc cancels). Ends: tip
  only / both / none (a leader); Head: filled / open / dot; Line: solid /
  dashed; width in screen px stored in world units. With Snap on, each end
  snaps like a line end and, dropped on a point, line, circle or arc,
  **stays attached** to it: change a dimension and the tip keeps pointing
  at the hole while the tail stays put. A selected arrow shows two end
  handles to re-aim it (snapping and attaching the same way); dragging an
  end off its shape, or the whole arrow away, detaches it. Properties
  shows the style and what the arrow is attached to (Detach).
- **Resize and turn ink**: select strokes, arrows, texts or a group (no
  shapes) and a transform box appears. Corner handles resize keeping
  proportions (Shift: free), edge handles stretch one way (Shift: keep
  proportions), Alt resizes about the middle, the round handle above
  turns about the middle (Shift: 15° steps); a label shows the scale or
  angle, Esc cancels. Line widths and text sizes scale with the ink;
  texts turn but are never stretched or mirrored (a flip moves them,
  readable). Right-click: Rotate 90°, Flip horizontal, Flip vertical.
  A text's angle is also in Properties. One gesture = one undo step.
- **Group / link ink** (right-click a stroke or text, Properties, or the
  keyboard): **Group** (Ctrl+G) makes strokes and texts select and move
  as one; **Ungroup** (Ctrl+Shift+G). **Link to a shape…** then click a
  point, line, circle or arc (any visible layer; Esc cancels), or with
  ink selected right-click a shape → *Link selected … to this line*.
  Linked ink follows its geometry through solves, dimension and equation
  changes and drags: on a point it moves with the point; on a line it
  keeps its spot along the line (as a fraction) and turns with it (text
  letters stay upright); on a circle or arc it scales with the radius.
  Dragging linked ink re-places it and keeps the link; a selected linked
  item shows a dotted leader to the spot it follows; deleting the shape
  unlinks the ink and leaves it in place. Grouping ink where the linked
  members share one anchor links the whole group to it.
- **Images**: *Image…* in the Sketch window (or `I`), drop a file on the
  canvas, or paste one (Ctrl+V). PNG, JPEG, WebP or GIF, **less than 3 MB**
  (bigger files are refused with a message), and about 3.2 MB of pictures
  per sketch in total (a saved sketch stays under the 5 MB cloud limit);
  transparency is kept, the
  file is stored as imported, never re-encoded. The picture lands on the
  active layer at about half the view (where it was dropped, else in the
  middle), selected, so the transform box **resizes and turns** it right
  away (Shift on a corner stretches; Flip mirrors it). It is ink: select,
  move, group, opacity, layer, eraser and undo work as for strokes, and
  Properties edits its width and height (keep ratio). **Link to a shape…**
  makes it follow a point, a line (it slides, **turns and scales with the
  line's length**) or a circle / arc (scales with the radius). Saved in
  the project as `images: { id: data URL }`, once per picture
  (`core/images.js`); undo snapshots don't copy the data. If the
  browser's storage is full, the browser copy keeps the drawing without
  the pictures and says so: save the sketch to keep them.
- **Copy, cut and paste** (Ctrl+C / Ctrl+X / Ctrl+V, ⌘ on a Mac; also
  Copy / Cut on right-clicked ink and Paste on empty canvas): selected ink
  (texts, images, strokes, arrows, groups) is copied with its pictures, so
  it pastes in this sketch, another tab or another window, a little down
  and to the right of the original (further on each paste), or in the
  middle of the view when the original is out of sight. Pasted ink is
  selected, on the active layer, keeps its links to this drawing's shapes
  (arrow ends come detached) and is one undo step. Other apps get the
  texts' words as plain text, and a single copied image as a PNG. From
  other apps, Ctrl+V takes an image (same limits as importing) or plain
  text, which becomes a text label under the cursor in the current text
  style. Fields keep their usual copy and paste, and Ctrl with a letter
  never switches tools any more (Ctrl+C used to pick the Circle tool).
  Format: `core/ink-clipboard.js`.
- **Colors** window: one colour for Fill, Pen and Marker. Pick a swatch or
  click the chip for any colour. The opacity slider is the current tool's
  (Pen and Marker keep their own; other tools show the fill opacity). Shapes
  are never filled when drawn; the Fill tool (B, in the Sketch window) fills
  the area you click, using only the active layer's shapes (a region they
  close, or the background anywhere else); other layers are ignored. Its
  cursor is a paint drop in the colour, pointing at the click spot.

## Examples

`/app/?example=desk` opens `app/examples/desk.json`, the desk from the
landing page: dimensions, equations (`D2 = D1 / 2`, a mat at half the width),
a fixed hole, fills and ink, fully defined. The drawing that was open stays
one Undo away, and the parameter is removed from the URL. Examples are
generated by `scripts/build-examples.mjs`.

## Saving

The File group of the menu bar is **New · Open · Save**, with the save
status next to it: *Saved* / *Saving…* / *Not synced* / *Conflict* for a
sketch in the account, *Not saved* for a drawing only in this browser.

- **New** starts a fresh sketch; it only asks first when the current
  drawing isn't saved in the account.
- **Open** (Ctrl+O) lists the account's sketches with their previews;
  signed out it asks to sign in first, then shows the list. Links to
  My sketches and the library.
- **Save** (Ctrl+S) saves to the user's
account. Signed out, it asks to sign in ("Sign in to save your sketch")
and, once signed in, goes straight on to the save form (title and
description), also after a Google or email-link redirect (a flag in
sessionStorage). Signed in, it saves at once.

Independently, the editor keeps a silent copy of the drawing in the
browser (`localStorage`), written shortly after every change and when the
page is hidden or closed, and reopened on load, so a refresh never loses
work, signed in or not. Nothing in the UI calls this a save. With accounts disabled
(empty `app/src/cloud/config.js`), Save is the browser save as before.

## Dialogs and notices

The app never uses the browser's `confirm()`, `alert()` or `prompt()`.
`app/src/ui/dialogs.js` provides dialogs in the app's style (`choose`,
`confirmDialog`, `alertDialog`, `promptDialog`: Escape cancels, Enter
takes the default, focus stays inside, a destructive button is red and
never focused first) and `notice()`, a short message at the bottom that
fades away, for hints like "Select a line to mirror about". The e2e
tests fail if any browser pop-up appears.

## Touch, tablets and phones

Mouse input is handled exactly as on the desktop; touch and stylus input
goes through `app/src/app/touch.js` first:

- one finger: the current tool (a drag starts where the finger landed);
  long press = right-click menu; double tap on empty canvas = zoom to fit;
- two fingers: pan and pinch-zoom; two-finger tap = Undo, three = Redo;
- with a stylus, "Only the pencil draws": fingers pan and zoom only;
- finger hit tolerances are 2.5× the mouse ones (pen 1.5×);
- a loupe shows the area under the finger while placing or dragging points;
- after touch is used, the options bar adds Multi-select, Delete, nudge
  arrows and Done, and dimension values open a keypad (digits, units,
  operators, dimension names);
- no tap-through: the tap that makes a control appear under the finger
  (the Delete button after selecting, the keypad after tapping a
  dimension, a long-press menu) can't press it; only a press that starts
  on the control counts.

On a touch screen narrower than 700 px (or shorter than 500 px), the editor
switches to a phone layout (`compact.js`, styles under `.compact`): top bar
with Undo / Redo and a ⋯ menu, a bottom bar (Select, Draw ▸, Dimension,
Paint ▸, Panels ▸), windows as bottom sheets (one at a time, swipe down to
close), the options bar as chips, the status as a pill on the canvas; on its
side, the bottom bar becomes a rail. Tablets keep the desktop layout with
touch input. Plan and audit: `docs/mobile-plan.md`.

## Dimensions, units and equations

- On a slanted line (or two points, or two circle centres), Smart Dimension
  follows the cursor as in SolidWorks: place it above or below → horizontal
  distance (X), left or right → vertical distance (Y), beside the slant or off
  a corner → the true length. Horizontal and vertical lines always get their
  length. Saved as `distance` with `axis: 'x' | 'y'` (absent = aligned).

- Two **parallel lines** picked with Smart Dimension give the distance
  between them (two lines that cross give the angle). The dimension holds
  both ends of the second line at that distance from the first, so it also
  keeps them parallel; when they already are (horizontal sides, a
  rectangle, a Parallel relation) it holds one end only, so nothing is
  over-defined. Saved as `offsetDistance` with `sourceEntityId` /
  `targetEntityId`, like an Offset's distance.

- Typed dimension values take units: `4in`, `1.5"`, `2ft`, `35cm`, `25mm`,
  `30deg`, `0.5rad` (stored in mm and degrees). Arithmetic works: `1in + 4mm`.
- Every dimension is named (D1, D2, …). Start with `=` (or refer to a name) to
  keep an equation, as in SolidWorks: `=D1/2 + 5mm`, `=width*2`,
  `=sqrt(D3^2 + D4^2)`. Equations are re-evaluated before every solve, in
  dependency order; cycles and unknown names are flagged, not applied.
  Equations are global: when they change a value, every layer is solved, not
  just the active one.
- Editing a dimension shows its equation (Σ marks equation-driven labels).
- While a dimension's value box is open, click a line, circle or arc to
  insert its dimension name (`=D5`, or at the caret inside an equation). A
  shape without one gets a **floating** (driven, reference) dimension first.
  Floating dimensions re-measure the geometry on every render, solve and drag
  frame, so after `D1 = D5`, dragging that line resizes D1's shape live.
- In the Equations window, drag a plain value sideways to change it, as in
  Blender: the step fits the value's size, Shift is 10× finer, Ctrl snaps to
  round numbers, Esc restores, release is one undo step; a click edits the
  text. Values set by an equation, and floating dimensions, don't scrub.
- The Equations window (Σ in the menu bar) lists global variables and all
  dimensions: rename them (references follow), edit equations, see values.
  Usual precedence: `^`, then `*` `/`, then `+` `-`, left to right. A bad
  entry turns red; editing it clears the red, and once applied the window
  shows the new value at once (it rebuilds even while a field has focus).

## Solving and conflicts

- A solve that can't satisfy every constraint leaves the geometry as it was
  (per independent group) and reports the sketch as over-defined; it never
  applies a least-squares compromise that bends shapes or moves fixed points.
- Constraints created by snapping (while drawing, or when a dragged point is
  dropped on a target) are test-solved first. Ones that would conflict, that
  are already implied, or that tie a point to itself are not added; the status
  bar says why. A dropped point only connects to a target it actually reached.
- While dragging, a snap only pulls (and only shows) if the dragged point can
  actually land on it. A point that is held by its constraints (say, the end
  of a fixed-length arm) keeps following the cursor along the path it is
  allowed to take.
- Constraints that only involve geometry on layers not linked to the active
  one are left out of the solve until one of their layers is edited (a
  relation added from here between two other layers' shapes is applied to
  them right away).

## Layers

The active layer (highlighted in the Layers window) is the one you draw on,
drag and delete in. **Relations and dimensions work between layers exactly
as inside one layer:**

- **Pick across layers.** With Select, click a shape on any visible layer
  (the active layer's shapes and ink win when they overlap); Ctrl / Shift
  add to the selection, so a line on "Walls" and a line on "Furniture" can
  be made parallel, equal, coincident… from Properties. Smart Dimension
  picks shapes on any visible layer too. A shape of another layer is a
  reference here: Properties says which layer it is on, dragging or Delete
  don't touch it, and the status bar says so. **Double-click** it (or
  right-click → *Edit layer "…"*) to make its layer the active one.
- **Linked layers solve as one.** Layers tied by a relation or dimension
  (directly or through other layers) are solved together with the active
  one, so a dimension between them moves whichever side is free, as it
  would inside one layer; hold a side still with Fix or dimensions, as
  usual. The Layers window marks the layers linked to the active one (⛓,
  dashed outline). Layers not linked to it never move while you edit.
- **Hiding a layer hides its drawing, not its relations.** Its shapes,
  and every relation or dimension that touches it, are hidden and can't be
  picked, but they keep holding: change a dimension and the hidden layer
  still follows. Show it again and everything is where the constraints put
  it.
- A relation or dimension belongs to the active layer when it touches it,
  else to the layer of its shapes. It is drawn (and editable) from any
  layer it ties, grey from the others; Properties tags it "Base ↔ Work".
  Deleting a layer deletes its shapes and every relation on them.

Layers never share a point. Drawing from another layer's corner makes a new
point tied to it by a coincident relation (on the new layer), which links
the two layers; moving shapes to another layer (Properties → layer) takes
their own relations along and splits shared corners the same way; older
files are split on load. Deleting either side leaves the other where it was.
Layers have a name, visibility, opacity and order.

Right-click a line, circle or arc for **Set as construction** (or back to
normal geometry) and, on lines, **Create midpoint** (a point held at the
middle by a midpoint relation). With several shapes selected, the actions
apply to all of them.

Relations (coincident, horizontal, parallel, tangent, …) are shown as small
badges where they act (toggle: Relations / `K`); click one to select it and
Delete to remove it.

Status colours are per layer: each layer is checked as if it were the
active one (with its linked layers), so a fully defined layer stays black
while you work on another (for example after a global variable changed it).

## Source layout

| Path | Contents |
|---|---|
| `app/src/core/` | DOM-free model: math, entities, constraints, solver, sketch/project, layers and styles, regions (planar arrangement for fills) |
| `app/src/render/` | view transform, canvas renderer, themes |
| `app/src/editor/` | snap engine, selection-aware relation/dimension lists |
| `app/src/tools/` | select, draw tools, smart dimension, fill, freehand (pen, marker, eraser) |
| `app/src/app/` | `App` shell plus mixins grouped by concern (drag, solve, operations, chrome, panels, layers, fills, …) |
| `app/src/ui/` | icons, tool definitions, floating window manager |
| `app/styles.css` | UI styles; light and dark tokens on `:root` / `:root[data-theme="dark"]` |

## Data model

```
Project
├─ layers[]        bottom → top: name, opacity, visible (no colours)
├─ background      canvas colour from the fill tool, or null
├─ display         { grid, snap, dimensions, relations, dimNames } shown, or absent (older files)
└─ sketches[0]     the single parametric sketch
   ├─ entities[]   Point / Line / Circle / Arc, each with layerId and style
   │               (line weight, line type)
   ├─ constraints[]
   ├─ fills[]      fill-tool paint: colour, opacity, layer, a point inside the area
   └─ strokes[]    ink, in drawing order: pen / marker strokes (colour, opacity, width,
                   points), arrows (tail, tip, tips, head, dash, attached ends `at`:
                   point / line + t / circle + angle) and texts (text, size, bold,
                   angle, box {colour | 'paper', border}, top-left point); any item
                   may carry a group id and a link
                   { to: entity id, t: fraction along a line, f: anchor frame }
                   (`core/strokes.js`, `core/ink-links.js`)
```

New geometry takes the current line weight and type. Files from earlier
versions drop stroke colours, and shapes they filled through their style
become Fill-tool fills. Regions are
found on a planar arrangement of the geometry (segments split where they touch
or cross, overlaps merged), so shapes sharing or crossing edges fill correctly.
Two segments count as the same line when each one's ends lie within the
arrangement tolerance (1e-6) of the other's line, so a shared edge whose two
copies differ only by solver rounding is always one edge, never a crossing.
Fill-tool fills are paint on areas (like Live Paint): a colour plus a point
inside the area, on one layer. When that layer's shapes change, each current
area finds its colour by comparing with every area at the reference moment
(drag start / last commit), painted or not:
1. same bounding shapes → same colour (moved, resized, flipped; a hole stays
   a hole);
2. its outline contains a former area's whole outline plus new edges
   (crossing, cut, merge) → the candidate covering most of it (outlines, not
   holes: an island in one of its holes never stands in for the area);
3. at least half of it painted before → the colour covering most of it
   (split, re-cut);
4. mostly the same boundary by outline length → that colour (e.g. a bowtie
   lobe, or circles pulled apart);
otherwise it stays empty. Paint whose area no longer exists (opened up,
re-shaped away) is removed; Undo brings it back. During a drag nothing is
stored, so dragging back restores the colours exactly; the result is kept on
release (after the final solve) and can be undone. The scenarios live in
`tests/unit/fill-drag.test.js`; stability under solver noise (shared edges,
scrubbing a variable) in `tests/unit/fill-stability.test.js`.



The UI exposes layers only. `sketches` stays an array in the file format, but
files with several sketches are merged into one on load (pre-layer files get
one layer per former sketch).

Layers only affect display and editing. Constraints can link entities on
different layers (those layers then solve together), and hidden layers are
still solved. Project files are JSON
(`version: 3`); older files load onto a single default layer.

## Accounts and cloud projects

Optional sign-in (Google, or an emailed link / code) on Supabase. The
**Sign in** button at the right of the menu bar (⋯ menu on phones) opens
the sign-in dialog; signed in, it shows the avatar, which opens the
account menu: @username and email, plan, **My sketches**, **Library**,
**Public profile…**, **Sketch details…** (for the open sketch), **Sign out**.
The landing page and the library show the same account state through
`app/src/site/account.js`: *Sign in* when signed out (it comes back to
the page afterwards, `/app/?signin&back=<path>`), the avatar with a menu
(@username, My sketches, Library, Open the editor, Sign out) when signed
in. Signed-out visitors load nothing from Supabase: the widget looks for
the stored session first.

- **Save to my account** asks for a **title** (3–80 characters) and a
  **description** (10–500), with a preview; from then on every change is
  pushed a few seconds later (the button shows Saving… / Saved / Not
  synced) and the preview is refreshed at most every 30 s.
- **My sketches** (`/app/projects/`): the account's sketches as cards
  (preview, title, description, last change, Public / Private), a usage
  meter, and per card Open, Edit details, Duplicate, Download JSON,
  Delete. Open goes to `/app/?project=<id>`, New to `/app/?new`.
- **Plans**: free = 3 sketches, public (they will feed a public library);
  Premium (not on sale yet) = unlimited, may be private. Enforced in the
  database; the plan is in `account_plans`, written only by the service role.
- **Library** (`/library/`): every public sketch with a description,
  newest first, with search (title / description), sort, *Show more*, a
  detail view with a shareable link (`/library/?s=<id>`), *Copy link*,
  *Report* (Formspree) and *Open a copy in the editor* (`/app/?view=<id>`:
  a browser-only copy, the previous drawing one Undo away). Works signed out.
  Each sketch shows its **author**: the public **username** the user chose
  (3–24 letters, digits, _ . -, unique ignoring case, checked as they
  type; a few names reserved), or "OnSketch user" until they choose one;
  never the email or the Google name. The account picture appears only
  if they tick it. The editor asks for the username on first sign-in
  (*Later* skips it for the session) and always before a first save on
  the free plan, since saving publishes. A **👍 thumbs-up** button: one
  per signed-in user, not on your own sketches, counted publicly; sort by
  *Most liked*. My sketches shows the count on public cards. Tables
  `public_profiles`, `project_likes`, the view `library_sketches` and
  `username_available()` (migrations 0003–0004).
- **Public profiles**: `/library/?u=<username>` shows a user's picture
  (if shown), @username, About text (≤ 280), country (flag + name in the
  visitor's language), website (`rel="nofollow ugc noopener"`, http(s)
  only), join date, number of public sketches and thumbs-up received, and
  their public sketches (search and sort work inside). Authors on library
  cards link to it; the account menus have *Edit public profile…* and
  *View my public profile*. `public_profile()` (migration 0006) returns
  the profile with its counts; the trigger checks the new fields.
- Saves carry the revision they started from, so a save from a stale tab
  or device asks which version to keep instead of overwriting. Only the
  drawing moves the revision; title and description edits never conflict.
- New sketch, library copies and examples make a browser-only drawing; signing
  out keeps the drawing in the browser.

- **OnSketch Pro** ($9.99/month or $89/year, sold through Lemon Squeezy):
  unlimited sketches and private sketches. `/pricing/` compares the plans
  and starts the checkout; a Supabase Edge Function receives Lemon
  Squeezy's webhooks and sets the plan. Setup and design:
  `docs/pro-plan.md`; functions: `supabase/functions/`.

supabase-js is loaded from jsDelivr only once someone signs in. Schema,
rules and policies: `supabase/migrations/` (run in order); data layer and
details dialog: `app/src/cloud/`; editor UI: `app/src/app/cloud-ui.js`;
pages: `app/projects/` + `app/src/projects/page.js`, `library/` +
`app/src/library/page.js`; previews:
`app/src/render/thumbnail.js`. Plans: `docs/cloud-plan.md`,
`docs/projects-page-plan.md`. Emptying `app/src/cloud/config.js` turns all
of it off. `npm run test:cloud` drives it against a fake client
(`-- --live` adds signed-out checks on the real project).
