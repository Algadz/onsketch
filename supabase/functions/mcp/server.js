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
import { Project } from './_app/core/model.js';

export const SERVER_INFO = { name: 'onsketch', title: 'OnSketch', version: '1.0.0' };
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const FORMAT = `OnSketch sketch format (the "spec").
Coordinates are numbers in the sketch's units (default mm), x to the right, y UP (math axes, not screen axes). Angles in degrees.

{
  "units": "mm",                                  // optional: mm, cm, m, km, in, ft, mi
  "points": { "A": [0, 0], "B": [40, 0] },        // optional named points, shared by every shape that uses the name
  "shapes": [ ... ],                              // required
  "constraints": [ ... ]                          // optional: relations and dimensions the solver keeps true
}

Wherever a point is expected you can give a name ("A"), a point of a shape ("plate.tl", "hole.center", "l1.end") or plain coordinates [x, y]. Ends at the same coordinates join automatically, so a closed outline is just shapes that meet.

Shapes (each may have "id": a name like "plate" or "hole_1", and "construction": true for guide geometry):
- line:      { "type": "line", "from": P, "to": P }                                 points: id.start, id.end
- polyline:  { "type": "polyline", "points": [P, P, ...], "closed": true }           segments: id.s1, id.s2… (s1 runs from point 1 to 2); points: id.p1, id.p2…
- rectangle: { "type": "rectangle", "corner": [x, y], "width": w, "height": h }      bottom-left corner; sides id.bottom, id.right, id.top, id.left; corners id.bl, id.br, id.tr, id.tl; comes with horizontal / vertical sides
- circle:    { "type": "circle", "center": P, "r": 5 }   (or "d": 10)                point: id.center
- arc:       { "type": "arc", "center": P, "from": P, "to": P }   counter-clockwise from "from" to "to" (add "clockwise": true for the other way); both ends must be at the same distance from the centre.
             or { "type": "arc", "center": P, "r": 5, "start_angle": 0, "end_angle": 90 }     points: id.center, id.start, id.end
- point:     { "type": "point", "at": P }                                            the id names the point

Constraints (a, b are shape ids unless said; P is a point):
- horizontal / vertical:        { "line": id }  or  { "a": P, "b": P } (two points level / aligned)
- parallel, perpendicular, collinear: { "a": line, "b": line }
- equal:        { "a", "b" }  two lines (same length) or two circles / arcs (same radius)
- concentric:   { "a", "b" }  circles / arcs
- tangent:      { "a", "b" }  line + circle/arc, or two circles/arcs ("internal": true for one inside the other)
- coincident:   { "a": P, "b": P }   (usually unneeded: reuse the point instead)
- midpoint:     { "point": P, "line": id }
- on:           { "point": P, "shape": line or circle/arc }
- symmetric:    { "a": P, "b": P, "axis": line }
- fix:          { "point": P }   holds the point where it is
- distance:     { "a": P, "b": P, "value": 12, "axis": "x" | "y" (optional: horizontal / vertical distance) }   or point to line: { "a": P, "b": line, "value": 12 }
- length:       { "line": id, "value": 40 }
- radius / diameter: { "shape": circle or arc, "value": 5 }
- angle:        { "a": line, "b": line, "value": 30 }   degrees between the lines as drawn (0–180)

How to draw well:
1. Draw at the real size with correct coordinates: the solver only fine-tunes. Constraints are optional; add the dimensions that matter (overall size, hole sizes and positions) so the user can edit them later.
2. Don't repeat a constraint another already implies (a rectangle's sides are already horizontal / vertical; "equal" plus two equal "length"s is one too many): repeated constraints are refused.
3. A closed outline (so it can be filled) is shapes whose ends meet: reuse points or the exact same coordinates.
4. "fix" one point (for example the bottom-left corner) and dimension the rest for a fully defined sketch. Not required.
5. If a call is refused, read the problems: each names the shape or constraint (by position) to fix.

Example (a 60 × 30 mm plate with rounded right end and a 6 mm hole):
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
    { "type": "distance", "a": "a", "b": "hole.center", "axis": "y", "value": 15 } ] }`;

export const INSTRUCTIONS = `OnSketch is a parametric 2D sketcher (onsketch.io). These tools draw sketches in the user's OnSketch account and give back a link where they can open and edit them (drag, change dimensions, export to SVG, PNG, PDF or DXF).
Use create_sketch for a new drawing, update_sketch to change one (read it first with get_sketch), list_sketches to find one. Always give the user the link from the result.
${FORMAT}`;

const pointSchema = { description: 'A point: a name, a shape point like "plate.tl", or [x, y].', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] };
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
        },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object', required: ['type'],
        properties: {
          type: { type: 'string', enum: CONSTRAINT_TYPES },
          a: pointSchema, b: pointSchema, point: pointSchema,
          line: { type: 'string' }, shape: { type: 'string' }, axis: { type: 'string', description: 'For symmetric: the axis line id. For distance: "x" or "y".' },
          value: { type: 'number' }, internal: { type: 'boolean' },
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
export function createTools(store, { appUrl = 'https://onsketch.io' } = {}) {
  const link = (id) => `${appUrl}/app/?project=${encodeURIComponent(id)}`;
  const idOf = (v) => {
    const m = typeof v === 'string' && v.match(UUID);
    if (!m) throw new ToolProblem('"id" must be a sketch id (a UUID) or an OnSketch link containing one.');
    return m[0].toLowerCase();
  };
  const build = (spec, title) => {
    try { return buildFromSpec(spec, { title }); }
    catch (e) {
      if (e instanceof SpecError) throw new ToolProblem(`The sketch could not be drawn. Fix these and call again:\n- ${e.problems.join('\n- ')}`);
      throw e;
    }
  };
  const summary = (report) => {
    const lines = [`${report.shapes} shape${report.shapes === 1 ? '' : 's'}, ${report.constraints} constraint${report.constraints === 1 ? '' : 's'}; ${report.state === 'fully' ? 'fully defined' : `${report.dof} degree${report.dof === 1 ? '' : 's'} of freedom left`}.`];
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
      const { project, report } = build(spec, name);
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
      const { project, report } = build(spec, row.name);
      // Keep what the format doesn't describe: units unless changed, display, sizes.
      const json = project.toJSON();
      const old = row.data || {};
      if (spec.units == null && old.units) json.units = old.units;
      if (old.display) json.display = old.display;
      if (old.sizes) json.sizes = old.sizes;
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
