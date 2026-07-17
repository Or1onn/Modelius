// Last message of `role` (optionally also matching `pred`), scanning from the end without
// the [...messages].reverse() copy the call sites used to pay.
export function lastOfRole<T extends { role: string }>(
  messages: readonly T[],
  role: string,
  pred?: (m: T) => boolean
): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === role && (!pred || pred(m))) return m;
  }
  return undefined;
}
