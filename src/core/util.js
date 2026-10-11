// Tiny generic utilities — no framework, no globals.

// Debounce: delay fn until `ms` of silence. The returned wrapper exposes
// .cancel() so callers can drop a pending call on unmount/teardown.
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
