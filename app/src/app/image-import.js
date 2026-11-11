import { newId } from '../core/entities.js';
import { IMAGES_TOTAL_MAX, IMAGE_MAX_BYTES, IMAGE_TYPES, imageId, imagePixelSize, imagePoints, imageSource, registerImage, usedImageIds } from '../core/images.js';
import { alertDialog } from '../ui/dialogs.js';

/* =============== IMPORTING IMAGES ==============================
   Puts a picture (PNG, JPEG, WebP or GIF, up to 3 MB) on the active
   layer, as ink (core/images.js):
     - Image… in the Sketch window, or I: pick a file;
     - drop a file on the canvas: placed where it is dropped;
     - paste (Ctrl+V) an image from the clipboard: placed in the middle.
   Each file must be under 3 MB, and a sketch's pictures together under
   about 3.2 MB (a saved sketch stays under the 5 MB cloud limit).
   It fits about half of the view, keeps its proportions and its
   transparency, and comes in selected with the Select tool, so the
   transform box resizes and turns it right away; right-click → Link to
   a shape… makes it follow a point, line, circle or arc.
   One import = one undo step.
   ============================================================ */
export class ImageImportMixin {
  _setupImageImport() {
    const c = this.canvas;
    const hasFile = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
    c.addEventListener('dragover', (ev) => {
      if (!hasFile(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    c.addEventListener('drop', (ev) => {
      if (!hasFile(ev)) return;
      ev.preventDefault();
      const file = [...ev.dataTransfer.files].find(f => f.type.startsWith('image/')) || ev.dataTransfer.files[0];
      if (!file) return;
      const r = c.getBoundingClientRect();
      this.importImageFile(file, this.view.screenToWorld({ x: ev.clientX - r.left, y: ev.clientY - r.top }));
    });
    window.addEventListener('paste', (ev) => {
      if (ev.target?.matches?.('input,textarea,[contenteditable="true"]')) return;
      const item = [...(ev.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      ev.preventDefault();
      this.importImageFile(file);
    });
  }

  /** Opens the file picker. */
  openImagePicker() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = IMAGE_TYPES.join(',');
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      inp.remove();
      if (file) this.importImageFile(file);
    });
    document.body.appendChild(inp);
    inp.click();
  }

  /** Reads, checks and places a picture. `at` is its middle (world);
   *  the middle of the view by default. @returns {Promise<object|null>} */
  async importImageFile(file, at = null) {
    if (!IMAGE_TYPES.includes(file.type)) {
      await alertDialog({ title: 'Can\'t import this file', message: 'Choose a PNG, JPEG, WebP or GIF image.' });
      return null;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      await alertDialog({ title: 'Image too large', message: `This image is ${mb} MB. Images must be less than 3 MB: export it smaller or as a JPEG, then try again.` });
      return null;
    }
    let src;
    try { src = await readDataURL(file); } catch { src = null; }
    if (src && !usedImageIds(this.project).has(imageId(src))) {
      let total = src.length;
      for (const used of usedImageIds(this.project)) total += (imageSource(used) || '').length;
      if (total > IMAGES_TOTAL_MAX) {
        const mb = (n) => (n * 0.75 / 1024 / 1024).toFixed(1);
        await alertDialog({ title: 'Too many images', message: `A sketch can hold about ${mb(IMAGES_TOTAL_MAX)} MB of images in total, and this one would bring it to ${mb(total)} MB. Use a smaller image, or remove one first.` });
        return null;
      }
    }
    const id = src && registerImage(src);
    const px = id && (imagePixelSize(src) || await decodedSize(src));
    if (!id || !px || !(px.w > 0) || !(px.h > 0)) {
      await alertDialog({ title: 'Can\'t read this image', message: 'The file may be damaged. Try saving it again as PNG or JPEG.' });
      return null;
    }
    return this.placeImage(id, px, at);
  }

  /** Adds a picture of `px` pixels (its proportions) to the active layer. */
  placeImage(id, px, at = null) {
    const sketch = this.activeSketch(); if (!sketch) return null;
    const v = this.view;
    const c = at || v.screenToWorld({ x: v.cssW / 2, y: v.cssH / 2 });
    // about half the view, never larger than the picture's own pixels
    const fit = Math.min((v.cssW * 0.5) / px.w, (v.cssH * 0.5) / px.h, 1) / v.zoom;
    const item = {
      id: newId('k'), layerId: this.project.activeLayerId, kind: 'image', image: id,
      color: '#111418', opacity: 1,
      points: imagePoints(c, px.w * fit, px.h * fit),
    };
    if (this.toolName !== 'select') this.setTool('select');
    this.clearSelection?.();
    this.clearStrokeSelection();
    this.addStroke(item);
    item.selected = true;
    this.refreshUI();
    this.requestRender();
    const layer = this.project.activeLayer();
    this._inkHint(layer && !layer.visible
      ? 'Image added to a hidden layer: show the layer to see it.'
      : 'Image added. Drag the box handles to resize and turn it; right-click → Link to a shape… to make it follow the geometry.');
    return item;
  }
}

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Pixel size from the browser's decoder (when the header wasn't read). */
function decodedSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
