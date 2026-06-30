// versions.ts — group a chat's artifacts into version chains by title, so the
// ArtifactPanel can diff a file against its previous version (GitHub-style).
import { codeSegs } from "@/shared/lib/markdown";
import type { Message } from "@/entities/model/model/registry";
import { isLargeBlock, isFileArtifact, makeArtifact, type Artifact } from "@/entities/artifact/model/artifacts";

// A single occurrence of a titled artifact, with its locator into the thread.
export type Version = { art: Artifact; msgIndex: number; blockIndex: number };

// Walk messages in order; collect blocks that surface as cards (same test as ChatThread:
// user → large OR attached file, assistant → large) and group them by title. Consecutive
// versions with identical content (same id) collapse — a repeat isn't a new version.
export function collectVersions(messages: Message[]): Map<string, Version[]> {
  const out = new Map<string, Version[]>();
  messages.forEach((msg, msgIndex) => {
    const body = msg.streaming ? msg.shown || "" : msg.text;
    codeSegs(body).forEach((seg, blockIndex) => {
      const asCard = msg.role === "user" ? isLargeBlock(seg.code) || isFileArtifact(seg.code) : isLargeBlock(seg.code);
      if (!asCard) return;
      const art = makeArtifact(seg.lang, seg.code);
      const list = out.get(art.title) ?? [];
      if (list.length && list[list.length - 1].art.id === art.id) return; // unchanged repeat
      list.push({ art, msgIndex, blockIndex });
      out.set(art.title, list);
    });
  });
  return out;
}
