import { describe, it, expect } from "vitest";
import { collectVersions } from "@/entities/artifact/lib/versions";
import type { Message } from "@/entities/model/model/registry";

// A large (>=15-line) block whose exported symbol drives the artifact title.
const block = (body: string) =>
  ["```ts", "export function foo() {", ...Array(13).fill("  // step"), `  return ${body};`, "}", "```"].join("\n");

const assistant = (text: string): Message => ({ role: "assistant", text });

describe("collectVersions", () => {
  it("groups same-titled artifacts into a version chain", () => {
    const map = collectVersions([assistant(block("1")), assistant(block("2"))]);
    const chain = map.get("foo.ts");
    expect(chain).toBeDefined();
    expect(chain!).toHaveLength(2);
    expect(chain![0].msgIndex).toBe(0);
    expect(chain![1].msgIndex).toBe(1);
  });

  it("collapses an unchanged repeat (same content id)", () => {
    const same = block("1");
    const map = collectVersions([assistant(same), assistant(same)]);
    expect(map.get("foo.ts")!).toHaveLength(1);
  });
});
