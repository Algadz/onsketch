import { Tool } from './tool.js';

/* =============== TEXT TOOL (T) =================================
   Click on the canvas to type a label there; click an existing text on
   the active layer to edit it. The editor is an inline box over the
   canvas (app/text-edit.js): Enter or Esc finishes, Shift+Enter starts
   a new line, clicking elsewhere finishes. A click that finishes an
   edit only finishes it, so clicking away never drops an empty box.
   Text is ink: on the active layer, in the shared colour, never solved.
   ============================================================ */
export class TextTool extends Tool {
  constructor(app) { super(app); this.cursor = null; }
  hint() { return 'Click to type text on the active layer; click a text to edit it. Enter finishes, Shift+Enter adds a line.'; }
  deactivate() { this.app.finishTextEdit(); }

  onPointerDown(world, _snap, ev) {
    if (ev && ev.button !== 0) return;
    if (this.app.finishTextEdit()) { ev?.preventDefault?.(); return; }
    const hit = this.app.hitStrokeAt(world, { textOnly: true });
    if (hit) { this.app.editText(hit); ev?.preventDefault?.(); return; }
    this.app.startNewText(world);
    ev?.preventDefault?.();
  }
  onPointerMove(world) {
    this.cursor = world;
    const hit = !this.app._textEdit && this.app.hitStrokeAt(world, { textOnly: true });
    this.app.canvas.style.cursor = hit ? 'pointer' : 'text';
  }
  onKey(ev) {
    if (ev.key === 'Escape' && !this.app._textEdit) this.app.setTool('select');
  }
  getPreview() {
    if (!this.cursor || this.app._textEdit) return null;
    // A caret-sized mark where the text will start.
    const h = this.app.inkSettings('text').size / this.app.view.zoom;
    return { dashedPaths: [[{ x: this.cursor.x, y: this.cursor.y + h * 0.6 }, { x: this.cursor.x, y: this.cursor.y - h * 0.6 }]] };
  }
}
