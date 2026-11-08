/* =============== REPORT A PROBLEM ==============================
   A small link at the right end of the status bar opens a form that
   posts to Formspree. Sent: the description, an optional reply email,
   the browser / screen / app version, the last few script errors, and,
   only when the box is ticked, the current project as JSON.
   ============================================================ */
const ENDPOINT = 'https://formspree.io/f/mrppvjjp';
const MAX_PROJECT_CHARS = 200000;

export class ReportMixin {
  _setupReport() {
    this._recentErrors = [];
    const note = (msg) => {
      this._recentErrors.push(`${new Date().toISOString()} ${msg}`);
      if (this._recentErrors.length > 5) this._recentErrors.shift();
    };
    window.addEventListener('error', (e) => note(`${e.message} @ ${e.filename?.split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) => note(`unhandled: ${e.reason?.message || e.reason}`));

    const back = document.getElementById('report-modal');
    const form = document.getElementById('report-form');
    const status = document.getElementById('report-status');
    const send = document.getElementById('report-send');
    const open = () => {
      status.textContent = ''; status.className = 'report-status';
      send.disabled = false;
      back.classList.add('show');
      form.elements.message.focus();
    };
    const close = () => back.classList.remove('show');
    document.getElementById('report-open').addEventListener('click', open);
    document.getElementById('report-cancel').addEventListener('click', close);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const message = form.elements.message.value.trim();
      if (!message) { form.elements.message.focus(); return; }
      const data = new FormData();
      data.append('message', message);
      const email = form.elements.email.value.trim();
      if (email) data.append('email', email);
      data.append('_subject', 'OnSketch problem report');
      data.append('context', this._reportContext());
      if (form.elements.attach.checked) {
        let json = '';
        try { json = JSON.stringify(this.project.toJSON()); } catch (e) { json = 'could not serialise: ' + e.message; }
        data.append('project', json.length > MAX_PROJECT_CHARS ? json.slice(0, MAX_PROJECT_CHARS) + '…[truncated]' : json);
      }
      send.disabled = true;
      status.className = 'report-status';
      status.textContent = 'Sending…';
      try {
        const res = await fetch(ENDPOINT, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        status.className = 'report-status ok';
        status.textContent = 'Sent. Thank you!';
        form.reset();
        setTimeout(close, 1400);
      } catch {
        status.className = 'report-status error';
        status.textContent = "Couldn't send. Check your connection and try again.";
        send.disabled = false;
      }
    });
  }

  /** Browser, screen and app details sent with every report. */
  _reportContext() {
    const main = document.querySelector('script[src*="main.js"]');
    const v = main ? new URL(main.src).searchParams.get('v') : '?';
    const s = this.activeSketch();
    return [
      `app: ${v}`,
      `page: ${location.href}`,
      `browser: ${navigator.userAgent}`,
      `screen: ${screen.width}x${screen.height} @${devicePixelRatio}, window ${innerWidth}x${innerHeight}`,
      `theme: ${this.themeName}, tool: ${this.toolName}`,
      `drawing: ${s ? s.entities.length : 0} entities, ${s ? s.constraints.length : 0} constraints, ${s ? s.fills.length : 0} fills, ${s ? s.strokes.length : 0} strokes, ${this.project.layers.length} layers`,
      `recent errors:\n${this._recentErrors.length ? this._recentErrors.join('\n') : 'none'}`,
    ].join('\n');
  }
}
