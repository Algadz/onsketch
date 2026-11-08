# Mobile: audit and plan

> **Status (8 Nov 2026):** phases 0 to 3 and the landing fixes are done
> (`app/src/app/touch.js`, `touch-ui.js`, `compact.js`; checks in
> `tests/mobile.e2e.mjs`, `npm run test:mobile`). Desktop is unchanged:
> touch behaviour only reacts to touch / pen pointer events, the phone
> layout needs a coarse pointer, and desktop screenshots at 1440, 1024 and
> 640 px are pixel-identical to before (apart from the solver timing text).
> Phase 4 (PWA, file open / share, performance) is next. Still to verify on
> real devices: iOS Safari, iPad with Apple Pencil, a mid-range Android.

Checked on 8 Nov 2026 with Playwright device emulation (iPhone 13, Pixel 7,
iPad gen 7 portrait and landscape, iPhone 13 landscape) and synthetic touch
input (taps, one-finger drags, two-finger pinch, long press).

Screenshots: [editor on iPhone 13, Pixel 7, iPad](mobile-audit/editor-phones-tablet.jpg),
[editor on a phone in landscape](mobile-audit/editor-phone-landscape.jpg).

## What works today

- **Landing page:** one column, no horizontal scroll, readable copy. The
  examples carousel swipes and its images load lazily. Tapping the hero demo's
  swatches and areas paints them.
- **Editor, tap-tap tools:** tools that place points with clicks (rectangle,
  circle, line) work with taps, because taps arrive as pointer clicks.
- **Editor on iPad landscape:** the layout fits; the windows leave most of
  the canvas visible.

## What is broken

### Editor (`/app/`)

| # | Problem | Evidence | Severity |
|---|---|---|---|
| E1 | **Dragging does nothing on touch.** The canvas has `touch-action: auto`, so the browser takes a one-finger drag as page panning and cancels the pointer. Drawing with Pen or Marker, dragging shapes, box select and moving ink all fail. | Pen drag with touch: 0 strokes | Blocker |
| E2 | **Pinch zooms the page, not the drawing.** No two-finger gesture handling; the browser zooms the whole UI (scale 5×). Panning needs a middle button or Alt-drag, which don't exist on touch. | pinch: view zoom 4 → 4, page scale 1 → 5 | Blocker |
| E3 | **The menu bar is wider than the phone.** It needs 1143 px; on a 390 px phone the view toggles, window buttons and theme are cut off. The overflow also widens the layout to ~770 px, so the page can be scrolled sideways and zoomed out. Closed windows can't be reopened. | menubar scrollWidth 1143 / 390 | Blocker |
| E4 | **Five floating windows cover the canvas.** Tools, Sketch, Colors, Layers and Properties all open by default and overlap each other; on a phone less than a fifth of the drawing is visible. In phone landscape the canvas is 228 px tall. | screenshots | High |
| E5 | **Options bar text collides** ("Mirror Offset Apply line style" print over each other), and the hint text runs off-screen. | screenshot | Medium |
| E6 | **No long press.** Right-click actions (selection list, Set as construction, Create midpoint) are unreachable. | long-press: no menu | High |
| E7 | **Keyboard-only actions.** Delete, Escape (cancel / end a chain), Ctrl / Shift-click (multi-select), shortcuts (N, G, E, D, M, K, F). | code review | High |
| E8 | **Mouse-sized hit targets.** Points 7 px, lines 6 px, ink 5 px, relation badges 16 px, menu buttons 32 px: too small for a finger (~44 px). | code review | Medium |
| E9 | **Status bar cut off** on phones (state pills and "Report a problem" hidden). | screenshot | Low |
| E10 | **Import is a JSON textarea** (hard on phones, no file picker); no share sheet. | code review | Medium |

### Landing page (`/`)

| # | Problem | Evidence | Severity |
|---|---|---|---|
| L1 | **"Open the editor" leads phone users to an editor they can't draw in** (E1 to E4). | above | High until the editor is fixed |
| L2 | **Hero demo labels are tiny**: the SVG scales down to 370 px, so 12 px labels render at 7.6 px. | measured | Medium |
| L3 | **Small tap targets**: paint swatches 22 px, carousel arrows 32 px, tabs 30 px tall. | measured | Medium |
| L4 | **Hero screenshot unreadable on phones** (a 1440 px editor shrunk to 360 px) and the heaviest asset (`app-preview.png`, ~1 MB). | screenshot, file size | Low |

## Approach

**Who uses OnSketch on a mobile device, and for what?**

- **Tablet (iPad, Android tablet, often with a stylus): full use.** Sketching
  concepts with a pencil is a natural fit and the screen is big enough for the
  full feature set. This is the priority.
- **Phone: open, review, adjust, annotate.** Open a shared or saved drawing or
  an example, change a dimension or a variable (scrubbing works well with a
  thumb), repaint, add ink, export or share. Drafting new CAD geometry on a
  phone is possible but secondary.

**Principles**

1. **One input model, any pointer.** Pointer events already unify mouse, pen
   and touch; add what touch lacks: gestures (pan, pinch), long press, larger
   hit tolerances, and on-screen replacements for keys and modifiers.
2. **The canvas comes first.** On small screens at most one panel is open,
   as a bottom sheet the user can pull down; tools sit in the thumb zone.
3. **Same app, responsive shell.** No separate mobile app or codebase:
   breakpoints switch the chrome (menu bar, windows, options bar), the canvas
   and tools stay the same.
4. **Stylus and finger can differ.** With a pen, the pen draws and fingers
   pan / zoom (as in Procreate or Concepts), which also gives palm rejection.

## Plan

Sizes: **S** ≈ a day, **M** ≈ 2–4 days, **L** ≈ a week.

### Phase 0: stop the bleeding (S)

Small changes that make the editor usable on tablets right away and stop
the phone layout from breaking.

- [ ] `touch-action: none` on the canvas (fixes E1: drawing, dragging, box
      select and ink on touch) and on the value scrub boxes.
- [ ] Contain the menu bar: on narrow screens it scrolls horizontally inside
      its own width (`overflow-x: auto`), so the page is never wider than
      the device (E3 stopgap).
- [ ] Windows start closed below 700 px wide except Tools; the window
      manager keeps a separate saved layout per size class (E4 stopgap).
- [ ] Options bar: one line that scrolls horizontally, icon-only buttons
      below 700 px, hint text hidden (E5). Status bar: hide coordinates and
      zoom below 700 px (E9).
- [ ] iOS details: `-webkit-touch-callout: none` and
      `-webkit-user-select: none` on the workspace, `viewport-fit=cover`,
      safe-area padding.
- [ ] Landing: on phones, a one-line note under "Open the editor": "Works
      best on a tablet or computer for now" (L1, until phase 2 ships).

*Done when:* on iPad, Pen and Marker draw with a finger or stylus, shapes and
ink drag, box select works; on a phone the page never scrolls sideways and
the canvas is mostly visible at first open.

### Phase 1: touch input (M)

- [ ] **Gestures** in `render-events.js`: track active pointers. One finger
      goes to the tool; a second finger cancels the tool's in-progress
      action and starts pan + pinch-zoom around the two-finger centre.
      Two-finger tap = Undo, three-finger tap = Redo (common convention).
      Double-tap with Select = zoom to fit. (Fixes E2.)
- [ ] **Stylus mode**: when a `pointerType: 'pen'` event is seen, fingers
      only pan / zoom and never draw (palm rejection); a setting turns it
      off.
- [ ] **Long press** (≈ 450 ms, under 8 px of movement) opens the context
      menu with finger-sized rows (fixes E6).
- [ ] **Hit tolerance by pointer type**: mouse as today; touch about 2.5×
      (points, lines, ink, dimension labels, relation badges, snap radius).
      One helper, used by every hit test (E8).
- [ ] **No keyboard needed** (E7): when something is selected, the options
      bar shows Delete and, for multi-select, a "Add to selection" toggle that
      replaces Ctrl / Shift; drawing tools show **Done** (ends a line chain,
      like Escape / double-click) and **Cancel**.
- [ ] **Value box on touch**: `enterkeyhint="done"`, no autocorrect /
      autocapitalise, kept above the on-screen keyboard (`visualViewport`
      resize); tapping a shape still inserts its D-name.
- [ ] The snap hint and the brush footprint are drawn offset above the
      finger so the finger doesn't hide them.

*Done when:* every feature that works with a mouse works with a finger on
an iPad, without a keyboard; pinch never zooms the page.

### Phase 2: phone layout (L)

A responsive shell below 700 px wide (and for phones in landscape):

- [ ] **Top bar**: logo, Undo, Redo, project name (truncated), and a **⋯**
      menu with File (new, open, save, export), View toggles (grid, snap,
      dimensions, relations, theme), Reset layout, Report a problem.
- [ ] **Bottom toolbar** in the thumb zone, five slots: **Select**,
      **Draw ▸** (line, rectangle, circle, arc, polygon, point),
      **Dimension**, **Paint ▸** (fill, pen, marker, eraser), **Panels ▸**
      (layers, colours, properties, equations). A slot with ▸ opens a small
      fly-out above it.
- [ ] **Bottom sheets instead of floating windows**: one panel at a time,
      with a grab handle and two heights (peek / half), swiping down closes
      it. The same panel code renders into a sheet or a window.
- [ ] **Contextual chips** above the bottom bar replace the options bar
      (weight, line type, construction, size, opacity, Fill / Erase, Mirror,
      Offset…), horizontally scrollable.
- [ ] **Status pill** on the canvas (Fully defined / Under-defined / DOF);
      tap it for the details now in the status bar.
- [ ] **Phone landscape**: no top bar; the toolbar becomes a side rail.
- [ ] Safe areas for notches and the home indicator.

*Done when:* on iPhone 13 and Pixel 7 the canvas uses at least 70% of the
screen with no panel open, every action is two taps or less from the bottom
bar, and nothing overlaps or is cut off in portrait or landscape.

### Phase 3: precision on touch (M)

- [ ] **Loupe**: while placing or dragging a point with a finger, a magnified
      circle above the finger shows the snap target.
- [ ] **Dimension keypad**: a sheet with digits, units (mm, cm, m, in, ft,
      °), operators, and buttons for existing names (D1, D2, variables), so
      equations are easy to type without the full keyboard.
- [ ] Bigger dimension labels and relation badges when the last input was
      touch.
- [ ] Nudge buttons (arrow pad) for the selected point or shape, with a step
      setting.

### Phase 4: mobile use and distribution (M)

- [ ] **Installable app (PWA)**: web manifest, icons (the logo tile already
      fits), standalone display, a service worker that caches the static app
      so it works offline (the editor is static files, so this is cheap).
- [ ] **Open and share files**: file picker for import (replaces the JSON
      textarea, E10), Web Share API for the project file and, once image
      export exists, PNG / PDF; register as a share target for `.json`
      projects.
- [ ] **Performance** on mid-range Android: cap the canvas pixel ratio,
      throttle solves during drags, test with the example drawings and a
      large floor plan.
- [ ] Later, with share links: a **viewer mode** (pan, zoom, inspect
      dimensions) that is light enough for any phone.

### Landing page (S, alongside phase 0)

- [ ] Hero demo on phones: draw it at a larger scale (or crop the view) so
      labels render at 11 px or more, and drop the "dimension / equation /
      constraints" tags below 420 px in favour of the Equations panel (L2).
- [ ] Tap targets of at least 40 px: swatches 32 px with spacing, carousel
      arrows and tabs 40 px (L3).
- [ ] Hero screenshot: a `<picture>` with a cropped, canvas-focused image
      for phones and WebP / AVIF versions; keep the PNG as fallback (L4).
- [ ] After phase 2: change the phone note to "Works on your phone too" and
      show a phone screenshot in the hero.

## Testing

- **Automated** (`tests/mobile.e2e.mjs`, Playwright device emulation:
  iPhone 13, Pixel 7, iPad portrait and landscape):
  - no horizontal overflow on `/` and `/app/`;
  - open panels cover at most 40% of the canvas on phones;
  - one-finger drag with Pen creates a stroke; dragging a shape moves it;
  - two-finger pinch changes the view zoom and not the page scale;
  - long press opens the context menu; its actions work;
  - every action reachable with no keyboard (Delete, Done, Cancel,
    multi-select toggle).
- **Real devices** before each phase ships: iOS Safari on an iPhone and an
  iPad with Apple Pencil (pinch and long-press quirks, palm rejection,
  callouts), Chrome on a mid-range Android phone.

## Order

1. Phase 0 + landing fixes (S): makes tablets usable now.
2. Phase 1 (M): touch input, full feature parity on tablets.
3. Phase 2 (L): phone layout.
4. Phase 3 and 4 (M each), in either order; PWA and file sharing give the
   most value per day once phones work.
