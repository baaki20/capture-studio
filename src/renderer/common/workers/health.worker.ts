/** Minimal worker used by the shell to check that worker bundling and CSP are set up correctly. */
self.onmessage = () => {
  self.postMessage({ type: 'pong', at: performance.now() });
};
