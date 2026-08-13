import { describe, expect, it } from "vitest";
import type { ExerciseGenerator } from "../bank/generators/types.js";
import type { Exercise } from "../bank/schema.js";
import { availableAxes, familyOf, resolveExercise, selectExercise, targetTier } from "./select.js";

function ex(id: string, tier: number, language: "python" | "javascript" = "python"): Exercise {
  return {
    id,
    kind: "write",
    axis: "syntax-recall",
    language,
    tier,
    title: id,
    prompt: "p",
    functionName: "f",
    starterCode: "s",
    softTimeLimitSeconds: 300,
    testTimeoutMs: 10_000,
    tests: [{ args: [], expected: null }],
  };
}

const outlineEx: Exercise = {
  id: "dec-any-001",
  kind: "outline",
  axis: "decomposition",
  language: "any",
  tier: 1,
  title: "outline",
  prompt: "p",
  softTimeLimitSeconds: 420,
  testTimeoutMs: 10_000,
  rubric: ["a"],
};

function fakeGen(family: string, tiers: number[], language: "python" | "javascript" = "python"): ExerciseGenerator {
  return {
    family,
    axis: "syntax-recall",
    language,
    tiers,
    generate: (seed, tier) => ({ ...ex(`${family}-${seed}`, tier, language), title: family }),
  };
}

const statics = [ex("sr-py-001", 1), ex("sr-py-002", 2), ex("sr-py-003", 2), ex("sr-js-001", 1, "javascript"), outlineEx];

describe("targetTier", () => {
  it("targets the most informative tier as rating grows", () => {
    expect(targetTier(1150)).toBe(1);
    expect(targetTier(1300)).toBe(2);
    expect(targetTier(1500)).toBe(3);
  });
});

describe("familyOf", () => {
  it("strips generated seeds, leaves static ids alone", () => {
    expect(familyOf("sr-py-cond-1a2b3c")).toBe("sr-py-cond");
    expect(familyOf("sr-py-001")).toBe("sr-py-001");
    expect(familyOf("api-js-gen-0dd001")).toBe("api-js-gen");
  });
});

describe("resolveExercise", () => {
  const gens = [fakeGen("sr-py-cond", [1, 2])];

  it("resolves a static bank id", () => {
    expect(resolveExercise("sr-py-002", { statics })?.id).toBe("sr-py-002");
  });

  it("reconstructs a generated exercise at the requested tier", () => {
    const got = resolveExercise("sr-py-cond-1a2b3c", { statics, generators: gens, tier: 2 });
    expect(got?.id).toBe("sr-py-cond-1a2b3c");
    expect(got?.tier).toBe(2);
  });

  it("defaults to the family's first tier when none is given", () => {
    expect(resolveExercise("sr-py-cond-1a2b3c", { statics, generators: gens })?.tier).toBe(1);
  });

  it("prefers a static id even if it looks generated", () => {
    const withLookalike = [...statics, ex("sr-py-abc123", 3)];
    const got = resolveExercise("sr-py-abc123", { statics: withLookalike, generators: gens });
    expect(got?.tier).toBe(3); // the static, not a generated tier-1 default
  });

  it("returns undefined for an unknown id or missing family", () => {
    expect(resolveExercise("nope-000000", { statics, generators: gens })).toBeUndefined();
    expect(resolveExercise("totally-unknown", { statics })).toBeUndefined();
  });
});

describe("selectExercise", () => {
  it("prefers the rating-targeted tier", () => {
    const pick = selectExercise({ statics, axis: "syntax-recall", rating: 1300, random: () => 0 });
    expect(pick?.tier).toBe(2);
  });

  it("falls back to the nearest tier when the target is empty", () => {
    const pick = selectExercise({ statics, axis: "syntax-recall", rating: 1500, random: () => 0 });
    expect(pick?.tier).toBe(2); // no tier-3 material yet
  });

  it("materializes a generator variant at the requested tier", () => {
    const g = fakeGen("sr-py-cond", [1, 2]);
    const pick = selectExercise({
      statics: [],
      generators: [g],
      axis: "syntax-recall",
      rating: 1300,
      random: () => 0.5,
    });
    expect(pick?.id.startsWith("sr-py-cond-")).toBe(true);
    expect(pick?.tier).toBe(2);
  });

  it("avoids recently seen families - static and generated alike", () => {
    const g = fakeGen("sr-py-cond", [2]);
    const pick = selectExercise({
      statics,
      generators: [g],
      axis: "syntax-recall",
      rating: 1300,
      recentIds: ["sr-py-cond-9a8b7c", "sr-py-002"],
      random: () => 0,
    });
    expect(pick?.id).toBe("sr-py-003");
  });

  it("repeats rather than starving when everything is recent", () => {
    const pick = selectExercise({
      statics,
      axis: "syntax-recall",
      rating: 1300,
      recentIds: ["sr-py-002", "sr-py-003"],
      random: () => 0,
    });
    expect(pick?.tier).toBe(2);
  });

  it("filters generators and statics by language", () => {
    const g = fakeGen("sr-js-cond", [1], "javascript");
    const pick = selectExercise({
      statics,
      generators: [g],
      axis: "syntax-recall",
      rating: 1150,
      language: "javascript",
      random: () => 0.99,
    });
    expect(pick && (pick.language === "javascript" || pick.language === "any")).toBe(true);
  });

  it("language-agnostic exercises match any language filter", () => {
    const pick = selectExercise({
      statics,
      axis: "decomposition",
      rating: 1200,
      language: "javascript",
      random: () => 0,
    });
    expect(pick?.id).toBe("dec-any-001");
  });

  it("returns undefined for an axis with no material", () => {
    expect(selectExercise({ statics, axis: "debugging", rating: 1200 })).toBeUndefined();
  });
});

describe("availableAxes", () => {
  const mk = (axis: string, language: string) =>
    ({ id: `x-${axis}-${language}`, kind: "cloze", axis, language, tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, testTimeoutMs: 10_000, snippet: "____", acceptedAnswers: ["a"] }) as unknown as Exercise;
  const bank = [mk("api-memory", "java"), mk("code-reading", "python"), { ...(mk("decomposition", "any") as object), kind: "outline", rubric: ["r"] } as unknown as Exercise];
  it("filters axes by language, counting language-any exercises for every filter", () => {
    expect(availableAxes(bank, "java")).toEqual(["api-memory", "decomposition"]);
    expect(availableAxes(bank, "python")).toEqual(["code-reading", "decomposition"]);
    expect(availableAxes(bank)).toEqual(["code-reading", "api-memory", "decomposition"]);
  });
});
