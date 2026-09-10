import '@testing-library/jest-dom/vitest';

// ResizeObserver polyfill for Recharts ResponsiveContainer in jsdom
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock;
window.ResizeObserver = ResizeObserverMock;
