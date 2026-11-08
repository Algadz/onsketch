import { App } from './app/App.js';

/* =============== BOOTSTRAP ==================================== */
const root = document.documentElement;
try {
  const app = new App();
  app.undoStack.push(JSON.stringify(app.project.toJSON()));
  window._app = app;
  app.openExampleFromURL();
  // Reveal the interface once the windows have been placed (WindowManager
  // lays them out on the next frame), with a short fade.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.remove('booting');
    root.classList.add('ui-in');
    setTimeout(() => root.classList.remove('ui-in'), 400);
  }));
} catch (e) {
  console.error(e);
  const msg = document.querySelector('#boot span');
  if (msg) msg.innerHTML = 'The editor could not start. <a href="">Reload</a> or use “Report a problem”.';
  root.classList.add('boot-slow');
  throw e;
}
