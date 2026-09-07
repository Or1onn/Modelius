import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { attachmentsOf } from "@/features/run-agent/lib/codeChatRegistry";

// What the composer stages ends up as AI SDK `file` parts; this is the extraction the transport
// hands to the Rust side (agent.rs AttachmentInput). Images and PDFs ride inline, nothing else.
const msg = (parts: unknown[]): UIMessage => ({ id: "m1", role: "user", parts } as UIMessage);

describe("attachmentsOf", () => {
  it("extracts images and PDFs with their raw base64 and name", () => {
    expect(
      attachmentsOf(
        msg([
          { type: "text", text: "look" },
          { type: "file", mediaType: "image/png", filename: "shot.png", url: "data:image/png;base64,QUJD" },
          { type: "file", mediaType: "application/pdf", filename: "spec.pdf", url: "data:application/pdf;base64,JVBERi0=" },
        ])
      )
    ).toEqual([
      { mime: "image/png", data: "QUJD", name: "shot.png" },
      { mime: "application/pdf", data: "JVBERi0=", name: "spec.pdf" },
    ]);
  });

  it("ignores other MIME types and non-data URLs", () => {
    expect(
      attachmentsOf(
        msg([
          { type: "file", mediaType: "text/plain", filename: "a.txt", url: "data:text/plain;base64,QQ==" },
          { type: "file", mediaType: "application/pdf", filename: "remote.pdf", url: "https://example.com/a.pdf" },
        ])
      )
    ).toEqual([]);
  });

  it("returns nothing for a message with no parts", () => {
    expect(attachmentsOf(undefined)).toEqual([]);
  });
});
