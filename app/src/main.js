import { App } from './app/App.js';

/* =============== BOOTSTRAP ==================================== */
const app = new App();
app.undoStack.push(JSON.stringify(app.project.toJSON()));
window._app = app;
