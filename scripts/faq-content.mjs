// Content of the FAQ page (/faq/). scripts/build-faq.mjs turns it into
// faq/index.html, with the same questions and answers in the page and in
// its FAQPage structured data (JSON-LD), so the two never disagree.
// Answers are HTML (links, <b>, <kbd>, lists); keep them true to the app.

export const SECTIONS = [
  {
    id: 'start', title: 'Getting started',
    faqs: [
      ['What is OnSketch?',
        `<p>OnSketch is a free 2D sketching app in your browser for concept drawings with real dimensions: floor plans, furniture, brackets, PCB outlines, laser-cut parts, garden plans, packaging and booth layouts. You draw like in a paint program, then lock the sizes that matter with dimensions and relations, as in CAD (a parametric sketcher). Change a number and the drawing follows, colours and labels included.</p>`],
      ['Is OnSketch free?',
        `<p>Yes. Every drawing tool is free, with no time limit and no watermark, and so are the image exports (PNG, SVG, copy to the clipboard) and printing or PDF to scale. A free account keeps 3 sketches, shown in the public <a href="/library/">library</a>. <a href="/pricing/">OnSketch Pro</a> ($29 a year, tax included) adds unlimited and private sketches, and DXF import and export.</p>`],
      ['Do I need an account?',
        `<p>No. <a href="/app/">Open the editor</a> and draw: your drawing is saved in this browser as you work. Sign in (Google or an email code) to keep sketches in your account, open them on another device, and share them in the library.</p>`],
      ['Does it work on a phone or a tablet?',
        `<p>Yes. On a phone the editor switches to a layout with a bottom bar (Select, Draw, Dimension, Paint, Panels). To place a point, touch, slide to aim (a magnifier and the snap show where it goes) and lift; the status pill says which point comes next. Two fingers pan and zoom. A stylus draws while fingers only pan, so a resting palm does nothing.</p>`],
      ['Where are my sketches saved?',
        `<p>The open drawing is saved automatically in your browser. Signed in, <b>Save</b> (<kbd>Ctrl+S</kbd>) also keeps it in your account, and it syncs as you work; <b>Open</b> (<kbd>Ctrl+O</kbd>) and <a href="/app/projects/">My sketches</a> list them. Undo (<kbd>Ctrl+Z</kbd>) goes back up to 100 steps.</p>`],
    ],
  },
  {
    id: 'drawing', title: 'Drawing tools', tools: ['select', 'line', 'centerLine', 'rectangle', 'centerRectangle', 'circle', 'threePointCircle', 'arc', 'hexagon', 'point', 'curve', 'trim'],
    faqs: [
      ['How do I draw a line or a polyline?',
        `<p>Pick <b>Line</b> (<kbd>L</kbd>), click the start, click the end. Lines chain: each end starts the next segment, so a few clicks draw an outline. <kbd>Esc</kbd> or <kbd>Enter</kbd> ends the chain. Ends snap to other ends, middles, centres and onto lines and circles, and a nearly level or upright line gets a Horizontal or Vertical relation. Hold <kbd>Alt</kbd> to place without snapping. <b>Centerpoint line</b> (<kbd>Shift+L</kbd>) starts from the middle.</p>`],
      ['How do I draw rectangles, circles, arcs and polygons?',
        `<ul><li><b>Rectangle</b> (<kbd>R</kbd>): two opposite corners. <b>Center rectangle</b> (<kbd>Shift+R</kbd>): the centre, then a corner.</li><li><b>Circle</b> (<kbd>C</kbd>): the centre, then a point on it. <b>3-point circle</b> (<kbd>Shift+C</kbd>): three points on it.</li><li><b>Centerpoint arc</b> (<kbd>A</kbd>): the centre, the start, then the end.</li><li><b>Polygon</b> (<kbd>H</kbd>): the centre, then a corner; the number of sides is in the options bar.</li></ul>`],
      ['How do I draw curves?',
        `<p><b>Curve</b> (<kbd>V</kbd>) draws Bézier paths point by point, like a pen tool. Click for a smooth point, press and drag to pull its handle; starting on the end of a line or an arc continues it tangentially. Click the first point to close the path. With Select, drag the handles to shape it.</p>`],
      ['How do I trim or split shapes?',
        `<p><b>Scissors</b> (<kbd>X</kbd>) has two modes (press <kbd>X</kbd> again to switch). <b>Trim</b> removes the piece between the nearest crossings, highlighted in red before you click; drag across shapes to trim many at once. <b>Split</b> cuts a line, an arc or a circle in two where you click. Relations and dimensions that still make sense are kept.</p>`],
      ['How do I mirror, offset or repeat shapes?',
        `<p>In the Tools window: <b>Mirror</b> copies the selection across a line, symmetric. <b>Offset</b> makes a parallel copy at a distance you can dimension. <b>Linear pattern</b> repeats along a direction or a grid, <b>Circular pattern</b> around a centre, and <b>Point pattern</b> onto points you pick. Kept linked, patterns follow when you change the original, and their counts and spacings take formulas.</p>`],
      ['How do I select and move things?',
        `<p><b>Select</b> (<kbd>S</kbd>): click to select, <kbd>Ctrl</kbd>-click to add, drag a box to select many, drag to move. What a drag can move depends on the relations and dimensions: a fully defined shape stays put. Right-click (or long-press) for actions such as Create midpoint, Set as construction, Trace path, or a list of what is under the cursor when shapes overlap. <kbd>Delete</kbd> removes the selection.</p>`],
    ],
  },
  {
    id: 'dimensions', title: 'Dimensions, relations and equations', tools: ['smartdim'],
    faqs: [
      ['How do I set a size?',
        `<p>Pick <b>Smart Dimension</b> (<kbd>D</kbd>), click a line (or two shapes, or a circle), click where the label goes and type the value, then <kbd>Enter</kbd>. Placed above or beside a line it measures its horizontal or vertical extent; at an angle between two lines it sets the angle. Values take units (<code>2in</code>, <code>30cm</code>, <code>45deg</code>). After one dimension the tool goes back to Select. Click a label later to change its value.</p>`],
      ['What are relations?',
        `<p>Relations are rules the drawing keeps: <b>Coincident</b>, <b>Horizontal</b>, <b>Vertical</b>, <b>Parallel</b>, <b>Perpendicular</b>, <b>Collinear</b>, <b>Equal length</b>, <b>Equal radius</b>, <b>Concentric</b>, <b>Tangent</b>, <b>Midpoint</b>, <b>Symmetric</b>, <b>Fix</b>, <b>Point on line, circle or curve</b> and <b>Smooth</b>. Select shapes and Properties (or the right-click menu) offers the ones that apply. Snapping adds many of them as you draw. The badges on the canvas show them; <kbd>K</kbd> hides or shows them.</p>`],
      ['What do the line colours mean?',
        `<p>As in CAD: <b>blue</b> is under-defined (it can still move), <b>black</b> is fully defined, <b>red</b> is over-defined (a conflict to remove), <b>pink</b> is construction geometry and <b>orange</b> is the selection. The status bar shows the state and the degrees of freedom (DOF) left.</p>`],
      ['What is a driven dimension?',
        `<p>A <b>driving</b> dimension sets the size. A <b>driven</b> dimension (a reference) only measures, and follows the drawing as it changes. Switch one in Properties (Driving | Driven), on its row in the Dimensions list, or by right-clicking its label. A dimension that would over-define the sketch stays driven.</p>`],
      ['How do formulas and variables work?',
        `<p>Dimensions get names (D1, D2…). Type <code>=D1/2 + 5mm</code> as a value to keep a formula: when D1 changes, it follows. The <b>Equations</b> window (Σ) holds global variables such as <code>width</code> or <code>gap</code> and lists the dimensions that have a formula. Functions: <code>sin cos tan sqrt abs min max</code>, and <code>pi</code>. Pattern counts and spacings, and texts (<code>{D1}</code> shows a value), take them too.</p>`],
      ['Can I change a variable with a slider?',
        `<p>Yes. In the Equations window, the ⊸ button on a variable's row puts a slider for it on the drawing. Drag the knob and the sketch follows live; release for one undo step. Click the value to type one, drag the name to move the slider; Properties sets its range. In the Equations window itself you can also drag a value sideways, as in Blender.</p>`],
      ['Which units can I use?',
        `<p>A drawing is in one unit: millimetres, centimetres, metres, kilometres, inches, feet or miles (the menu bar, or Properties with nothing selected). Values can be typed in any of them and are converted: <code>1/8in</code> in a millimetre drawing works.</p>`],
    ],
  },
  {
    id: 'mechanisms', title: 'Mechanisms and motion',
    faqs: [
      ['Can OnSketch show how a mechanism moves?',
        `<p>Yes. Leave the moving parts free and fix the ground points: dragging the crank moves the whole linkage, solved live. Right-click a point and choose <b>Trace path of this point</b> to draw every position it can reach as a dashed ink curve: a circle for a crank end, a segment for a slider, a coupler curve for a four-bar linkage. The path follows the sketch when you change a length, live while you drag a slider. <a href="/app/?example=linkage">Open the linkage example</a>.</p>`],
    ],
  },
  {
    id: 'sketch', title: 'Colour, ink and annotation tools', tools: ['fill', 'pen', 'marker', 'arrow', 'shape', 'text', 'eraser'],
    faqs: [
      ['How do I colour an area?',
        `<p><b>Fill</b> (<kbd>B</kbd>) paints the closed area you click with the current colour (Colors window), and outside every area it colours the background. Fills follow the shapes when sizes change. <b>Erase</b> mode removes a fill.</p>`],
      ['What are pen, marker, arrows, shapes and text for?',
        `<p>Annotation on top of the drawing, called ink: it is never solved or dimensioned, so it never gets in the way.</p><ul><li><b>Pen</b> (<kbd>N</kbd>) and <b>Marker</b> (<kbd>G</kbd>, see-through): freehand strokes.</li><li><b>Arrow</b> (<kbd>W</kbd>): drag from the label to the target; ends dropped on a shape stay attached to it.</li><li><b>Shapes</b> (<kbd>U</kbd>): rectangle, rounded rectangle, ellipse, triangle, diamond, pentagon, hexagon, star, heart, speech bubble, check mark and cross, with fill and line styles.</li><li><b>Text</b> (<kbd>T</kbd>): labels, with an optional box; <code>{D1}</code> in a text shows a dimension's value.</li><li><b>Eraser</b> (<kbd>E</kbd>): removes whole strokes and texts.</li></ul><p>Ink can be grouped, linked to a shape so it follows it, copied and pasted (also into other apps), resized and turned with its box.</p>`],
      ['Can I add a picture?',
        `<p>Yes: <b>Image…</b> in the Sketch window (or <kbd>I</kbd>), drop a file on the canvas, or paste one. PNG, JPEG, WebP or GIF up to 3 MB, transparency kept. Use it to trace over a photo or a plan, at its real size once you resize it.</p>`],
    ],
  },
  {
    id: 'organise', title: 'Layers, parts and the library',
    faqs: [
      ['How do layers work?',
        `<p>Layers (Layers window) organise what you see: show, hide, lock, set the opacity, reorder. You draw on the active layer. They are for display only: relations and dimensions work across layers, so a part on one layer can be dimensioned against another.</p>`],
      ['Can I reuse a drawing inside another?',
        `<p>Yes. <b>Insert</b> (in Open, or <b>Insert into my sketch</b> in the library) places a saved sketch at real size, on its own layer, as a part you can move and dimension against your drawing. Its relations and dimensions come along.</p>`],
      ['What is the library?',
        `<p>The <a href="/library/">library</a> lists every public sketch. Open one as a copy in the editor (it becomes yours to change and save), insert it into your drawing, give it a thumbs-up, or copy a link that opens it straight in the editor. Free sketches are public; Pro sketches can be private.</p>`],
    ],
  },
  {
    id: 'export', title: 'Export, printing and DXF',
    faqs: [
      ['How do I get my drawing into slides or documents?',
        `<p><b>Export</b> in the menu bar: <b>Copy image</b> puts a PNG on the clipboard, ready to paste into slides, documents and messages; <b>PNG</b> (2×, white or transparent background) and <b>SVG</b> (vector) download a file. Dimensions and construction lines are optional.</p>`],
      ['Can I print at a real scale or make a PDF?',
        `<p>Yes, free: <b>Print / PDF</b> lays the drawing on one A4, A3 or Letter sheet at a true scale (1:1, 1:2, 1:5, 1:10… or Auto, the largest that fits), with the scale and a check length on the sheet. Choose "Save as PDF" in the print dialog for a PDF.</p>`],
      ['Can I export or import DXF for CAD, CAM or a laser cutter?',
        `<p>With <a href="/pricing/">OnSketch Pro</a>. <b>DXF export</b> writes the lines, circles, arcs and curves at real size, on layers named after yours. <b>Import</b> (menu bar, or drop a .dxf on the canvas) reads lines, circles, arcs, polylines and points, joins ends that meet, converts the file's units, and places it as an editable part. Text, dimensions, hatches, splines and blocks are not imported.</p>`],
    ],
  },
  {
    id: 'account', title: 'Accounts, Pro and privacy',
    faqs: [
      ['What does OnSketch Pro add?',
        `<p>Unlimited sketches in your account (free: 3), private sketches (free sketches are public in the library), and DXF import and export. It costs $29 a year, sales tax and VAT included. Every drawing tool, image export and printing to scale stay free. <a href="/pricing/">See the plans</a>.</p>`],
      ['How do I pay or cancel?',
        `<p>Payments are handled by Link (Stripe) as the merchant of record, by card, Apple Pay or Google Pay; OnSketch never sees your card. <b>Manage subscription</b> (account menu or the pricing page) updates the card, shows invoices and cancels: Pro stays on until the end of the year you paid for, and nothing is deleted afterwards.</p>`],
      ['What does OnSketch know about me?',
        `<p>Without an account, your drawing stays in your browser. With one, your sketches and the public username you choose. There are no ads and no tracking cookies: visits are counted with Umami, without cookies and without identifying you. Details in the <a href="/privacy/">privacy policy</a>.</p>`],
      ['How do I report a problem or suggest a feature?',
        `<p>Use <b>Report a problem</b> at the bottom right of the editor. You can attach the current drawing, which helps reproduce the problem; leave an email address if you'd like an answer.</p>`],
    ],
  },
];

/** Keyboard shortcuts besides the tool keys (table at the end). */
export const SHORTCUTS = [
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
  ['Ctrl+S / Ctrl+O', 'Save / Open (signed in)'],
  ['Ctrl+C, Ctrl+X, Ctrl+V', 'Copy, cut and paste ink (strokes, arrows, texts, pictures)'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup ink'],
  ['Delete', 'Delete the selection'],
  ['Esc', 'Cancel, end a line chain, then back to Select'],
  ['M / K', 'Show or hide dimensions / relations'],
  ['F', 'Zoom to fit'],
  ['Space + drag, middle button', 'Pan'],
  ['Alt (while drawing or dragging)', 'Place without snapping'],
  ['Shift (while dragging a value)', 'Finer steps'],
  ['I', 'Import an image'],
  ['F5', 'Solve again'],
];

/** What each tool does, one line (the tool tables). */
export const TOOL_LINES = {
  select: 'Select, move and edit; right-click for actions.',
  line: 'Lines that chain into outlines; Esc ends.',
  centerLine: 'A line drawn from its middle.',
  rectangle: 'Two opposite corners.',
  centerRectangle: 'The centre, then a corner.',
  circle: 'The centre, then a point on it.',
  threePointCircle: 'Through three points.',
  arc: 'The centre, the start, then the end.',
  hexagon: 'A regular polygon: centre and a corner; sides in the options bar.',
  point: 'A point, for construction or to dimension to.',
  curve: 'Bézier curves, smooth or with corners.',
  trim: 'Trim back to crossings, or split a shape in two.',
  smartdim: 'Lengths, distances, radii, diameters and angles; values or =formulas.',
  fill: 'Colour a closed area, or the background.',
  pen: 'Freehand ink.',
  marker: 'See-through highlighter ink.',
  arrow: 'Arrows and leaders that stay attached to shapes.',
  shape: 'Twelve ready-made shapes as ink.',
  text: 'Labels, boxed or not; {D1} shows a value.',
  eraser: 'Removes whole strokes and texts.',
};
