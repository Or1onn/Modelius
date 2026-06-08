// search.ts — case/diacritic-insensitive substring match + snippet for chat search.

// Fold to a lowercase, diacritic-stripped form while keeping a map back to the
// original char indices (per-char NFD can change length, so we can't assume 1:1).
function fold(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (let j = 0; j < ch.length; j++) {
      norm += ch[j];
      map.push(i);
    }
  }
  return { norm, map };
}

export function matches(text: string, q: string): boolean {
  const needle = fold(q).norm;
  if (!needle) return false;
  return fold(text).norm.includes(needle);
}

// A context window around the first match, with the original casing preserved.
// Returns null when there's no match. Whitespace is collapsed for readability.
export function snippet(
  text: string,
  q: string,
  ctx = 48
): { before: string; match: string; after: string } | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const { norm, map } = fold(clean);
  const needle = fold(q).norm;
  if (!needle) return null;
  const idx = norm.indexOf(needle);
  if (idx < 0) return null;

  const start = map[idx];
  const end = map[idx + needle.length - 1] + 1; // exclusive, include the last matched char
  const from = Math.max(0, start - ctx);
  const to = Math.min(clean.length, end + ctx);
  return {
    before: (from > 0 ? "…" : "") + clean.slice(from, start),
    match: clean.slice(start, end),
    after: clean.slice(end, to) + (to < clean.length ? "…" : ""),
  };
}
