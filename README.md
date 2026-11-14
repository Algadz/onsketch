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
npm run test:layers  # layers as display only: editing, relations and dimensions across layers, hiding
npm run test:nosnap  # Alt = no snap while placing or dragging; Space-drag pans
npm run test:pattern # linear / circular / point patterns: picks, linked copies, editing, equations, unlink
npm run test:export  # Export (PNG, SVG, copy, DXF, print to scale) and the first-run steps, desktop and phone
node tests/style.e2e.mjs  # restyling arrows / texts after drawing, touch tap-through guard
node tests/analytics.e2e.mjs  # Umami events: what is counted, once per visit, nothing sent from tests
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
  Select (Mirror, Offset and the patterns are in the Tools window); step-by-step help for
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

The File group of the menu bar is **New · Open · Save · Export**, with the save
status next to it: *Saved* / *Saving…* / *Not synced* / *Conflict* for a
sketch in the account, *Not saved* for a drawing only in this browser.

- **New** starts a fresh sketch; it only asks first when the current
  drawing isn't saved in the account.
- **Open** (Ctrl+O) lists the account's sketches with their previews;
  signed out it asks to sign in first, then shows the list. Links to
  My sketches and the library. **Insert**, next to each sketch, places
  it inside the open drawing as a part (see *Parts* below).
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

## Export

**Export** (menu bar, ⋯ on phones) shows the drawing as it will come out
and offers, with *Dimensions* (starts as on screen), *Construction lines*
and *Transparent background* as options:

All formats are free, on every plan.

- **Copy image**, **PNG** (2×), **SVG**: for slides, documents and
  messages. Shapes are drawn in ink (no state colours, no end-point
  dots, no grid, relations or selection), with fills, ink, text, arrows
  and pictures, on the canvas colour or white.
- **DXF** and **Print / PDF** to scale, for making things. DXF holds the shapes
  (lines, circles, arcs, points) in millimetres at real size, on layers
  named after the drawing's, construction geometry on its own layer when
  included. Print / PDF lays the drawing on one A4, A3 or Letter sheet at
  a true scale (Auto picks the largest of 1:1, 1:2, 1:5, 1:10… that fits)
  with the name, the scale and a check length; the browser's print
  dialog prints it or saves it as a PDF.

The exported picture comes from the same renderer as the screen: SVG is
produced by a drawing context that writes SVG instead of pixels
(`render/svg-context.js`), so there is no second drawing code. Code:
`render/export.js`, `core/dxf.js`, `app/export.js`.

## Parts: a sketch inside another

A saved sketch can be placed inside the open one at real size, as a part
drawn once and reused (a connector, a standard component, a desk):
**Open ▸ Insert** for your own sketches, **Insert into my sketch** in the
library (`/app/?insert=<id>`). It lands in the middle of the view,
selected, and one Undo removes it. On the way in (`core/insert.js`):

- every id is renewed; dimension names (D1…) and variables already taken
  are renamed and the part's equations rewritten to match;
- its layers arrive as new layers named after the sketch, so the part can
  be hidden, restyled or deleted as a whole and its fills keep their areas;
- Fix relations are dropped (a part saved at the origin would be stuck
  there); its own relations and dimensions stay, so it keeps its shape and
  can be dragged or dimensioned against the drawing around it.

## First run

A first visit on an empty canvas shows three steps in a small card:
*Draw a rectangle*, *Give it a size*, *Colour it*. Each has a button that
picks the tool and ticks itself when the drawing shows it was done. Clicks
and drags go through the card; × hides it for good. It is not shown with
a saved drawing, an example or a library sketch, and never twice
(`app/guide.js`). The same code counts activation for everyone, once per
browser: a first shape, dimension and fill made in a drawing that had none.

## Analytics (Umami)

Every page loads Umami (no cookies). Besides page views, `src/ui/analytics.js`
sends anonymous events: an event name and a few short labels, never drawing
content, typed text or emails. "Once" = at most once per page load, so heavy
use doesn't flood the counts. Nothing is sent from localhost or automated
browsers.

| Where | Event | Data |
|---|---|---|
| Editor | `sketch-new` | |
| | `sketch-save` | `to` (account / browser), `signed_in`, `linked` |
| | `sketch-saved-account` | `first`, `plan`, `visibility` (first save to the account) |
| | `sketch-open` | `from` (account / library / example), `example` |
| | `open-dialog` | |
| | `signin-prompt` | `reason` (save / open / like / pricing) |
| | `signin-start`, `signin-done`, `signin-failed` | `method` (google / email / email-code / link) |
| | `signout`, `profile-saved` (`first`) | |
| | `tool` (once) | `name` |
| | `window` (once) | `name` (equations, layers, props…) |
| | `dimension`, `relation` (once) | `kind` |
| | `equation-used`, `undo`, `copy`, `cut` (once) | |
| | `relation-refused` (once) | `kind`, `reason` (conflict / implied) |
| | `pattern` (once) | `type` (linear / circular / points), `linked` |
| | `pattern-edit` (once) | `type` |
| | `paste` (once) | `what` (ink / image / text) |
| | `image-import` (once) | `via` (picker / drop) |
| | `theme` | `to` |
| | `touch-used` | `input` (touch / pen), `layout` (phone / large) |
| | `report-open`, `report-sent` | `attached`, `with_email` |
| | `nav` | `to` (library / my-sketches) |
| | `upgrade-click`, `billing-open` | `from` |
| | `export-open`; `export` | `format` (png / svg / copy / dxf / print), `dimensions`, `construction` |
| | `sketch-insert` | `from` (account / library) |
| | `guide` | `step` (shown / shape / dimension / fill / done / skipped / example) |
| | `activation` (once per browser per step) | `step` (shape / dimension / fill), `guided` |
| | `activated` (once per browser) | `guided` (all three steps reached) |
| Library | `library-view`, `library-open-copy`, `library-insert` | `id` (public sketch) |
| | `library-like` | `on` |
| | `library-search`, `library-more` (once), `library-sort` (`sort`), `library-copy-link`, `library-report`, `library-profile` | |
| My sketches | `project-action` | `action` (open, details, duplicate, download, delete, public, private…) |
| Pricing | `pricing-interval` | `interval` |
| | `checkout-start` | `interval`, `resumed` |
| | `pro-activated` | |
| Landing | `landing-cta` | `where` (header / hero / demo-desk / bottom) |
| | `landing-nav` | `to`; `landing-see-examples` |
| All pages | `error` (≤ 5) | `page`, `message`, `where` (file:line) |

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
  Equations are global, like everything else the solver does.
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

## Snapping and navigation (desktop)

- With **Snap** on, points snap to ends, midpoints, centres, lines,
  circles and the grid while you draw or drag, and a snap becomes a
  relation (coincident, on line…); the Line tool also makes a nearly flat
  or upright line horizontal / vertical.
- **Hold Alt (⌥ Option on a Mac) to place without snapping**, while
  drawing or dragging: no snap marker, no relation from a snap, no
  horizontal / vertical guess; the point goes exactly under the cursor.
  It takes effect the moment you press or release it, even without moving
  the mouse: the cursor says *no snap* and the Snap button dims. The
  options bar of the drawing tools and of Select says so. Arrow ends
  dropped with Alt stay unattached.
- **Pan**: hold **Space** and drag (grab cursor), or drag with the middle
  button. **Zoom**: the wheel. (Alt-drag used to pan; Alt now means no
  snap.) On touch screens: two fingers, see below.

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

## Layers

**Layers are for display only.** They group shapes, ink and fills for
visibility, opacity and drawing order, and the active layer (highlighted
in the Layers window) is where new shapes, ink and fills go. Relations,
dimensions, the solver and editing ignore them: the drawing behaves
exactly as if it were one layer.

- **Any visible shape** can be hovered, clicked, box-selected, dragged,
  deleted, related and dimensioned, whatever the active layer; where
  shapes overlap, the active layer's win. Properties shows a shape's layer
  and moves it to another (*Layer*).
- **Relations and dimensions between layers** are like any other: a line
  on "Walls" and a line on "Furniture" can be parallel, equal or 2 m apart,
  and changing that dimension moves whichever side is free. They are shown
  and editable whatever the active layer; Properties tags them
  "Walls ↔ Furniture".
- **Shapes on different layers can share a corner**: drawing from another
  layer's corner joins it, as on one layer. Deleting a shape keeps a corner
  another shape still uses.
- **Hiding a layer hides its drawing, not its relations.** Its shapes, and
  every relation or dimension on them, are hidden and can't be picked or
  snapped to, but they keep holding: change a dimension and the hidden
  layer still follows.
- Deleting a layer deletes its shapes, ink and fills, and the relations
  and dimensions on those shapes.
- Ink (pen, marker, text, arrows, images) and the Fill tool still work on
  the active layer, like painting in Paint.NET.

Layers have a name, visibility, opacity and order.

## Patterns

Three buttons under Mirror and Offset in the Tools window (on a phone, at
the end of Draw ▸) repeat the selected shapes, as in SolidWorks:

- **Linear pattern**: *Instances* (the seed counts as one), *Spacing* and
  an *Angle*, or **Line…** to follow a line's direction (the copies turn
  when the line turns); ⇄ reverses. *Direction 2* (switch) makes a grid.
- **Circular pattern**: pick the **centre** (a point, a circle or arc for
  its centre, or empty canvas: a new point is made there), *Instances*,
  *Total angle* with *Equal spacing* (360° shares a full turn; less puts
  the last copy at the end), or the *Step angle* without it; CCW / CW.
  Arcs turn with their copies.
- **Point pattern** ("sketch-driven"): the **origin** (a point of the
  seed, by default its first corner or centre) lands on each **target**:
  click points, box-select many, or click empty canvas for new ones;
  click a target again (or ×) to remove it.

The operation runs with the Select tool and its panel is in Properties:
a type switch (while creating), what canvas clicks pick (seed shapes,
centre, origin, targets, direction line), the parameters, **Keep linked**
and Create / Cancel; a dashed preview shows the copies, the centre, the
targets and the directions. Enter creates, Esc cancels. Fields take units
and arithmetic (`1in`, `30/2`); a field starting with `=` or naming a
dimension or variable keeps an **equation** (`=D1*2`, `=pitch`), so the
pattern follows when D1 changes (counts too, `=floor(D3/D4)`). Arrow keys
step a value. At most 200 copies per pattern (every copy is solved).

**Keep linked** (on by default; the last choice is remembered for the
visit):
- *on*: a **pattern relation** (▦ badge on the seed) ties every copy to
  its seed through the transform. The solver keeps them together: drag or
  dimension the seed, the centre, a target or the direction line and the
  copies follow; drag or resize a copy and the seed (so all of them)
  moves. Copies add no degrees of freedom. Selecting a copy shows a
  pattern card in Properties (**Edit**); right-click → *Edit … pattern…*;
  the relation itself offers Edit pattern, **Unlink** and **Delete copies**.
  **Edit** reopens the panel and applies every change at once (copies keep
  their ids, so relations, fills and ink on them survive a new spacing or
  count); **Done** is one undo step, **Cancel** / Esc / Ctrl+Z put it all
  back. Deleting a copy leaves that instance out from then on; deleting a
  centre, origin, target or direction line freezes it where it was;
  deleting the seed ends the pattern. Deleting the relation = Unlink.
- *off*, or **Unlink** later: plain copies that carry the seed's own
  relations (horizontal, coincident, equal…; not dimensions or Fix), each
  edited on its own. Spots clicked on empty canvas don't become points.

Saved as a `pattern` constraint: `{ type, params, seeds, instances:
[{ key, pairs: [[seedId, copyId, 'p' | 'r' | 'a' | 'e']] }], skipped }`
(`core/patterns.js`, UI in `app/patterns.js`).

Right-click a line, circle or arc for **Set as construction** (or back to
normal geometry) and, on lines, **Create midpoint** (a point held at the
middle by a midpoint relation). With several shapes selected, the actions
apply to all of them.

Relations (coincident, horizontal, parallel, tangent, …) are shown as small
badges where they act (toggle: Relations / `K`); click one to select it and
Delete to remove it.

Status colours (under, fully, over-defined) are for the whole drawing:
layers don't change them.

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
   ├─ constraints[] relations, dimensions, linked patterns (`core/patterns.js`)
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

Layers only affect display (and where new shapes go). Constraints link
entities on any layers, shapes on different layers can share points, and
hidden layers are still solved. Project files are JSON
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
- **Plans**: free = 3 sketches; Pro = unlimited. Every export is free.
  Free sketches are public only until migration
  `0007_free_private.sql` is run, private or public after it: the app asks
  the database which rule applies (`plan_rules()`), so the two always
  agree. Where there is a choice, a new sketch starts private and a
  username is asked for only when publishing. Enforced in the database;
  the plan is in `account_plans`, written only by the service role.
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
  unlimited sketches (and private sketches, where the free plan is
  public only). `/pricing/` compares the plans
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
