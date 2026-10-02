const MIN_VISIBLE_PX = 2;

/**
 * Pixel heights for a bar chart: the largest value gets `maxPx`, the others scale with it, zeros
 * stay empty and any other value stays at least two pixels tall so it remains visible.
 */
export function barHeights(counts, maxPx) {
  const max = Math.max(0, ...counts);
  if (max === 0) return counts.map(() => 0);
  return counts.map(count => (count <= 0 ? 0 : Math.max(MIN_VISIBLE_PX, Math.round((count / max) * maxPx))));
}
