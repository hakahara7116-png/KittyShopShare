/** Lightweight product-name similarity: shared meaningful words, ignoring sizes and filler. */
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'for', 'about', 'pack', 'lb', 'lbs', 'oz', 'kg', 'g', 'x', 'case', 'box', 'bag', 'sack', 'share', 'whole', 'fresh']);
export function tokens(name: string): Set<string> {
  return new Set(name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map(w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''))
    .filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)));
}
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return inter / Math.min(A.size, B.size); // overlap coefficient: "beef" matches "quarter beef share"
}
export const SIMILAR_THRESHOLD = 0.6;
