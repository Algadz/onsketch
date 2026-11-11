export const UI_ICONS = {
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M7.4 7.4C4.3 9.1 2.5 12 2.5 12s3.5 6 9.5 6c1.8 0 3.3-.5 4.6-1.2"/><path d="M10.2 6.2c.6-.1 1.2-.2 1.8-.2 6 0 9.5 6 9.5 6s-.8 1.4-2.3 2.8"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/>',
  mirror: '<path d="M12 4v16"/><path d="M5 7l5 5-5 5z"/><path d="M19 7l-5 5 5 5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  none: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  flip: '<path d="M7 7h10l-3-3M17 17H7l3 3"/><path d="M7 7l10 10"/>'
};
export function uiIcon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || ''}</svg>`;
}
