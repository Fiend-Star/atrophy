import { describe, expect, it } from "vitest";
import type { ExerciseGenerator } from "../bank/generators/types.js";
import type { Exercise, Language } from "../bank/schema.js";
import { mulberry32 } from "./rng.js";
import {
  EVERY_TOOLCHAIN,
  availableAxes,
  familyOf,
  hiddenByLanguages,
  hiddenByToolchain,
  resolveExercise,
  selectExercise,
  targetTier,
  type SelectOptions,
} from "./select.js";

/**
 * Toolchain fakes: every test says out loud which graders the host can run. Two
 * toolchains now, so every fake names both - a java assertion that left `bash` to the
 * host would drift the day shell content lands in its pool.
 */
const ALL = { jdk: true, bash: true };
const NO_JDK = { jdk: false, bash: true };
const NO_BASH = { jdk: true, bash: false };
const NEITHER = { jdk: false, bash: false };

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

/** A cloze: code-language content that no toolchain ever grades (string-matched here). */
function clozeEx(id: string, axis: Exercise["axis"], language: Language): Exercise {
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

/** A shell write: `shellCases` instead of tests, and the one shell kind bash has to run. */
function shellWriteEx(id: string, axis: Exercise["axis"] = "syntax-recall", tier = 1): Exercise {
  return {
    id,
    kind: "write",
    axis,
    language: "shell",
    tier,
    title: id,
    prompt: "p",
    starterCode: "#!/usr/bin/env bash\n",
    softTimeLimitSeconds: 300,
    testTimeoutMs: 10_000,
    shellCases: [{ expectedStdout: "1" }, { expectedStdout: "2" }],
  };
}

/** A shell recall: shell-tagged content that starts no shell. */
function shellRecallEx(id: string, axis: Exercise["axis"] = "syntax-recall"): Exercise {
  return {
    id,
    kind: "recall",
    axis,
    language: "shell",
    tier: 1,
    title: id,
    prompt: "p",
    softTimeLimitSeconds: 300,
    testTimeoutMs: 10_000,
    acceptedAnswers: ["a"],
  };
}

function shellWriteGen(family: string, axis: Exercise["axis"] = "syntax-recall"): ExerciseGenerator {
  return {
    family,
    axis,
    kind: "write",
    language: "shell",
    tiers: [1],
    generate: (seed, tier) => shellWriteEx(`${family}-${seed}`, axis, tier),
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
      toolchains: ALL,
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
    expect(hiddenByToolchain({ statics: [javaRecall], axis: "api-memory", language: "java", toolchains: NO_JDK })).toEqual({ jdk: 0, bash: 0 });
    expect(draw("python")).toBeUndefined();
  });
});

describe("selectExercise - bash toolchain filtering", () => {
  const shellWrite = shellWriteEx("sr-sh-001"); // a write: a real bash runs the script
  const shellGen = shellWriteGen("sr-sh-count");
  const javaWrite = ex("sr-java-001", 1, "java");
  const opts = { axis: "syntax-recall" as const, rating: 1150, random: () => 0 };

  it("offers no shell write when the host has no bash", () => {
    // write is shell's only graded-code kind, and grading it means running the script:
    // without a bash the drill can only end in a harnessError, which is never evidence.
    const pick = selectExercise({
      ...opts,
      statics: [shellWrite],
      generators: [shellGen],
      language: "shell",
      toolchains: NO_BASH,
    });
    expect(pick).toBeUndefined();
  });

  it("offers them again once bash is present", () => {
    const pick = selectExercise({
      ...opts,
      statics: [shellWrite],
      generators: [shellGen],
      language: "shell",
      toolchains: ALL,
    });
    expect(pick?.language).toBe("shell");
  });

  it("keeps the shell drills bash never runs - cloze and recall are matched in-process", () => {
    for (const stat of [clozeEx("api-sh-950", "syntax-recall", "shell"), shellRecallEx("sr-sh-950")]) {
      const pick = selectExercise({
        ...opts,
        statics: [shellWrite, stat],
        generators: [shellGen],
        language: "shell",
        toolchains: NO_BASH,
      });
      expect(pick?.id).toBe(stat.id);
    }
  });

  it("gates the two toolchains independently", () => {
    // A missing bash says nothing about a JVM drill, and a missing JDK nothing about a script.
    expect(selectExercise({ ...opts, statics: [javaWrite], language: "java", toolchains: NO_BASH })?.id).toBe(
      "sr-java-001",
    );
    expect(selectExercise({ ...opts, statics: [shellWrite], language: "shell", toolchains: NO_JDK })?.id).toBe(
      "sr-sh-001",
    );
  });

  it("hides both runnable kinds when neither toolchain is there, and still drills python", () => {
    const pick = selectExercise({
      ...opts,
      statics: [javaWrite, shellWrite, ex("sr-py-001", 1)],
      toolchains: NEITHER,
    });
    expect(pick?.id).toBe("sr-py-001");
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
    const pool = { statics: [javaEx, pyEx, anyEx], axis: "syntax-recall" as const, rating: 1150, toolchains: ALL };
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
      toolchains: ALL,
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
        toolchains: ALL,
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
      toolchains: ALL,
      recentLanguages: ["java", "any", "java", "any", "java", "any"],
    });
    expect(shares["any"] ?? 0).toBeGreaterThan(3 * (shares["java"] ?? 0));
  });

  it("counts only the first six entries, and only at three or more", () => {
    const pool = { statics: [javaEx, pyEx], axis: "syntax-recall" as const, rating: 1150, toolchains: ALL };
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
            toolchains: ALL,
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
    expect(hiddenByToolchain({ ...base, toolchains: NO_JDK })).toEqual({ jdk: 2, bash: 0 }); // the write + the family
  });

  it("counts nothing when the host has every toolchain", () => {
    expect(hiddenByToolchain({ ...base, toolchains: ALL })).toEqual({ jdk: 0, bash: 0 });
  });

  it("counts nothing for a language whose drills were never offered here anyway", () => {
    expect(hiddenByToolchain({ ...base, language: "python", toolchains: NEITHER })).toEqual({ jdk: 0, bash: 0 });
  });

  it("ignores other axes", () => {
    expect(hiddenByToolchain({ ...base, axis: "debugging", toolchains: NEITHER })).toEqual({ jdk: 0, bash: 0 });
  });

  it("counts shell writes under bash, and the in-process shell kinds not at all", () => {
    const pool = {
      statics: [shellWriteEx("sr-sh-001"), shellRecallEx("sr-sh-950"), clozeEx("sr-sh-951", "syntax-recall", "shell")],
      generators: [shellWriteGen("sr-sh-count")],
      axis: "syntax-recall" as const,
    };
    expect(hiddenByToolchain({ ...pool, toolchains: NO_BASH })).toEqual({ jdk: 0, bash: 2 }); // the write + the family
    expect(hiddenByToolchain({ ...pool, toolchains: ALL })).toEqual({ jdk: 0, bash: 0 });
  });

  const twoToolchainPool = {
    statics: [
      ex("sr-java-001", 1, "java"),
      ex("sr-java-002", 1, "java"),
      shellWriteEx("sr-sh-001"),
      shellRecallEx("sr-sh-950"),
      ex("sr-py-001", 1),
    ],
    generators: [fakeGen("sr-java-cond", [1], "java"), shellWriteGen("sr-sh-count")],
    axis: "syntax-recall" as const,
  };

  it("puts every hidden drill in exactly one bucket when both toolchains are missing", () => {
    // Seven candidates on the axis; the python write and the shell recall survive, so
    // five vanish: three java (two writes + the family) and two shell (write + family).
    const hidden = hiddenByToolchain({ ...twoToolchainPool, toolchains: NEITHER });
    expect(hidden).toEqual({ jdk: 3, bash: 2 });
    // The anti-double-count law, stated as an identity: what the two toolchains hide
    // together is exactly what each hides alone - nothing is billed to both.
    const jdkOnly = hiddenByToolchain({ ...twoToolchainPool, toolchains: NO_JDK });
    const bashOnly = hiddenByToolchain({ ...twoToolchainPool, toolchains: NO_BASH });
    expect(hidden.jdk + hidden.bash).toBe(jdkOnly.jdk + bashOnly.bash);
    expect(jdkOnly).toEqual({ jdk: 3, bash: 0 });
    expect(bashOnly).toEqual({ jdk: 0, bash: 2 });
  });

  it("counts only what the requested language could have been offered", () => {
    expect(hiddenByToolchain({ ...twoToolchainPool, language: "shell", toolchains: NEITHER })).toEqual({
      jdk: 0,
      bash: 2,
    });
    expect(hiddenByToolchain({ ...twoToolchainPool, language: "java", toolchains: NEITHER })).toEqual({
      jdk: 3,
      bash: 0,
    });
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
    expect(availableAxes(bank, "java", [], ALL)).toEqual(["syntax-recall", "api-memory", "decomposition"]);
    expect(availableAxes(bank, "python", [], ALL)).toEqual(["code-reading", "decomposition"]);
    expect(availableAxes(bank, undefined, [], ALL)).toEqual(["syntax-recall", "code-reading", "api-memory", "decomposition"]);
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
    expect(availableAxes([], "java", [javaGen], ALL)).toEqual(["syntax-recall"]);
  });

  it("still excludes axes with no static or generator content", () => {
    expect(availableAxes([], "java", [], ALL)).toEqual([]);
  });

  it("does not add axes for a non-matching language filter", () => {
    expect(availableAxes([], "python", [javaGen], ALL)).toEqual([]);
  });

  it("drops an axis whose only java family is JVM-graded when the host has no JDK", () => {
    expect(availableAxes([], "java", [javaGen], NO_JDK)).toEqual([]);
    // The declared kind is the whole filter here: availableAxes must never render a
    // variant to find out what a family produces.
    expect(availableAxes([], "java", [fakeClozeGen("api-java-blank", "java")], NO_JDK)).toEqual(["api-memory"]);
  });

  it("counts a language-any family for every language, java included", () => {
    expect(availableAxes([], "python", [anyGen], ALL)).toEqual(["decomposition"]);
    expect(availableAxes([], "java", [anyGen], ALL)).toEqual(["decomposition"]);
    expect(availableAxes([], undefined, [anyGen], ALL)).toEqual(["decomposition"]);
    // Not java content, so no JDK is no reason to hide it.
    expect(availableAxes([], "java", [anyGen], NO_JDK)).toEqual(["decomposition"]);
  });
});

describe("availableAxes - bash", () => {
  const bank = [shellWriteEx("sr-sh-001", "syntax-recall"), shellRecallEx("api-sh-950", "api-memory")];

  it("drops an axis whose only shell content is a write when the host has no bash", () => {
    expect(availableAxes(bank, "shell", [], ALL)).toEqual(["syntax-recall", "api-memory"]);
    // syntax-recall goes (a script has to run), api-memory stays (a recall is typed).
    expect(availableAxes(bank, "shell", [], NO_BASH)).toEqual(["api-memory"]);
  });

  it("drops a shell write family the same way", () => {
    expect(availableAxes([], "shell", [shellWriteGen("sr-sh-count")], ALL)).toEqual(["syntax-recall"]);
    expect(availableAxes([], "shell", [shellWriteGen("sr-sh-count")], NO_BASH)).toEqual([]);
  });
});

describe("selectExercise - allowedLanguages", () => {
  const javaEx = ex("sr-java-701", 1, "java");
  const pyEx = ex("sr-py-701", 1);
  const anyRecall: Exercise = {
    id: "sr-any-701",
    kind: "recall",
    axis: "syntax-recall",
    language: "any",
    tier: 1,
    title: "any recall",
    prompt: "p",
    softTimeLimitSeconds: 300,
    testTimeoutMs: 10_000,
    acceptedAnswers: ["a"],
  };
  const pool = { statics: [javaEx, pyEx, anyRecall], axis: "syntax-recall" as const, rating: 1150, toolchains: ALL };

  it("allowlist filters candidates but 'any' always passes", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const pick = selectExercise({ ...pool, allowedLanguages: ["java"], random: rng });
      expect(pick?.language).not.toBe("python");
    }
  });

  it("explicit language bypasses the allowlist", () => {
    const pick = selectExercise({ ...pool, allowedLanguages: ["java"], language: "python", random: () => 0 });
    expect(pick?.id).toBe("sr-py-701");
  });

  it("empty allowlist means no filtering", () => {
    // statics order is [java, python, any-recall], each weight 1 of 3: 0.5 lands on python.
    const pick = selectExercise({ ...pool, allowedLanguages: [], random: () => 0.5 });
    expect(pick?.id).toBe("sr-py-701");
  });
});

describe("availableAxes - allowedLanguages", () => {
  const javaWrite = ex("sr-java-801", 1, "java");
  const pyReading: Exercise = { ...ex("sr-py-801", 1), axis: "code-reading" };
  const bank = [javaWrite, pyReading];

  it("availableAxes narrows under the allowlist", () => {
    expect(availableAxes(bank, undefined, [], ALL)).toEqual(["syntax-recall", "code-reading"]);
    // code-reading's only drill is python: it vanishes under a java-only allowlist.
    expect(availableAxes(bank, undefined, [], ALL, ["java"])).toEqual(["syntax-recall"]);
  });

  it("an explicit language ignores the allowlist entirely", () => {
    expect(availableAxes(bank, "python", [], ALL, ["java"])).toEqual(["code-reading"]);
  });
});

describe("hiddenByLanguages", () => {
  const javaWrite = ex("sr-java-901", 1, "java"); // JVM-graded: already un-offerable under NO_JDK
  const pyWrite = ex("sr-py-901", 1);
  const base = { statics: [javaWrite, pyWrite], axis: "syntax-recall" as const, toolchains: NO_JDK };

  it("counts only allowlist-hidden, not toolchain-hidden", () => {
    // Both arms use the real (no-JDK) toolchains, so the java write - already
    // hidden by the toolchain gate in both arms - never counts here.
    expect(hiddenByLanguages(base, ["java"])).toBe(1);
  });

  it("counts nothing when the allowlist is empty", () => {
    expect(hiddenByLanguages(base, [])).toBe(0);
  });

  it("ignores other axes", () => {
    expect(hiddenByLanguages({ ...base, axis: "debugging" }, ["java"])).toBe(0);
  });

  it("counts hidden generator families too", () => {
    const javaGen = fakeGen("sr-java-cond", [1], "java");
    const pyGen = fakeGen("sr-py-cond", [1]);
    expect(
      hiddenByLanguages({ statics: [], generators: [javaGen, pyGen], axis: "syntax-recall", toolchains: ALL }, ["java"]),
    ).toBe(1);
  });

  it("a bash-hidden shell write is not also counted as allowlist-hidden", () => {
    // The same law with the second toolchain: the shell write is gone from both arms
    // already, so only the python write - which the allowlist really does exclude -
    // counts here, and the shell write is reported by `hiddenByToolchain` instead.
    const pool = { statics: [shellWriteEx("sr-sh-001"), pyWrite], axis: "syntax-recall" as const, toolchains: NO_BASH };
    expect(hiddenByLanguages(pool, ["shell"])).toBe(1);
    expect(hiddenByToolchain(pool)).toEqual({ jdk: 0, bash: 1 });
  });

  it("under EVERY_TOOLCHAIN it answers the other question instead", () => {
    // Same pool, same allowlist, two different questions. On the real (bash-less)
    // toolchains the shell write is billed to bash and this reads 0 - the right answer
    // to "what did this host lose to the allowlist". A fully equipped host is asked the
    // other one, "would clearing the allowlist ever put a drill back", and that is the
    // one the CLI's empty-pool report needs before it tells anyone to install bash.
    const pool = { statics: [shellWriteEx("sr-sh-001")], axis: "syntax-recall" as const, toolchains: NO_BASH };
    expect(hiddenByLanguages(pool, ["python"])).toBe(0);
    expect(hiddenByLanguages({ ...pool, toolchains: EVERY_TOOLCHAIN }, ["python"])).toBe(1);
  });
});

describe("EVERY_TOOLCHAIN", () => {
  it("is every toolchain, and immutable", () => {
    expect(EVERY_TOOLCHAIN).toEqual(ALL);
    expect(Object.isFrozen(EVERY_TOOLCHAIN)).toBe(true);
  });
});
