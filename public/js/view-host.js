/**
 * Keeps track of which view is on screen when renders overlap (a view can take a while to start,
 * e.g. the scanner waiting for the camera while the user already navigates elsewhere).
 *
 * `begin()` tears down the previous view and returns an id for the new render; the renderer ends
 * with `finish(id, cleanup)`. A render that finishes after a newer one began is stale: its cleanup
 * runs at once, so its camera, timers or listeners never outlive its screen.
 */
export function createViewHost() {
  let current = 0;
  let cleanup = null;

  const run = fn => {
    try { fn?.(); } catch (err) { console.error(err); } // a broken cleanup must not block navigation
  };

  return {
    begin() {
      const previous = cleanup;
      cleanup = null;
      run(previous);
      return ++current;
    },
    isCurrent(id) {
      return id === current;
    },
    /** Stores the cleanup of the finished view; returns false (after running it) when the view is stale. */
    finish(id, teardown) {
      if (id !== current) {
        run(teardown);
        return false;
      }
      cleanup = teardown || null;
      return true;
    },
  };
}
