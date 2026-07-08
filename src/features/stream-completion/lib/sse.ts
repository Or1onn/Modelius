// sse.ts — browser-fetch SSE reader shared by the direct (non-Tauri) streaming paths.
// Guards the response status, then yields each parsed `data:` JSON payload until [DONE].
// Keep-alive / partial lines (unparseable JSON) are skipped.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function* sseJson(res: Response, label: string): AsyncGenerator<any> {
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    // A numeric retry-after lands in the message in the same format the Rust proxy uses,
    // so the error humanizer picks it up on both paths.
    const retry = Number(res.headers.get("retry-after"));
    const suffix = Number.isFinite(retry) && retry > 0 ? ` (retry-after: ${retry}s)` : "";
    throw new Error(`${label} ${res.status}${suffix}: ${detail.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // keep-alive / partial line
      }
      yield json;
    }
  }
}
