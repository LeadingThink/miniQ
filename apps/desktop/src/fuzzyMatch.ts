export interface FuzzyMatch {
  score: number;
  /** Indices in the candidate string that matched the query characters. */
  indices: number[];
}

/**
 * Subsequence fuzzy matcher tuned for short palette labels. Contiguous runs,
 * word starts and prefix matches score higher; a plain substring hit always
 * outranks a scattered subsequence. Returns null when the query does not match.
 */
export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  const haystack = candidate.toLowerCase();

  const substring = haystack.indexOf(needle);
  if (substring >= 0) {
    const indices = Array.from({ length: needle.length }, (_, offset) => substring + offset);
    const prefixBonus = substring === 0 ? 40 : isWordStart(candidate, substring) ? 20 : 0;
    return { score: 100 + needle.length * 4 + prefixBonus - substring * 0.5, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const char of needle) {
    if (char === " ") continue;
    const index = haystack.indexOf(char, from);
    if (index < 0) return null;
    const previous = indices[indices.length - 1];
    if (previous !== undefined && index === previous + 1) score += 6;
    else if (isWordStart(candidate, index)) score += 4;
    else score += 1;
    if (previous !== undefined) score -= Math.min(4, (index - previous - 1) * 0.25);
    indices.push(index);
    from = index + 1;
  }
  return { score, indices };
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  const current = text[index];
  if (/[\s\-_/.·:]/.test(before)) return true;
  // camelCase boundary
  return /[a-z]/.test(before) && /[A-Z]/.test(current);
}

/** Split text into plain / highlighted segments for rendering. */
export function highlightSegments(
  text: string,
  indices: number[],
): Array<{ text: string; match: boolean }> {
  if (indices.length === 0) return [{ text, match: false }];
  const marked = new Set(indices);
  const segments: Array<{ text: string; match: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const match = marked.has(index);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text[index];
    else segments.push({ text: text[index], match });
  }
  return segments;
}
