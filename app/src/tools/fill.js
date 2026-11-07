import { Tool } from './tool.js';

/** Paint bucket. Click inside a closed region to fill it with the fill
 *  colour; click outside every region to colour the background. In
 *  erase mode the click removes the fill under the cursor instead. */
export class FillTool extends Tool {
  hint() {
    return this.app.fillErase
      ? 'Click a filled region to remove its fill (outside any region clears the background).'
      : 'Click inside a closed region to fill it. Click outside every region to fill the background.';
  }
  onPointerDown(world) {
    if (this.app.fillErase) this.app.eraseFillAt(world);
    else this.app.bucketFillAt(world);
  }
  onKey(ev) { if (ev.key === 'Escape') this.app.setTool('select'); }
}
