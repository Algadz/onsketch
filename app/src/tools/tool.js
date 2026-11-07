/* =============== 8. TOOLS ===================================== */
export class Tool {
  constructor(app) { this.app = app; }
  activate() {} deactivate() {}
  onPointerDown() {} onPointerMove() {} onPointerUp() {} onKey() {}
  getPreview() { return null; }
}
