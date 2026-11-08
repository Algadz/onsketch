# Sketch tools: gap analysis and plan

OnSketch's pitch is "Paint, but to scale". The CAD half (constraints,
dimensions, equations, solver, layers, area fills) is mature. The Paint
half is thin: before the Sketch window, the only expressive tool was the
Fill bucket. To present a concept, people also need to **annotate,
label, mark up and decorate** what they drew, and then get it out of
the tool.

## What was missing

| Need when presenting a concept | Before | Status |
|---|---|---|
| Freehand ink: circle a detail, sketch an idea quickly | none | **Phase 1, shipped** (Pen) |
| Highlighting | none | **Phase 1, shipped** (Marker) |
| Removing ink without touching geometry | none | **Phase 1, shipped** (Eraser) |
| Ink colour separate from geometry status colour | lines always show constraint state | **Phase 1, shipped** (ink colour) |
| Move / recolour / delete a stroke | none | **Shipped** (Select tool) |
| Text labels ("Kitchen", "Ø 40 bore", titles) | none | Phase 2 |
| Arrows, leaders and callouts | none | Phase 2 |
| Annotation that follows the geometry when a dimension changes | none | Phase 3 |
| Reference image (photo, plan, screenshot) scaled to real size | none | Phase 3 |
| Presentation view: clean lines without vertices, state colours or grid | none | Phase 4 |
| Image export (PNG / SVG / PDF) | JSON only | Phase 4 |
| Hatches, patterns, gradients (grass, wood, concrete, copper) | flat colour only | Phase 4 |
| Reusable symbols (furniture, trees, parts) | none | Phase 4 |
| Freehand → CAD: turn a rough stroke into a constrained line / arc / circle | none | Phase 5 |

## Principles: ink vs. geometry vs. layers

OnSketch has two kinds of content. Each sits in one layer list, but
they behave differently.

| | **Geometry** (Tools window) | **Ink and annotations** (Sketch window) |
|---|---|---|
| What it is | points, lines, arcs, circles | strokes, highlights; later text, arrows, images |
| Solver | constrained, dimensioned, equations | never solved, never dimensioned |
| Line colour | shows state (blue, black, red, pink) | its own ink colour, always |
| Snapping | snaps and is snapped to | does not snap and is not a snap target (phase 1) |
| Fill tool | closes areas | ignored: ink never closes an area |
| Layer | belongs to one layer | belongs to one layer |
| Editable when | its layer is active | its layer is active |
| Draw order in a layer | fills, then geometry | on top of the layer's geometry |
| Undo, autosave, JSON | yes | yes |
| Units | world (mm) | world (mm): ink scales with zoom like ink on paper |

**Why mixed layers instead of special "paint layers"?** A layer is a
display group (visibility, opacity, order), not a content type. Keeping
one kind of layer means:
- **No modes to learn.** Draw a room on "Furniture", circle the sofa on
  the same layer, and both hide together.
- **Fewer rules.** No "you can't draw a line on a paint layer" errors.
- **Order stays the user's choice.** Put ink on its own "Notes" layer
  above everything, or under a translucent layer.

The convention to document in the UI hints: *put markup on its own
layer when you want to hide it for a clean view.* A future phase can add
a layer flag `markup` that the presentation view or export can switch
off in one click.

**Why vector, not pixels?** Ink stays sharp at any zoom, exports to SVG,
is a few bytes in undo and autosave, and can later be selected, moved,
recoloured and anchored to geometry. Pixel painting would make all of
that hard and would not fit "to scale".

## Phase 1 (shipped): Sketch window

- **Sketch window** (pencil icon in the menu bar), next to Tools by default:
  Pen, Marker, Eraser, ink colour (palette + picker), size and opacity for
  the current tool. The options bar mirrors size, opacity and colour.
- **Pen (N)**: freehand stroke, round caps, smoothed through the
  sample midpoints, simplified with Ramer–Douglas–Peucker at about
  0.35 screen pixels. Uses coalesced pointer events for smooth fast strokes.
- **Marker (G)**: wide (18 px default) see-through ink (40%). Drawn as one
  path, so it doesn't darken where it crosses itself.
- **Eraser (E)**: drag over strokes to remove whole strokes on the active
  layer. Geometry and fills are untouched. One drag is one undo step.
- **Sizes** are picked in screen pixels and stored in world units, so the
  stroke looks as drawn at the current zoom and then scales with the
  drawing.
- **Ink colour** `#111418` is theme ink: black on light, white on dark,
  like geometry.
- **Data model**: `sketch.strokes[]` =
  `{ id, layerId, kind: 'pen'|'marker', color, opacity, width, pts: [x0, y0, …] }`
  (`app/src/core/strokes.js`). Deleting a layer deletes its strokes;
  Layers counts include them.

## Phase 2: edit ink, text and arrows

1. **Select ink with the Select tool.** *Shipped:* click / Ctrl / Shift /
   box select on the active layer, drag to move (with selected shapes too),
   Delete, Properties for colour, opacity, width and layer, dashed orange
   box as the selection mark. *Still to do:* scale / rotate handles.
2. **Text tool (T).** Click to place, type, Enter to finish. Text height in
   world units (default 1/40 of the view) or "screen size" for titles.
   Options: font size, bold, colour (ink), background pill (none,
   panel, ink colour). Double-click to edit. Stored as
   `{ kind: 'text', at, text, size, color, align, bg }` in `sketch.notes[]`.
3. **Arrow / leader tool (W).** Drag from the target to the label point;
   options: arrowhead (none, open, filled, dot), line type, ink colour.
   A leader can carry a text label at its tail (callout).
4. **Straight segments in Pen.** Shift-click continues the stroke with a
   straight segment (as in Paint), Shift-drag constrains to 15°.
5. **Partial eraser** (option in the eraser): cut strokes where the eraser
   passes instead of removing them whole.
6. **Pressure.** Use `PointerEvent.pressure` for pen input (Apple Pencil,
   Wacom): per-point width, stored as an optional `w` list.

## Phase 3: annotations that follow the design

This mirrors what fills already do (paint follows areas) and is the
feature no drawing app has.

1. **Anchoring.** An arrow tip, a text label or a whole stroke can be
   pinned to geometry: to a point, to a line at parameter *t*, or to a
   region (fill seed). Stored in the anchor's local frame (origin and
   direction of the line or the point), so when a dimension changes and
   the solver moves the geometry, the annotation moves with it. Dropping
   an arrow tip on geometry shows the usual snap marker and anchors it.
   Deleting the anchor leaves the annotation where it was (unanchored).
2. **Linked labels.** Text can contain a field: `{D3}`, `{area}`,
   `{width}`, so a label like "Kitchen {area}" updates when the room
   changes. Reuses the equation names and parser (`core/expr.js`).
3. **Reference image.** Import a PNG or JPG (or paste) onto a layer.
   *Calibrate*: click two points on the image and type the real distance;
   the image is scaled to world units. Options: opacity, lock, crop.
   Useful to trace a floor plan, a photo of a part, or a hand sketch.
   Stored as an asset (data URL in the project for now).

## Phase 4: make it presentable and get it out

1. **Presentation view** (toggle `P` in View):
   - hides vertices, relation badges, grid, construction geometry,
     constraint state colours and selection;
   - draws geometry in a per-entity **line colour** (new style key, used
     only in this view; editing keeps the state colours);
   - shows dimensions in a cleaner style (thin, ink colour);
   - optional: hides layers flagged `markup`.
2. **Export.** PNG (1x, 2x, 4x), SVG (vector: fills, geometry, ink, text)
   and PDF at a chosen **paper scale** (1:20, 1:50, 1:100) with a scale
   bar. Exports what the presentation view shows; the selection, or the
   whole drawing.
3. **Patterns and gradients** for the Fill tool: hatch (lines at angle and
   spacing in world units), cross-hatch, dots, brick, wood grain, grass,
   plus a linear gradient. Hatch spacing in mm keeps patterns to scale.
4. **Symbols.** Save a selection (geometry, fills, ink) as a symbol; place
   it with a stamp tool; edit one, update all. A small starter library:
   furniture (bed, sofa, table, chair), plants, doors and windows, PCB
   footprints, people for scale.

## Phase 5: from sketch to CAD

**Shape recognition** ("tidy up"): select a freehand stroke and convert
it into geometry. A nearly straight stroke becomes a line, a closed round
one a circle, an open curve an arc, a corner path a polyline, each with
the obvious relations (horizontal, vertical, tangent). The user sketches
freely, then makes it exact with dimensions. That bridges the two halves
of the product and is the strongest story for "Paint, but to scale".

## Open questions

- **Keyboard:** N, G and E are used now; T (text) and W (arrow) are planned.
  Is P better kept for Point or moved to the presentation view?
- **Ink with Snap on:** should a stroke's ends snap to geometry so a hand
  arrow touches the edge exactly? Probably only for arrows and leaders
  (phase 2), not freehand.
- **Strokes and fills:** should a closed freehand loop be fillable? Not by
  the Fill tool (keeps the rule simple); tidy-up (phase 5) is the way.
- **Size of projects with images:** move images out of the project JSON
  into separate storage once there are cloud saves.
