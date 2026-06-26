// streamLLM.ts — dispatch a resolved backend to its provider stream.
import { streamChat, streamChatGPT } from "@/features/stream-completion/api/openai";
import { streamClaude } from "@/features/stream-completion/api/anthropic";
import { streamCompat } from "@/features/stream-completion/api/compat";
import type { Backend, ChatMsg, Delta } from "@/entities/model/model/backend";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export async function* streamLLM(
  backend: Backend,
  messages: ChatMsg[],
  thinking = false,
  effort: EffortLevel | "auto" = "auto",
  signal?: AbortSignal
): AsyncGenerator<Delta> {
  if (backend.kind === "openai") yield* streamChat(backend.model, messages, backend.label, thinking, signal);
  else if (backend.kind === "chatgpt") yield* streamChatGPT(backend.model, messages, backend.label, thinking, signal);
  else if (backend.kind === "anthropic") yield* streamClaude(backend.model, messages, backend.label, thinking, effort, signal);
  else if (backend.kind === "compat") yield* streamCompat(backend, messages, backend.label, thinking, effort, signal);
}
