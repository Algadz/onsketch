import { EPS, clamp } from '../core/math.js';

/* =============== 6. VIEW / RENDERER =========================== */
export class View {
  constructor() { this.zoom=4; this.panX=0; this.panY=0; this.cssW=0; this.cssH=0; }
  worldToScreen(p) {
    return { x: this.cssW/2 + this.panX + p.x*this.zoom,
             y: this.cssH/2 + this.panY - p.y*this.zoom };
  }
  screenToWorld(p) {
    return { x:  (p.x - this.cssW/2 - this.panX)/this.zoom,
             y: -(p.y - this.cssH/2 - this.panY)/this.zoom };
  }
  zoomAt(screenPt, factor) {
    const w = this.screenToWorld(screenPt);
    this.zoom = clamp(this.zoom * factor, 0.05, 5000);
    const w2 = this.screenToWorld(screenPt);
    this.panX += (w2.x - w.x) * this.zoom;
    this.panY -= (w2.y - w.y) * this.zoom;
  }
  fitTo(bbox, paddingPx = 60) {
    if (!bbox) return;
    const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
    if (w < EPS && h < EPS) return;
    const zx = (this.cssW - paddingPx*2) / Math.max(w, EPS);
    const zy = (this.cssH - paddingPx*2) / Math.max(h, EPS);
    this.zoom = clamp(Math.min(zx, zy), 0.05, 5000);
    const cx = (bbox.minX + bbox.maxX)/2, cy = (bbox.minY + bbox.maxY)/2;
    this.panX = -cx * this.zoom;
    this.panY =  cy * this.zoom;
  }
}
