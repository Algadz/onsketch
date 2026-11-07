# OnSketch

Browser-based parametric 2D sketcher: SolidWorks-style geometric constraints
and dimensions, with Paint.NET-style layers, colours and a fill tool.

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
  dimensions `M`, status colours, zoom, theme) and toggles for each window.
- **Options bar** (second row): settings for the active tool, as in Paint.NET.
  Line weight, line type, outline / outline + fill and construction while
  drawing; Mirror, Offset, *Apply drawing style* and *Pick style* with Select;
  step-by-step help for Smart Dimension; Fill / Erase for the Fill tool.
- **Floating windows** over the canvas, dragged by their title bar and
  remembered per browser: Tools, Colors, Layers, Properties (selection,
  relations, dimensions). *Reset window layout* puts them back.
- **Colors**: primary (stroke) and secondary (fill) colour. Left-click a
  swatch for stroke, right-click for fill. They apply to the next shapes and
  the Fill tool only; existing geometry changes only through *Apply drawing
  style*.

## Source layout

| Path | Contents |
|---|---|
| `app/src/core/` | DOM-free model: math, entities, constraints, solver, sketch/project, layers and styles |
| `app/src/render/` | view transform, canvas renderer, themes, closed-profile detection for fills |
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
   │               (stroke colour, weight, line type, optional fill)
   ├─ constraints[]
   └─ fills[]      fill-tool regions: colour + boundary entity ids (outer, holes)
```

New geometry takes the current drawing style (Style panel, saved per
browser). Fill-tool regions store their boundary entities, so they follow the
geometry; deleting a boundary edge removes the fill.

Picking only sees the active layer. Locked layers never move: the solver
treats their geometry as constant.

The UI exposes layers only. `sketches` stays an array in the file format, but
files with several sketches are merged into one on load (pre-layer files get
one layer per former sketch).

Layers only affect display and picking. Constraints can link entities on
different layers, and hidden layers are still solved. Project files are JSON
(`version: 3`); older files load onto a single default layer.
