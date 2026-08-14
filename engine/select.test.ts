import { describe, expect, it } from "vitest";
import type { ExerciseGenerator } from "../bank/generators/types.js";
import type { Exercise, Language } from "../bank/schema.js";
import { mulberry32 } from "./rng.js";
import { availableAxes, familyOf, hiddenByToolchain, resolveExercise, selectExercise, targetTier, type SelectOptions } from "./select.js";

/** Toolchain fakes: every test says out loud which graders the host can run. */
const JDK = { jdk: true };
const NO_JDK = { jdk: false };

function ex(id: string, tier: number, language: "python" | "javascript" | "java" = "python"): Exercise {
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

/** A java cloze: java content that no JVM ever grades. */
function clozeEx(id: string, axis: Exercise["axis"], language: "python" | "java"): Exercise {
  return {
    id,
    kind: "cloze",
    axis,
    language,
    tier: 1,
    title: id,
    prompt: "p",
    softTimeLimitSeconds: 60,
    testTimeoutMs: 10_000,
    snippet: "____",
    acceptedAnswers: ["a"],
  };
}

function fakeGen(family: string, tiers: number[], language: "python" | "javascript" | "java" = "python"): ExerciseGenerator {
  return {
    family,
    axis: "syntax-recall",
    kind: "write",
    language,
    tiers,
    generate: (seed, tier) => ({ ...ex(`${family}-${seed}`, tier, language), title: family }),
  };
}

function fakeClozeGen(family: string, language: "python" | "java"): ExerciseGenerator {
  return {
    family,
    axis: "api-memory",
    kind: "cloze",
    language,
    tiers: [1],
    generate: (seed) => clozeEx(`${family}-${seed}`, "api-memory", language),
  };
}

/** A family that renders language-agnostic drills (outline/recall shaped). */
const anyGen: ExerciseGenerator = {
  family: "dec-any-gen",
  axis: "decomposition",
  kind: "outline",
  language: "any",
  tiers: [1],
  generate: (seed, tier) => ({ ...outlineEx, id: `dec-any-gen-${seed}`, tier }),
};

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

describe("selectExercise - toolchain filtering", () => {
  const javaStatic = ex("sr-java-001", 1, "java"); // a write: javac + JVM to grade
  const javaGen = fakeGen("sr-java-cond", [1], "java");
  const mixed = [javaStatic, ex("sr-py-001", 1)];
  const opts = { axis: "syntax-recall" as const, rating: 1150, random: () => 0 };

  it("offers no JVM-graded java drill when the host has no JDK", () => {
    // write/fix/harness compile and run; predict-output runs through the source
    // launcher. Without a JDK none of them can produce a graded result, so offering
    // one only costs the user a drill that ends in an abandoned outcome.
    const pick = selectExercise({
      ...opts,
      statics: [javaStatic],
      generators: [javaGen],
      language: "java",
      toolchains: NO_JDK,
    });
    expect(pick).toBeUndefined();
  });

  it("offers them again once a JDK is present", () => {
    const pick = selectExercise({
      ...opts,
      statics: [javaStatic],
      generators: [javaGen],
      language: "java",
      toolchains: JDK,
    });
    expect(pick?.language).toBe("java");
  });

  it("drops java generator families too, not just static java", () => {
    const pick = selectExercise({ ...opts, statics: [], generators: [javaGen], language: "java", toolchains: NO_JDK });
    expect(pick).toBeUndefined();
  });

  it("keeps java drills that no JVM grades - a cloze is string-matched in-process", () => {
    const javaCloze = clozeEx("api-java-950", "syntax-recall", "java");
    const pick = selectExercise({
      ...opts,
      statics: [javaStatic, javaCloze],
      generators: [javaGen],
      language: "java",
      toolchains: NO_JDK,
    });
    expect(pick?.id).toBe("api-java-950");
  });

  it("keeps a java cloze family for the same reason", () => {
    const pick = selectExercise({
      statics: [],
      generators: [fakeClozeGen("api-java-blank", "java")],
      axis: "api-memory",
      rating: 1150,
      language: "java",
      random: () => 0,
      toolchains: NO_JDK,
    });
    expect(pick?.id.startsWith("api-java-blank-")).toBe(true);
  });

  it("leaves python and javascript alone - only java grading needs a JDK", () => {
    // No --lang here: the java half of the pool is dropped, the rest still drills.
    const pick = selectExercise({ ...opts, statics: mixed, toolchains: NO_JDK });
    expect(pick?.id).toBe("sr-py-001");
  });

  it("keeps language-agnostic families for a java request with no JDK", () => {
    // "any" content is graded in-process: a missing JDK says nothing about it.
    const pick = selectExercise({
      statics: [],
      generators: [anyGen],
      axis: "decomposition",
      rating: 1150,
      language: "java",
      random: () => 0,
      toolchains: NO_JDK,
    });
    expect(pick?.id.startsWith("dec-any-gen-")).toBe(true);
  });

  it("keeps a java-tagged recall on offer with no JDK, and off a python request", () => {
    // A recall about JVM flags is java content that starts no JVM: the tag steers --lang,
    // the JDK gate is only for the kinds that spawn one.
    const javaRecall: Exercise = {
      id: "api-java-recall-001",
      kind: "recall",
      axis: "api-memory",
      language: "java",
      tier: 1,
      title: "jvm flags",
      prompt: "p",
      softTimeLimitSeconds: 300,
      testTimeoutMs: 10_000,
      acceptedAnswers: ["-XX:+HeapDumpOnOutOfMemoryError"],
    };
    const draw = (language: "java" | "python") =>
      selectExercise({ statics: [javaRecall], axis: "api-memory", rating: 1150, language, random: () => 0, toolchains: NO_JDK });
    expect(draw("java")?.id).toBe("api-java-recall-001");
    expect(hiddenByToolchain({ statics: [javaRecall], axis: "api-memory", language: "java", toolchains: NO_JDK })).toBe(0);
    expect(draw("python")).toBeUndefined();
  });
});

describe("selectExercise - language mix soft-cap", () => {
  // One axis, one tier, one candidate per language: language weight is the only
  // thing separating draw shares in a sweep.
  const javaEx = ex("sr-java-101", 1, "java");
  const pyEx = ex("sr-py-101", 1);
  const anyEx: Exercise = { ...outlineEx, id: "sr-any-101", axis: "syntax-recall", tier: 1 };

  /** Seeded sweep: how many of n draws landed on each language. */
  function langShares(n: number, opts: Omit<SelectOptions, "random">, seed = 42): Record<string, number> {
    const rng = mulberry32(seed);
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const lang = selectExercise({ ...opts, random: rng })!.language;
      counts[lang] = (counts[lang] ?? 0) + 1;
    }
    return counts;
  }

  it("soft-caps a language holding at least three of the six-session window", () => {
    const pool = { statics: [javaEx, pyEx, anyEx], axis: "syntax-recall" as const, rating: 1150, toolchains: JDK };
    const capped = langShares(400, {
      ...pool,
      recentLanguages: ["java", "java", "java", "python", "javascript", "python"],
    });
    // java at x0.25 against python's 1: roughly a quarter of python's share, not parity
    expect(capped["java"] ?? 0).toBeLessThan((capped["python"] ?? 0) / 2);
    // no window, no policy: the three candidates split the sweep about evenly
    const free = langShares(400, pool);
    for (const lang of ["java", "python", "any"]) {
      expect(free[lang] ?? 0).toBeGreaterThan(100);
      expect(free[lang] ?? 0).toBeLessThan(170);
    }
  });

  it("explicit language bypasses the cap", () => {
    // --lang java is the user steering: an all-java history penalizes nothing.
    const shares = langShares(400, {
      statics: [javaEx, anyEx],
      axis: "syntax-recall",
      rating: 1150,
      toolchains: JDK,
      language: "java",
      recentLanguages: ["java", "java", "java", "java", "java", "java"],
    });
    expect(shares["java"] ?? 0).toBeGreaterThan(150);
    expect(shares["any"] ?? 0).toBeGreaterThan(150);
  });

  it("an all-dominant pool still serves the dominant language", () => {
    // Soft cap, not a filter: weights renormalize, so all-java still drills java.
    for (const r of [0, 0.5, 0.999999]) {
      const pick = selectExercise({
        statics: [javaEx, ex("sr-java-102", 1, "java")],
        generators: [fakeGen("sr-java-cond", [1], "java")],
        axis: "syntax-recall",
        rating: 1150,
        toolchains: JDK,
        random: () => r,
        recentLanguages: ["java", "java", "java", "java", "java", "java"],
      });
      expect(pick?.language).toBe("java");
    }
  });

  it("any-language candidates are never penalized", () => {
    // "any" holds half the window here: it must neither count toward dominance
    // nor pay java's penalty - so it takes java's lost share, about four to one.
    const shares = langShares(400, {
      statics: [javaEx, anyEx],
      axis: "syntax-recall",
      rating: 1150,
      toolchains: JDK,
      recentLanguages: ["java", "any", "java", "any", "java", "any"],
    });
    expect(shares["any"] ?? 0).toBeGreaterThan(3 * (shares["java"] ?? 0));
  });

  it("counts only the first six entries, and only at three or more", () => {
    const pool = { statics: [javaEx, pyEx], axis: "syntax-recall" as const, rating: 1150, toolchains: JDK };
    // java's three appearances sit beyond the six-entry window: python's three
    // inside it cap python, java goes free.
    const windowed = langShares(400, {
      ...pool,
      recentLanguages: ["python", "javascript", "python", "javascript", "python", "javascript", "java", "java", "java"],
    });
    expect((windowed["python"] ?? 0) * 2).toBeLessThan(windowed["java"] ?? 0);
    // two apiece is below the dominance threshold: nobody is capped
    const below = langShares(400, {
      ...pool,
      recentLanguages: ["java", "java", "python", "python", "javascript", "javascript"],
    });
    expect(below["java"] ?? 0).toBeGreaterThan(150);
    expect(below["python"] ?? 0).toBeGreaterThan(150);
  });

  it("absent recentLanguages preserves existing behavior draw-for-draw", () => {
    const draw = (recentLanguages?: (Language | "any")[]) => {
      const rng = mulberry32(7);
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(
          selectExercise({
            statics: [pyEx, javaEx, anyEx],
            generators: [fakeGen("sr-py-cond", [1]), fakeGen("sr-java-cond", [1], "java")],
            axis: "syntax-recall",
            rating: 1150,
            toolchains: JDK,
            random: rng,
            ...(recentLanguages ? { recentLanguages } : {}),
          })!.id,
        );
      }
      return ids;
    };
    // Pinned from the pre-soft-cap implementation (seed 7): with no window given,
    // selection must stay bit-for-bit what it was, rng consumption included.
    expect(draw()).toEqual([
      "sr-py-101",
      "sr-py-101",
      "sr-java-cond-b2f38a",
      "sr-py-cond-67d044",
      "sr-py-cond-3d6bbc",
      "sr-py-cond-bad59e",
      "sr-java-101",
      "sr-java-101",
      "sr-java-cond-84b606",
      "sr-java-101",
      "sr-any-101",
      "sr-any-101",
    ]);
    // a window that never reaches dominance is the same as no window at all
    expect(draw(["java", "python", "java", "python"])).toEqual(draw());
  });
});

describe("hiddenByToolchain", () => {
  const javaStatic = ex("sr-java-001", 1, "java");
  const javaGen = fakeGen("sr-java-cond", [1], "java");
  const base = {
    statics: [javaStatic, clozeEx("api-java-950", "syntax-recall", "java"), ex("sr-py-001", 1)],
    generators: [javaGen],
    axis: "syntax-recall" as const,
  };

  it("counts the JVM-graded java drills a missing JDK removed, statics and families alike", () => {
    expect(hiddenByToolchain({ ...base, toolchains: NO_JDK })).toBe(2); // the write + the family
  });

  it("counts nothing when the host has a JDK", () => {
    expect(hiddenByToolchain({ ...base, toolchains: JDK })).toBe(0);
  });

  it("counts nothing for a language whose drills were never offered here anyway", () => {
    expect(hiddenByToolchain({ ...base, language: "python", toolchains: NO_JDK })).toBe(0);
  });

  it("ignores other axes", () => {
    expect(hiddenByToolchain({ ...base, axis: "debugging", toolchains: NO_JDK })).toBe(0);
  });
});

describe("availableAxes", () => {
  const mk = (axis: string, language: string) =>
    ({ id: `x-${axis}-${language}`, kind: "cloze", axis, language, tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, testTimeoutMs: 10_000, snippet: "____", acceptedAnswers: ["a"] }) as unknown as Exercise;
  // api-memory's java content is a cloze (no JVM); syntax-recall's is a write (javac).
  const javaWrite = ex("sr-java-001", 1, "java");
  const bank = [javaWrite, mk("api-memory", "java"), mk("code-reading", "python"), { ...(mk("decomposition", "any") as object), kind: "outline", rubric: ["r"] } as unknown as Exercise];
  it("filters axes by language, counting language-any exercises for every filter", () => {
    // Toolchains are explicit here and below: the real probe would make these assertions
    // depend on whether the machine running the suite happens to have a JDK.
    expect(availableAxes(bank, "java", [], JDK)).toEqual(["syntax-recall", "api-memory", "decomposition"]);
    expect(availableAxes(bank, "python", [], JDK)).toEqual(["code-reading", "decomposition"]);
    expect(availableAxes(bank, undefined, [], JDK)).toEqual(["syntax-recall", "code-reading", "api-memory", "decomposition"]);
  });

  it("hides only the axes whose java content needs a JVM", () => {
    // syntax-recall goes (its java content is a write), api-memory stays (a cloze).
    expect(availableAxes(bank, "java", [], NO_JDK)).toEqual(["api-memory", "decomposition"]);
    expect(availableAxes(bank, undefined, [], NO_JDK)).toEqual(["code-reading", "api-memory", "decomposition"]);
  });
});

describe("availableAxes with generators", () => {
  const javaGen: ExerciseGenerator = {
    family: "sr-java-test",
    axis: "syntax-recall",
    kind: "write",
    language: "java",
    tiers: [1],
    generate() {
      throw new Error("never called by availableAxes");
    },
  };

  it("includes an axis whose only content for the language is a generator family", () => {
    expect(availableAxes([], "java", [javaGen], JDK)).toEqual(["syntax-recall"]);
  });

  it("still excludes axes with no static or generator content", () => {
    expect(availableAxes([], "java", [], JDK)).toEqual([]);
  });

  it("does not add axes for a non-matching language filter", () => {
    expect(availableAxes([], "python", [javaGen], JDK)).toEqual([]);
  });

  it("drops an axis whose only java family is JVM-graded when the host has no JDK", () => {
    expect(availableAxes([], "java", [javaGen], NO_JDK)).toEqual([]);
    // The declared kind is the whole filter here: availableAxes must never render a
    // variant to find out what a family produces.
    expect(availableAxes([], "java", [fakeClozeGen("api-java-blank", "java")], NO_JDK)).toEqual(["api-memory"]);
  });

  it("counts a language-any family for every language, java included", () => {
    expect(availableAxes([], "python", [anyGen], JDK)).toEqual(["decomposition"]);
    expect(availableAxes([], "java", [anyGen], JDK)).toEqual(["decomposition"]);
    expect(availableAxes([], undefined, [anyGen], JDK)).toEqual(["decomposition"]);
    // Not java content, so no JDK is no reason to hide it.
    expect(availableAxes([], "java", [anyGen], NO_JDK)).toEqual(["decomposition"]);
  });
});
