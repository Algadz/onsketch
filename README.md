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
npm run lint
npm run stamp        # after changing anything in app/: refresh cache-busting hashes
```

`app/index.html` carries an import map that points every module at
`file.js?v=<content hash>`, so browsers never mix a fresh page with stale
cached modules after a deploy. `npm test` fails if the stamp is out of date.

## Interface

- **Menu bar**: file and edit actions, project name, view toggles (grid, snap,
  dimensions `M`, zoom, theme) and toggles for each window.
- **Options bar** (second row): settings for the active tool, as in Paint.NET.
  Line weight, line type and construction while drawing; Mirror, Offset,
  *Apply line style* and *Pick line style* with Select; step-by-step help for
  Smart Dimension; Fill / Erase and the cursor design for the Fill tool.
- **Floating windows** over the canvas, dragged by their title bar and
  remembered per browser: Tools, Colors, Layers, Properties (selection,
  relations, dimensions), Equations. *Reset window layout* puts them back.
- **Line colour always shows state**, as in SolidWorks: blue under-defined,
  black fully defined, red over-defined, pink construction, orange selected.
- **Colors** window: the Fill tool's colour and opacity. Shapes are never
  filled when drawn; the Fill tool (B) fills the area you click (a closed
  region, or the background anywhere else). Its cursor shows the fill colour;
  pick Bucket, Crosshair or Drop in the options bar.

## Dimensions, units and equations

- Typed dimension values take units: `4in`, `1.5"`, `2ft`, `35cm`, `25mm`,
  `30deg`, `0.5rad` (stored in mm and degrees). Arithmetic works: `1in + 4mm`.
- Every dimension is named (D1, D2, …). Start with `=` (or refer to a name) to
  keep an equation, as in SolidWorks: `=D1/2 + 5mm`, `=width*2`,
  `=sqrt(D3^2 + D4^2)`. Equations are re-evaluated before every solve, in
  dependency order; cycles and unknown names are flagged, not applied.
- Editing a dimension shows its equation (Σ marks equation-driven labels).
- The Equations window (Σ in the menu bar) lists global variables and all
  dimensions: rename them (references follow), edit equations, see values.

## Layers

Picking only sees the active layer. A locked layer never moves (the solver
holds its geometry still), its row is marked in amber, its vertices are grey,
and while it is active a banner offers to unlock it; drawing on it is blocked.

## Source layout

| Path | Contents |
|---|---|
| `app/src/core/` | DOM-free model: math, entities, constraints, solver, sketch/project, layers and styles, regions (planar arrangement for fills) |
| `app/src/render/` | view transform, canvas renderer, themes |
| `app/src/editor/` | snap engine, selection-aware relation/dimension lists |
| `app/src/tools/` | select, draw tools, smart dimension |
| `app/src/app/` | `App` shell plus mixins grouped by concern (drag, solve, operations, chrome, panels, layers, fills, …) |
| `app/src/ui/` | icons, tool definitions, floating window manager |
| `app/styles.css` | UI styles; light and dark tokens on `:root` / `:root[data-theme="dark"]` |

## Data model

```
Project
├─ layers[]        bottom → top: name, opacity, visible, locked (no colours)
├─ background      canvas colour from the fill tool, or null
└─ sketches[0]     the single parametric sketch
   ├─ entities[]   Point / Line / Circle / Arc, each with layerId and style
   │               (line weight, line type)
   ├─ constraints[]
   └─ fills[]      fill-tool regions: colour, boundary entity ids, a point inside
```

New geometry takes the current line weight and type. Files from earlier
versions drop stroke colours, and shapes they filled through their style
become Fill-tool fills. Regions are
found on a planar arrangement of the geometry (segments split where they touch
or cross, overlaps merged), so shapes sharing or crossing edges fill correctly.
A fill-tool fill is re-found each time from its boundary entities around its
inside point, so it follows the geometry.



The UI exposes layers only. `sketches` stays an array in the file format, but
files with several sketches are merged into one on load (pre-layer files get
one layer per former sketch).

Layers only affect display and picking. Constraints can link entities on
different layers, and hidden layers are still solved. Project files are JSON
(`version: 3`); older files load onto a single default layer.
