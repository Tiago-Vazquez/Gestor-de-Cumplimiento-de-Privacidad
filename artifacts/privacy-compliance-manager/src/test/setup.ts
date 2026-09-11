import '@testing-library/jest-dom/vitest';

// ResizeObserver polyfill for Recharts ResponsiveContainer in jsdom
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock;
window.ResizeObserver = ResizeObserverMock;

// vaul (drawer) usa pointer capture en su capa de drag-to-close; jsdom no lo
// implementa. Polyfill neutro para tests que interactúan dentro del drawer.
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
  configurable: true,
  value: () => {},
});
Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
  configurable: true,
  value: () => {},
});
Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
  configurable: true,
  value: () => false,
});
