export const UI_ICONS = {
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M7.4 7.4C4.3 9.1 2.5 12 2.5 12s3.5 6 9.5 6c1.8 0 3.3-.5 4.6-1.2"/><path d="M10.2 6.2c.6-.1 1.2-.2 1.8-.2 6 0 9.5 6 9.5 6s-.8 1.4-2.3 2.8"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/>',
  mirror: '<path d="M12 4v16"/><path d="M5 7l5 5-5 5z"/><path d="M19 7l-5 5 5 5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  flip: '<path d="M7 7h10l-3-3M17 17H7l3 3"/><path d="M7 7l10 10"/>'
};
export function uiIcon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || ''}</svg>`;
}
