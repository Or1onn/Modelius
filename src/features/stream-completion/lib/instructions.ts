// instructions.ts — the system contract shared by every provider adapter: the thread's system
// message (which carries the summary block after compaction), or the default prompt, plus an
// optional model self-id line so the model reports its real name instead of guessing.
import { SYSTEM_PROMPT } from "@/shared/config/prompts";
import type { ChatMsg } from "@/entities/model/model/backend";

export const systemBase = (messages: ChatMsg[]): string =>
  messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;

export const systemInstructions = (messages: ChatMsg[], modelName?: string): string => {
  const base = systemBase(messages);
  return modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
};
