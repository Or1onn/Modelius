// drafts.ts — per-chat composer draft, kept in memory so it survives a chat/screen switch (ChatScreen remounts on switch).
const drafts = new Map<string, string>();

export const getDraft = (chatId: string): string => drafts.get(chatId) ?? "";

export function setDraft(chatId: string, text: string): void {
  if (text) drafts.set(chatId, text);
  else drafts.delete(chatId);
}

export const clearDraft = (chatId: string): void => void drafts.delete(chatId);
