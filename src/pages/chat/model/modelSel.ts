// modelSel.ts — per-chat manual model pick, kept in memory so it survives a chat/screen switch
// (ChatScreen remounts on switch). null = Auto (routed).
import type { ModelOption } from "@/entities/model/model/backend";

const selections = new Map<string, ModelOption>();

export const getModelSel = (chatId: string): ModelOption | null => selections.get(chatId) ?? null;

export function setModelSel(chatId: string, sel: ModelOption | null): void {
  if (sel) selections.set(chatId, sel);
  else selections.delete(chatId);
}
