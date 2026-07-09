import { describe, it, expect } from "vitest";
import { scoreDifficulty, classify, route } from "@/features/route-request/model/route";
import { MODELS, type Model } from "@/entities/model/model/registry";

describe("scoreDifficulty", () => {
  it("keeps a short factual query trivial and confident", () => {
    const r = scoreDifficulty("what is the capital of France");
    expect(r.score).toBeLessThan(25);
    expect(r.isCode).toBe(false);
    expect(r.confident).toBe(true);
  });

  it("flags code queries via keyword/structure", () => {
    expect(scoreDifficulty("fix this python bug").isCode).toBe(true);
    expect(scoreDifficulty("const x = () => {};").isCode).toBe(true);
  });

  it("strips fenced blocks so a big paste with a simple ask stays low-skill", () => {
    const reasonInside = "summarize this:\n```\nwhy analyze design prove optimize compare\n```";
    // The reasoning verbs live inside the fence → stripped → they must not inflate the score.
    const r = scoreDifficulty(reasonInside);
    expect(r.score).toBeLessThan(scoreDifficulty("why analyze design prove optimize compare").score);
  });

  it("counts Cyrillic reasoning verbs (\\b doesn't work on Cyrillic)", () => {
    expect(scoreDifficulty("объясни почему и докажи алгоритм").score).toBeGreaterThan(0);
  });
});

describe("classify", () => {
  it("buckets by score/kind", () => {
    expect(classify("hi").kind).toBe("trivial");
    expect(classify("fix this python bug in my code").kind).toBe("code");
  });

  it("escalates a code+reasoning+stacktrace prompt to complex", () => {
    const hard =
      "Explain why this TypeError happens and design a fix:\n```js\nx.y()\n```\n" +
      "Analyze the algorithm, optimize it, compare the trade-offs. Why does it fail? Why now?";
    const c = classify(hard);
    expect(c.difficulty).toBeGreaterThanOrEqual(70);
    expect(c.kind).toBe("complex");
  });
});

describe("route", () => {
  it("quality policy picks the highest-capability model", () => {
    const d = route("hello", "quality");
    const maxCap = Math.max(...MODELS.map((m) => m.cap));
    expect(d.chosen.cap).toBe(maxCap);
  });

  it("cost policy never costs more than quality policy", () => {
    const cost = route("hello", "cost");
    const quality = route("hello", "quality");
    expect(cost.chosen.cost).toBeLessThanOrEqual(quality.chosen.cost);
  });

  it("speed policy picks a high-speed model", () => {
    const d = route("hello", "speed");
    const maxSpd = Math.max(...MODELS.map((m) => m.spd));
    // Speed also weighs latency/cap, but the pick should be near the top of the speed axis.
    expect(d.chosen.spd).toBeGreaterThanOrEqual(maxSpd - 5);
  });

  it("privacy policy stays on a local model", () => {
    expect(route("hello", "privacy").chosen.local).toBe(true);
  });

  it("privacy falls back to demo locals when the live pool has none", () => {
    const cloudOnly: Model[] = MODELS.filter((m) => !m.local).slice(0, 2);
    const d = route("hello", "privacy", { pool: cloudOnly });
    expect(d.chosen.local).toBe(true);
  });

  it("requireVision keeps the pick vision-capable", () => {
    expect(route("hello", "quality", { requireVision: true }).chosen.vision).toBe(true);
  });

  it("context-pressure floor drops models whose window can't hold the conversation", () => {
    const d = route("hello", "quality", { contextTokens: 900_000 });
    expect(d.chosen.ctx).toBe("1M");
  });
});
