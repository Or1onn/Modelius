// seed.ts — the scripted demo thread shown on a first-ever launch.
import { route } from "@/features/route-request/model/route";
import { answerFor } from "@/shared/fixtures/demo";
import type { Message } from "@/entities/model/model/registry";

export const SEED_MESSAGES: Message[] = [
  { role: "user", text: "What's a clean regex for validating email addresses?" },
  {
    role: "assistant",
    text: answerFor("regex email"),
    decision: route("What's a clean regex for validating email addresses?", "cost"),
  },
];
