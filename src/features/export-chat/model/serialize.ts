// serialize.ts — turn a chat's message list into shareable Markdown / JSON.
import type { Message } from "@/entities/model/model/registry";

export interface ExportMeta {
  title: string;
  createdAt?: number;
}

// Model that answered a turn: routed pick name, else a manual-pick label.
const modelName = (m: Message): string => m.decision?.chosen.name ?? m.modelLabel ?? "";

const roleLabel = (m: Message): string =>
  m.role === "user" ? "User" : `Assistant${modelName(m) ? ` (${modelName(m)})` : ""}`;

// `m.text` is already Markdown (code fences inline), so prose + artifacts serialize verbatim.
export function toMarkdown(messages: Message[], meta: ExportMeta): string {
  const when = new Date(meta.createdAt ?? Date.now()).toLocaleString();
  const head = `# ${meta.title || "Chat"}\n\n*${when}*\n`;
  const body = messages
    .map((m) => {
      const imgs = m.images?.length ? "\n\n" + m.images.map((im) => `![${im.name}](${im.dataUrl})`).join("\n") : "";
      return `## ${roleLabel(m)}\n\n${m.text}${imgs}`;
    })
    .join("\n\n---\n\n");
  return `${head}\n${body}\n`;
}

export function toJSON(messages: Message[], meta: ExportMeta): string {
  const clean = messages.map((m) => ({
    role: m.role,
    text: m.text,
    model: modelName(m) || undefined,
    images: m.images?.map((im) => ({ name: im.name, mime: im.mime })),
    usage: m.usage,
    cost: m.cost,
  }));
  return JSON.stringify({ title: meta.title, createdAt: meta.createdAt, messages: clean }, null, 2);
}
