// save.ts — clipboard copy + file save (native dialog under Tauri, Blob download on web).
import { isTauri } from "@/shared/api/tauri";

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("clipboard unavailable"));
}

// Save text to a user-chosen file. Returns false if the native dialog was cancelled.
export async function saveToFile(text: string, suggestedName: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const ext = suggestedName.split(".").pop() ?? "txt";
    const path = await save({ defaultPath: suggestedName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return false; // user cancelled
    await writeTextFile(path, text);
    return true;
  }
  // Web fallback: trigger a download via a transient object URL.
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
