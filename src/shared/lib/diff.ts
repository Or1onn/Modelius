// diff.ts — minimal line-level LCS diff for the unified artifact diff view.
export type DiffRow = { type: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number };

// Classic LCS over lines, then walk the table to emit rows in file order:
// ctx (unchanged), del (only in old), add (only in new).
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const rows: DiffRow[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "del", text: a[i], oldNo: oldNo++ });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], newNo: newNo++ });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++], oldNo: oldNo++ });
  while (j < m) rows.push({ type: "add", text: b[j++], newNo: newNo++ });
  return rows;
}
