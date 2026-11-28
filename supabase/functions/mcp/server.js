// OnSketch MCP server: the protocol and the tools, with no I/O of its own.
//
// index.ts (the Edge Function) checks the caller's OAuth token, builds a
// `store` that reads and writes the caller's projects (row-level security
// applies: it holds the caller's token, never the service key), and hands
// each JSON-RPC message to handleMessage(). Tests pass a fake store.
//
// Streamable HTTP, stateless: every POST carries one message and gets one
// JSON answer (no SSE stream, no session id). Enough for tools.
//
// The modules under ./_app/ are copies of app/src/ made by
// scripts/build-mcp.mjs (the Edge Function can only ship files in its own
// folder). Edit app/src/, never ./_app/.
import { buildFromSpec, projectToSpec, SpecError, cleanTitle, SHAPE_TYPES, CONSTRAINT_TYPES } from './_app/core/spec.js';
import { DRAWING_TYPES, LINE_STYLE_IDS } from './_app/core/spec-drawing.js';
import { SHAPE_IDS, SHAPE_FILLS } from './_app/core/shapes.js';
import { ARROW_HEADS, ARROW_TIPS } from './_app/core/arrows.js';
import { Project } from './_app/core/model.js';
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from './_app/core/images.js';
import { exportSVG } from './_app/render/export.js';
import { toDXF } from './_app/core/dxf.js';

export const SERVER_INFO = { name: 'onsketch', title: 'OnSketch', version: '1.0.0' };
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const FORMAT = `OnSketch sketch format (the "spec").
Coordinates are numbers in the sketch's units (default mm), x to the right, y UP (math axes, not screen axes). Angles in degrees.

An OnSketch sketch has two sides, and a good sketch uses both, tied together:
- CAD ("shapes" + "constraints"): the exact geometry, in black lines, with dimensions the user can edit (parts, outlines, holes, mechanisms, plans). Make it parametric where it helps: variables and formulas, so one number resizes the design.
- Drawing ("drawing", "fills", "layers"): what makes it read like a drawing: colour fills, labels, callouts, arrows, highlights, pictures, hand-drawn strokes, motion paths. Attach it to the CAD ("link", arrow ends on shapes, fills inside outlines) so it moves when a dimension changes.
Don't fake drawing with CAD lines (no lettering or arrowheads built from lines, no hatching to show colour) and don't put real geometry in the drawing side.

{
  "units": "mm",                                  // optional: mm, cm, m, km, in, ft, mi
  "variables": { "W": 80, "H": "W / 2" },         // optional: named values and formulas (see Parametric)
  "points": { "A": [0, 0], "B": [40, 0] },        // optional named points
  "shapes": [ ... ],                              // required: CAD geometry (and mirror / pattern operations)
  "constraints": [ ... ],                         // optional: relations and dimensions the solver keeps true
  "layers": ["Part", "Notes"],                    // optional: layer names, bottom to top (or { "name", "visible", "opacity" })
  "fills": [ ... ],                               // optional: colour inside closed CAD outlines
  "drawing": [ ... ],                             // optional: text, arrows, ink, shapes, pictures, traced paths; drawn in this order
  "background": "#f7f3ea",                        // optional: canvas colour
  "display": { "names": true }                    // optional: what the editor shows: "grid", "snap", "dimensions", "relations", "names" (dimension names), true / false
}

Points. Wherever a point is expected (P) you can give a name ("A"), a point of a shape ("plate.tl", "hole.center", "l1.end") or plain coordinates [x, y]. Plain coordinates join any point already at that place, so a closed outline is just shapes that meet. Each named point is its own point (two names at one place are two points).

Shapes (each may have "id": a name like "plate" or "hole_1", "construction": true for guide geometry, "layer", "line_style" (${LINE_STYLE_IDS.join(', ')}) and "weight" (line width in screen px, default 1.4). CAD lines are always black (their colour shows constraint state in the editor): colour comes from fills and the drawing side):
- line:      { "type": "line", "from": P, "to": P }                                 points: id.start, id.end
- polyline:  { "type": "polyline", "points": [P, P, ...], "closed": true }           segments: id.s1, id.s2… (s1 runs from point 1 to 2); points: id.p1, id.p2…
- rectangle: { "type": "rectangle", "corner": [x, y], "width": w, "height": h }      bottom-left corner; sides id.bottom, id.right, id.top, id.left; corners id.bl, id.br, id.tr, id.tl; comes with horizontal / vertical sides
- circle:    { "type": "circle", "center": P, "r": 5 }   (or "d": 10)                point: id.center
- arc:       { "type": "arc", "center": P, "from": P, "to": P }   counter-clockwise from "from" to "to" (add "clockwise": true for the other way); both ends must be at the same distance from the centre.
             or { "type": "arc", "center": P, "r": 5, "start_angle": 0, "end_angle": 90 }     points: id.center, id.start, id.end
- curve:     { "type": "curve", "points": [P, P, P, ...], "closed": true }   a smooth curve through the points (Bézier segments id.s1, id.s2…, smooth where they meet; "smooth": false for corners); points id.p1…
             or one Bézier: { "type": "curve", "from": P, "to": P, "c1": [x, y], "c2": [x, y] }   (c1 / c2: handles; "curve.c1" / "curve.c2" name them in "symmetric" and "fix")
- polygon:   { "type": "polygon", "center": P, "sides": 6, "r": 10 (centre to corner) or "side": 10, "angle": 90 (first corner's direction) }   regular, as the Polygon tool makes it: sides id.s1…, corners id.p1…, construction circle id.circle (dimension its radius to size it)
- point:     { "type": "point", "at": P }                                            the id names the point
Operations (they make shapes, kept in step with the originals):
- mirror:    { "type": "mirror", "id": "m", "of": [shape or group ids], "axis": line }   copies mirrored about the line, tied by symmetry (change the original, the copy follows); copies are "m.<original id>" (e.g. "m.wall", "m.wall.start"). Points on the axis are shared, so a half outline mirrored is a closed outline.
- pattern:   { "type": "pattern", "kind": "linear", "of": [ids], "count": 4, "spacing": 10, "angle": 0 (or "along": line), "count2": 2, "spacing2": 8, "angle2": 90 (or "along2") }   rows and columns of copies (count includes the original)
             { "type": "pattern", "kind": "circular", "of": [ids], "center": P, "count": 6, "total_angle": 360 }   copies round a point (360: evenly all round; less: spread over that angle)
             { "type": "pattern", "kind": "points", "of": [ids], "origin": P, "targets": [P, ...] }   a copy at each target (the origin lands on it)
             Copies follow the originals and can't be named: dimension the originals. Counts, spacings and angles may be formulas ("W / 5").
A group id (rectangle, polyline, curve path, polygon, mirror) stands for all its shapes in "of".

Constraints (a, b are shape ids unless said; P is a point):
- horizontal / vertical:        { "line": id }  or  { "a": P, "b": P } (two points level / aligned)
- parallel, perpendicular, collinear: { "a": line, "b": line }
- equal:        { "a", "b" }  two lines (same length) or two circles / arcs (same radius)
- concentric:   { "a", "b" }  circles / arcs
- tangent:      { "a", "b" }  line + circle/arc, two circles/arcs ("internal": true for one inside the other), or a curve's end + a line / circle / arc ("at": "start" | "end", else the end that touches it)
- smooth:       { "point": P }  two curves meeting at P without a kink
- coincident:   { "a": P, "b": P }   (usually unneeded: reuse the point instead)
- midpoint:     { "point": P, "line": id }
- on:           { "point": P, "shape": line, circle/arc or curve }
- symmetric:    { "a": P, "b": P, "axis": line }
- fix:          { "point": P }   holds the point where it is;  { "shape": circle/arc, "param": "r" | "start_angle" | "end_angle" } holds that value
- offset:       { "a": source, "b": its copy, "value": 3 }  or  { "pairs": [[source, copy], ...], "value": 3 }   copies kept parallel (lines) / concentric (circles, arcs) at one distance (draw the copies yourself, at that distance)
Dimensions ("value": a number, or a formula; "name": a name for formulas to use; "reference": true makes it measure only: shown, not enforced, "value" may be left out):
- distance:     { "a": P, "b": P, "value": 12, "axis": "x" | "y" (optional: horizontal / vertical distance) }   point to line: { "a": P, "b": line, "value": 12 }   two circles/arcs: { "a", "b", "value", "mode": "gap" (between them, default) | "radial" (radius of a minus radius of b) }
- length:       { "line": id, "value": 40 }
- radius / diameter: { "shape": circle or arc, "value": 5 }
- angle:        { "a": line, "b": line, "value": 30 }   degrees between the lines as drawn (0–180). "a" / "b" may also be two points [P, P] (the direction from the first to the second). "signed": true: the angle counter-clockwise from a to b (-180–180).

Parametric. "variables": { "name": number | "formula" | { "value": 80, "slider": true | { "min", "max", "step" } } }. Formulas use + - * / ^ ( ), numbers with units ("10 mm", "2in", "30deg"), sqrt, abs, round, floor, ceil, min, max, pi, sin, cos, tan, asin, acos, atan (in degrees), and variable and dimension names. A dimension's "value" may be a formula ("W / 2"); naming a dimension ("name": "width") lets others refer to it. Dimensions without a name get D1, D2…. "slider" puts a slider for the variable on the drawing: dragging it resizes the design live (great for mechanisms and adjustable parts). Lengths are in the sketch's units, angles in degrees.

Fills: { "at": [x, y], "color": "#cfe3ff", "opacity": 0.35, "layer": "Part" }
  Colours the closed area of CAD shapes (lines, arcs, circles, curves on that layer, construction excluded) around the point "at"; areas with holes inside keep the holes. The colour follows the area when dimensions change. "at" must be inside a closed outline.

Drawing items (all take "color" "#rrggbb" (default black), "opacity" 0–1, "layer", "group" (a name: items with the same group move together), and except arrows and traces "link"):
- text:   { "type": "text", "text": "Ø10 through", "at": P, "size": 4, "align": "center" | "left" | "right", "bold": true, "angle": 0, "box": true | "#fff3b0", "border": true }
          "at" is the middle of the text (or its left / right end with "align"); "size" is the letter height in drawing units; "box" puts the text on an opaque label (true: canvas colour) so it stays readable over lines and fills. Multi-line text: "\\n". "{width}" in a text shows that variable's or dimension's value, live ("{width:1}": one decimal; any formula works).
- arrow:  { "type": "arrow", "from": END, "to": END, "width": 0.5, "head": ${ARROW_HEADS.map(h => `"${h}"`).join(' | ')}, "tips": ${ARROW_TIPS.map(h => `"${h}"`).join(' | ')} (which ends get a head; default "end"), "dash": true }
          END is [x, y] (free), a point name (attached to that point), { "on": line, "t": 0..1 } (attached at that fraction along the line) or { "on": circle or arc, "angle": degrees } (attached at that angle on it). Attached ends follow the geometry.
- pen / marker: { "type": "pen", "points": [[x, y], ...], "width": 0.4, "dash": true }   freehand ink; marker is a wide translucent highlighter.
- shape:  { "type": "shape", "shape": ${SHAPE_IDS.map(h => `"${h}"`).join(' | ')}, "center": P, "width": 20, "height": 12, "angle": 0, "fill": ${SHAPE_FILLS.map(h => `"${h}"`).join(' | ')}, "outline": 0.4, "dash": true }
          ready-made drawing shapes (callout is a speech bubble): for highlights, icons, frames, title blocks. Not CAD: no dimensions.
- image:  { "type": "image", "src": "https://…/photo.jpg", "center": P, "width": 40, "height": 30 (default: the picture's proportions), "angle": 0 }
          a picture (PNG, JPEG, WebP, GIF; from a public https link or a data URL; 3 MB at most). Pictures already in a sketch read back as "image:<id>": send that back to keep one.
- trace:  { "type": "trace", "point": P, "width": 0.4, "dash": true }   the path a point of a mechanism can travel (the rest of the sketch moving as its constraints allow): a crank's end draws a circle, a slider a line, a linkage point its coupler curve. The point needs exactly one way to move (fix the frame; leave one degree of freedom). Kept up to date by the editor.
"link": a CAD shape id (line, circle, arc) or a point name: the item follows it. On a point it moves with the point; on a line it keeps its spot along the line and turns with it ({ "to": line, "t": 0..1 } picks the spot); on a circle or arc it moves with the centre and scales with the radius (a ring drawn around a hole grows with it).
Sizes and widths are in drawing units; leave them out for sizes matched to the drawing.

How to draw well:
1. Draw at the real size with correct coordinates: the solver only fine-tunes. Constraints are optional; add the dimensions that matter (overall size, hole sizes and positions) so the user can edit them later.
2. Don't repeat a constraint another already implies (a rectangle's sides are already horizontal / vertical; "equal" plus two equal "length"s is one too many): repeated constraints are refused.
3. A closed outline (so it can be filled) is shapes whose ends meet: reuse points or the exact same coordinates.
4. "fix" one point (for example the bottom-left corner) and dimension the rest for a fully defined sketch. For a mechanism, fix the frame and leave the moving parts their freedom.
5. Use the right tool: mirror for symmetric parts, patterns for repeated holes or teeth, polygons for nuts, curves for organic shapes, variables (with a slider) for the sizes a user will want to change.
6. Label and explain with the drawing side: name parts with text linked to them, point at features with arrows attached to them, colour areas with fills, put notes on their own layer.
7. If a call is refused, read the problems: each names the shape, constraint or drawing item (by position) to fix. Check the result with export_sketch (SVG) when it matters.

Example (a 60 × 30 mm plate with rounded right end and a 6 mm hole, filled, with a linked label and an arrow on the hole):
{ "points": { "a": [0,0], "b": [45,0], "c": [45,30], "d": [0,30] },
  "shapes": [
    { "id": "bottom", "type": "line", "from": "a", "to": "b" },
    { "id": "end", "type": "arc", "center": [45,15], "from": "b", "to": "c" },
    { "id": "top", "type": "line", "from": "c", "to": "d" },
    { "id": "left", "type": "line", "from": "d", "to": "a" },
    { "id": "hole", "type": "circle", "center": [15,15], "d": 6 } ],
  "constraints": [
    { "type": "horizontal", "line": "bottom" }, { "type": "horizontal", "line": "top" }, { "type": "vertical", "line": "left" },
    { "type": "tangent", "a": "bottom", "b": "end" }, { "type": "tangent", "a": "top", "b": "end" },
    { "type": "length", "line": "bottom", "value": 45 }, { "type": "length", "line": "left", "value": 30 },
    { "type": "diameter", "shape": "hole", "value": 6 }, { "type": "fix", "point": "a" },
    { "type": "distance", "a": "a", "b": "hole.center", "axis": "x", "value": 15 },
    { "type": "distance", "a": "a", "b": "hole.center", "axis": "y", "value": 15 } ],
  "layers": ["Part", "Notes"],
  "fills": [ { "at": [35, 15], "color": "#cfe3ff" } ],
  "drawing": [
    { "type": "text", "text": "Ø6 through", "at": [15, 40], "size": 3, "box": true, "link": "hole", "layer": "Notes" },
    { "type": "arrow", "from": [15, 37], "to": { "on": "hole", "angle": 90 }, "color": "#d63a3a", "layer": "Notes" },
    { "type": "text", "text": "MOUNTING PLATE", "at": [30, -6], "size": 3.5, "bold": true, "link": "bottom", "layer": "Notes" } ] }`;

export const INSTRUCTIONS = `OnSketch is a parametric 2D sketcher (onsketch.io). These tools draw sketches in the user's OnSketch account and give back a link where they can open and edit them (drag, change dimensions, export to SVG, PNG, PDF or DXF).
Use create_sketch for a new drawing, update_sketch to change one (read it first with get_sketch), list_sketches to find one. Always give the user the link from the result.
${FORMAT}`;

const pointSchema = { description: 'A point: a name, a shape point like "plate.tl", or [x, y].', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] };
const numOrFormula = { anyOf: [{ type: 'number' }, { type: 'string', description: 'a formula, e.g. "W / 2"' }] };
const refSchema = { description: 'A point (name or [x, y]), a shape id, or (angle) two points [P, P].', anyOf: [{ type: 'string' }, { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] }, minItems: 2, maxItems: 2 }] };
const arrowEndSchema = { description: 'An arrow end: [x, y], a point name, { "on": line, "t" } or { "on": circle/arc, "angle" }.', anyOf: [
  { type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
  { type: 'object', properties: { on: { type: 'string' }, t: { type: 'number' }, angle: { type: 'number' } }, required: ['on'] }] };
const SPEC_SCHEMA = {
  type: 'object',
  description: 'The drawing, in the OnSketch sketch format described in the tool description.',
  properties: {
    units: { type: 'string', enum: ['mm', 'cm', 'm', 'km', 'in', 'ft', 'mi'] },
    points: { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    shapes: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['type'],
        properties: {
          type: { type: 'string', enum: SHAPE_TYPES }, id: { type: 'string' }, construction: { type: 'boolean' },
          from: pointSchema, to: pointSchema, center: pointSchema, at: pointSchema,
          points: { type: 'array', items: pointSchema }, closed: { type: 'boolean' },
          corner: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, width: { type: 'number' }, height: { type: 'number' },
          r: { type: 'number' }, d: { type: 'number' }, start_angle: { type: 'number' }, end_angle: { type: 'number' }, clockwise: { type: 'boolean' },
          layer: { type: 'string' }, line_style: { type: 'string', enum: LINE_STYLE_IDS }, weight: { type: 'number' },
          c1: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, c2: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          smooth: { type: 'boolean' }, sides: { type: 'integer' }, side: { type: 'number' }, angle: numOrFormula,
          of: { type: 'array', items: { type: 'string' } }, axis: { type: 'string' },
          kind: { type: 'string', enum: ['linear', 'circular', 'points'] },
          count: numOrFormula, spacing: numOrFormula, along: { type: 'string' }, count2: numOrFormula, spacing2: numOrFormula, angle2: numOrFormula, along2: { type: 'string' },
          total_angle: numOrFormula, origin: pointSchema, targets: { type: 'array', items: pointSchema },
        },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object', required: ['type'],
        properties: {
          type: { type: 'string', enum: CONSTRAINT_TYPES },
          a: refSchema, b: refSchema, point: pointSchema,
          line: { type: 'string' }, shape: { type: 'string' }, axis: { type: 'string', description: 'For symmetric: the axis line id. For distance: "x" or "y".' },
          value: numOrFormula, internal: { type: 'boolean' }, signed: { type: 'boolean' },
          mode: { type: 'string', enum: ['gap', 'radial'] }, at: { type: 'string', enum: ['start', 'end'] },
          param: { type: 'string', enum: ['r', 'start_angle', 'end_angle'] },
          pairs: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
          name: { type: 'string' }, reference: { type: 'boolean' },
        },
      },
    },
    variables: { type: 'object', description: 'name → number, formula, or { "value", "slider" }.', additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'object', properties: { value: numOrFormula, slider: { anyOf: [{ type: 'boolean' }, { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' } } }] } }, required: ['value'] }] } },
    display: { type: 'object', properties: { grid: { type: 'boolean' }, snap: { type: 'boolean' }, dimensions: { type: 'boolean' }, relations: { type: 'boolean' }, names: { type: 'boolean' } } },
    layers: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, visible: { type: 'boolean' }, opacity: { type: 'number' } }, required: ['name'] }] } },
    background: { type: 'string', description: 'Canvas colour, "#rrggbb".' },
    fills: {
      type: 'array',
      items: { type: 'object', required: ['at'], properties: { at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, color: { type: 'string' }, opacity: { type: 'number' }, layer: { type: 'string' } } },
    },
    drawing: {
      type: 'array',
      items: {
        type: 'object', required: ['type'],
        properties: {
          type: { type: 'string', enum: DRAWING_TYPES },
          text: { type: 'string' }, at: pointSchema, center: pointSchema, size: { type: 'number' },
          align: { type: 'string', enum: ['center', 'left', 'right'] }, bold: { type: 'boolean' }, angle: { type: 'number' },
          box: { anyOf: [{ type: 'boolean' }, { type: 'string' }] }, border: { type: 'boolean' },
          from: arrowEndSchema, to: arrowEndSchema, head: { type: 'string', enum: ARROW_HEADS }, tips: { type: 'string', enum: ARROW_TIPS },
          points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
          shape: { type: 'string', enum: SHAPE_IDS }, width: { type: 'number' }, height: { type: 'number' },
          fill: { type: 'string', enum: SHAPE_FILLS }, outline: { type: 'number' }, dash: { type: 'boolean' },
          color: { type: 'string' }, opacity: { type: 'number' }, layer: { type: 'string' }, group: { type: 'string' },
          link: { anyOf: [{ type: 'string' }, { type: 'object', properties: { to: { type: 'string' }, t: { type: 'number' } }, required: ['to'] }] },
          src: { type: 'string', description: 'image: https link, data URL, or "image:<id>".' }, point: pointSchema,
        },
      },
    },
  },
  required: ['shapes'],
};

export const TOOLS = [
  {
    name: 'create_sketch',
    title: 'Create a sketch',
    description: `Draws a new 2D sketch in the user's OnSketch account and returns a link to open and edit it. Use it whenever the user wants something drawn: a part, a plan, a layout, a diagram with real sizes.\n\nVisibility: on the free plan sketches are public (listed in the OnSketch library); private sketches need OnSketch Pro. Leave "visibility" out to get private when the user's plan allows it; if the result says the sketch would be public, ask the user before calling again with "visibility": "public".\n\n${FORMAT}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title shown in OnSketch, 3 to 80 characters.' },
        description: { type: 'string', description: 'One or two sentences on what the sketch shows, 10 to 500 characters.' },
        visibility: { type: 'string', enum: ['private', 'public'], description: 'Leave out unless the user chose.' },
        spec: SPEC_SCHEMA,
      },
      required: ['title', 'description', 'spec'],
    },
    annotations: { title: 'Create a sketch', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_sketch',
    title: 'Change a sketch',
    description: 'Replaces the drawing of one of the user\'s sketches with a new spec (same format as create_sketch). Read it with get_sketch first, change what the user asked, keep the rest (ids, points, constraints), and send the whole spec back with the revision get_sketch gave. The previous drawing stays in the sketch\'s version history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The sketch id (from create_sketch, list_sketches or the link).' },
        revision: { type: 'integer', description: 'The revision get_sketch returned; refused if the sketch changed since.' },
        spec: SPEC_SCHEMA,
      },
      required: ['id', 'revision', 'spec'],
    },
    annotations: { title: 'Change a sketch', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_sketch',
    title: 'Read a sketch',
    description: 'Reads one of the user\'s sketches (or a public one) as a spec in the create_sketch format, with its revision and link. Use before update_sketch.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The sketch id, or its OnSketch link.' } },
      required: ['id'],
    },
    annotations: { title: 'Read a sketch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'export_sketch',
    title: 'Export a sketch',
    description: 'Exports one of the user\'s sketches (or a public one) as an SVG picture (to look at the result, or to give the user) or as DXF text (for CAD and laser cutters, at real size). SVG leaves out pictures; "dimensions": true draws the dimensions too.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The sketch id, or its OnSketch link.' },
        format: { type: 'string', enum: ['svg', 'dxf'] },
        dimensions: { type: 'boolean', description: 'SVG: draw the dimensions.' },
      },
      required: ['id'],
    },
    annotations: { title: 'Export a sketch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_sketches',
    title: 'List my sketches',
    description: 'Lists the user\'s OnSketch sketches, most recently changed first, with their ids and links.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List my sketches', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Something to tell the assistant (shown as a tool error it can act on). */
class ToolProblem extends Error {}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The tools, bound to one caller.
 * store: { plan(), list(), load(id), create(json, details), save(id, json, revision) }
 *   (the methods of app/src/cloud/cloud.js's Cloud).
 */
/** Downloads the https pictures of a spec's drawing and puts them in as
 *  data URLs (the sketch format only takes those). */
export async function inlineImages(spec, fetchImage = globalThis.fetch) {
  const items = Array.isArray(spec?.drawing) ? spec.drawing : [];
  if (!items.some(it => it?.type === 'image' && typeof it.src === 'string' && /^https?:/i.test(it.src))) return spec;
  const drawing = [];
  for (const [i, it] of items.entries()) {
    if (!(it?.type === 'image' && typeof it.src === 'string' && /^https?:/i.test(it.src))) { drawing.push(it); continue; }
    const where = `drawing[${i}] (image)`;
    let url;
    try { url = new URL(it.src); } catch { throw new ToolProblem(`${where}: "${it.src}" isn't a link.`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || /^(localhost|.*\.local|.*\.internal)$/.test(host) || /^[\d.]+$|:/.test(host)) {
      throw new ToolProblem(`${where}: pictures are downloaded from public https links only.`);
    }
    let res;
    try { res = await fetchImage(url.href, { redirect: 'follow', signal: AbortSignal.timeout?.(10000) }); }
    catch { throw new ToolProblem(`${where}: couldn't download ${url.href}.`); }
    if (!res.ok) throw new ToolProblem(`${where}: ${url.href} answered ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > IMAGE_MAX_BYTES) throw new ToolProblem(`${where}: the picture is over ${IMAGE_MAX_BYTES / 1048576} MB.`);
    const sniff = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : bytes[0] === 0x47 && bytes[1] === 0x49 ? 'image/gif' : bytes[8] === 0x57 && bytes[9] === 0x45 ? 'image/webp' : null;
    const type = sniff || String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
    if (!IMAGE_TYPES.includes(type)) throw new ToolProblem(`${where}: ${url.href} isn't a PNG, JPEG, WebP or GIF picture (SVG isn't accepted).`);
    let bin = '';
    for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    drawing.push({ ...it, src: `data:${type};base64,${btoa(bin)}` });
  }
  return { ...spec, drawing };
}

export function createTools(store, { appUrl = 'https://onsketch.io', fetchImage = globalThis.fetch } = {}) {
  const link = (id) => `${appUrl}/app/?project=${encodeURIComponent(id)}`;
  const idOf = (v) => {
    const m = typeof v === 'string' && v.match(UUID);
    if (!m) throw new ToolProblem('"id" must be a sketch id (a UUID) or an OnSketch link containing one.');
    return m[0].toLowerCase();
  };
  const build = async (spec, title, images = null) => {
    spec = await inlineImages(spec, fetchImage);
    try { return buildFromSpec(spec, { title, images }); }
    catch (e) {
      if (e instanceof SpecError) throw new ToolProblem(`The sketch could not be drawn. Fix these and call again:\n- ${e.problems.join('\n- ')}`);
      throw e;
    }
  };
  const summary = (report) => {
    const extra = [report.drawing ? `${report.drawing} drawing item${report.drawing === 1 ? '' : 's'}` : '', report.fills ? `${report.fills} fill${report.fills === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    const lines = [`${report.shapes} shape${report.shapes === 1 ? '' : 's'}, ${report.constraints} constraint${report.constraints === 1 ? '' : 's'}${extra ? `, ${extra}` : ''}; ${report.state === 'fully' ? 'fully defined' : `${report.dof} degree${report.dof === 1 ? '' : 's'} of freedom left`}.`];
    for (const w of report.warnings) if (!/degrees? of freedom left/.test(w)) lines.push(`Note: ${w}`);
    return lines.join('\n');
  };
  const dbProblem = (e) => {
    if (e?.name === 'LimitError') return new ToolProblem(`${e.message} The user can delete a sketch at ${appUrl}/app/projects/ or upgrade at ${appUrl}/pricing/.`);
    if (e?.name === 'ConflictError') return new ToolProblem('The sketch changed since it was read (the user may have edited it). Call get_sketch again, re-apply the change, and send the new revision.');
    if (/OnSketch: |at least|at most|Pro/.test(e?.message || '')) return new ToolProblem(e.message);
    return e;
  };

  return {
    async create_sketch({ title, description, visibility, spec }) {
      const name = cleanTitle(title);
      const desc = String(description ?? '').replace(/\s+/g, ' ').trim();
      if (name.length < 3) throw new ToolProblem('"title" needs at least 3 characters.');
      if (desc.length < 10 || desc.length > 500) throw new ToolProblem('"description" must be 10 to 500 characters.');
      if (visibility != null && visibility !== 'private' && visibility !== 'public') throw new ToolProblem('"visibility" is "private" or "public".');
      const { project, report } = await build(spec, name);
      const plan = await store.plan();
      if (plan.limit != null) {
        const rows = await store.list();
        if (rows.length >= plan.limit) throw new ToolProblem(`The user's free plan holds ${plan.limit} sketches and is full. They can delete one at ${appUrl}/app/projects/ or get OnSketch Pro (no limit, private sketches) at ${appUrl}/pricing/.`);
      }
      let vis = visibility;
      if (!vis) {
        if (!plan.canPrivate) throw new ToolProblem(`Not saved yet: on the user's free plan every sketch is public (anyone can see it in the OnSketch library). Ask the user whether that is fine; if so, call create_sketch again with "visibility": "public". Private sketches need OnSketch Pro (${appUrl}/pricing/).`);
        vis = 'private';
      }
      if (vis === 'private' && !plan.canPrivate) throw new ToolProblem(`Private sketches need OnSketch Pro (${appUrl}/pricing/). Ask the user whether a public sketch is fine.`);
      let row;
      try { row = await store.create(project.toJSON(), { name, description: desc, visibility: vis }); }
      catch (e) { throw dbProblem(e); }
      const url = link(row.id);
      return {
        text: `Saved "${name}" (${vis}) to the user's OnSketch account.\nOpen and edit: ${url}\n${summary(report)}`,
        data: { id: row.id, url, revision: row.revision, visibility: vis, state: report.state, dof: report.dof, warnings: report.warnings },
      };
    },

    async update_sketch({ id, revision, spec }) {
      const pid = idOf(id);
      if (!Number.isInteger(revision)) throw new ToolProblem('"revision" is the integer get_sketch returned.');
      let row;
      try { row = await store.load(pid); } catch { throw new ToolProblem('No sketch with this id in the user\'s account.'); }
      if (row.owner_id && store.userId && row.owner_id !== store.userId) throw new ToolProblem('This sketch belongs to someone else; it can be read but not changed. Use create_sketch to make the user their own.');
      const current = Project.fromJSON(row.data);
      const { lossless, unsupported } = projectToSpec(current);
      if (!lossless) throw new ToolProblem(`This sketch holds things the sketch format can't carry (${unsupported.join(', ')}); replacing it would lose them. Make the change in OnSketch (${link(pid)}), or create a new sketch.`);
      const old = row.data || {};
      const { project, report } = await build(spec, row.name, old.images || null);
      // Keep what the spec left out: units, display, the editor's tool sizes.
      const json = project.toJSON();
      if (spec.units == null && old.units) json.units = old.units;
      if (spec.display == null && old.display) json.display = old.display;
      if (old.sizes) json.sizes = { ...json.sizes, ...old.sizes };
      if (old.remixedFrom) json.remixedFrom = old.remixedFrom;
      let saved;
      try { saved = await store.save(pid, json, revision); }
      catch (e) { throw dbProblem(e); }
      return {
        text: `Updated "${row.name}".\nOpen and edit: ${link(pid)}\n${summary(report)}`,
        data: { id: pid, url: link(pid), revision: saved.revision, state: report.state, dof: report.dof, warnings: report.warnings },
      };
    },

    async get_sketch({ id }) {
      const pid = idOf(id);
      let row;
      try { row = await store.load(pid); } catch { throw new ToolProblem('No sketch with this id that the user can see.'); }
      const project = Project.fromJSON(row.data);
      const { spec, lossless, unsupported } = projectToSpec(project);
      const own = !row.owner_id || !store.userId || row.owner_id === store.userId;
      const notes = [];
      if (!own) notes.push('This is someone else\'s public sketch: it can be read, not changed.');
      if (!lossless) notes.push(`It also holds ${unsupported.join(', ')}, which the format leaves out: it can't be changed with update_sketch.`);
      const data = { id: pid, title: row.name, description: row.description ?? null, visibility: row.visibility, revision: row.revision, url: link(pid), editable: own && lossless, spec };
      return {
        text: `"${row.name}" (revision ${row.revision}, ${row.visibility}): ${link(pid)}\n${notes.join('\n')}${notes.length ? '\n' : ''}${JSON.stringify(spec)}`,
        data,
      };
    },

    async export_sketch({ id, format = 'svg', dimensions = false }) {
      const pid = idOf(id);
      if (format !== 'svg' && format !== 'dxf') throw new ToolProblem('"format" is "svg" or "dxf".');
      let row;
      try { row = await store.load(pid); } catch { throw new ToolProblem('No sketch with this id that the user can see.'); }
      const project = Project.fromJSON(row.data);
      project.name = row.name || project.name;
      if (format === 'dxf') {
        const { text, count } = toDXF(project);
        return { text, data: { id: pid, format, shapes: count, url: link(pid) } };
      }
      const svg = exportSVG({ project }, { dimensions: !!dimensions });
      if (!svg) throw new ToolProblem('This sketch is empty: nothing to export.');
      return { text: svg, data: { id: pid, format, url: link(pid) } };
    },

    async list_sketches() {
      const rows = await store.list();
      const items = rows.map(r => ({ id: r.id, title: r.name, visibility: r.visibility, updated_at: r.updated_at, url: link(r.id) }));
      return {
        text: items.length ? items.map(i => `- ${i.title} (${i.visibility}, changed ${i.updated_at}): ${i.url}  [id ${i.id}]`).join('\n') : 'The user has no sketches yet.',
        data: { sketches: items },
      };
    },
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * One JSON-RPC message → its answer, or null for a notification.
 * `tools` comes from createTools (null when the caller isn't signed in:
 * index.ts answers 401 before that, so this is only a safeguard).
 */
export async function handleMessage(msg, tools, { log = () => {} } = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;
  if (isNotification) return null;            // notifications/initialized, cancelled…: nothing to answer
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (!TOOLS.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      if (!tools) return rpcError(id, -32001, 'Sign in to OnSketch first.');
      try {
        const out = await tools[name](params.arguments || {});
        return rpcResult(id, { content: [{ type: 'text', text: out.text }], structuredContent: out.data, isError: false });
      } catch (e) {
        if (e instanceof ToolProblem) return rpcResult(id, { content: [{ type: 'text', text: e.message }], isError: true });
        log('tool failed', name, e);
        return rpcResult(id, { content: [{ type: 'text', text: 'OnSketch had a problem saving or reading the sketch. Try again in a moment.' }], isError: true });
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
