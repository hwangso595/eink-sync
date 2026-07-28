// Obsidian runs plugins in a browser-capable Electron window. Mirror the timer
// surface in Jest's Node environment so window.setTimeout/clearTimeout behave
// the same way in unit tests.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: globalThis,
});
