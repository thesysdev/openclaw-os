/**
 * Walk the browser history one step (so back from a chat opened via Refine
 * returns to the app/artifact you came from). Falls back to `defaultNav`
 * when there's no prior in-app entry.
 */
export function smartBack(defaultNav: () => void): () => void {
  return () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    defaultNav();
  };
}
