import { exerciseSchema, type Exercise } from "../schema.js";
import { int, pick, sample, shuffle, type Rng } from "../../engine/rng.js";
import { SOFT_LIMIT_BY_TIER, rngFor, type ExerciseGenerator } from "./types.js";

/**
 * Debugging generator: a correct "sum amounts per category" implementation
 * with ONE randomly planted mutation. Both the correct and the buggy
 * semantics are simulated here in TypeScript, and the generator throws if
 * the planted bug wouldn't fail at least one generated test - a variant
 * with an invisible bug cannot exist by construction.
 */

type Pair = [string, number];
type Mutation = "overwrite" | "count" | "reset" | "nolower";

const CATEGORIES = ["food", "rent", "travel", "tools", "books", "gear"] as const;

function refTotals(pairs: Pair[], lower: boolean): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [cat, amount] of pairs) {
    const k = lower ? cat.toLowerCase() : cat;
    totals[k] = (totals[k] ?? 0) + amount;
  }
  return totals;
}

/** Simulate what each planted bug would return. */
function buggyTotals(pairs: Pair[], mutation: Mutation, lower: boolean): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [cat, amount] of pairs) {
    const k = mutation === "nolower" ? cat : lower ? cat.toLowerCase() : cat;
    if (mutation === "reset") {
      for (const key of Object.keys(totals)) delete totals[key];
    }
    if (mutation === "overwrite") totals[k] = amount;
    else if (mutation === "count") totals[k] = (totals[k] ?? 0) + 1;
    else totals[k] = (totals[k] ?? 0) + amount;
  }
  return totals;
}

const canon = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());

function renderPython(mutation: Mutation, lower: boolean): string {
  const keyExpr = lower && mutation !== "nolower" ? "category.lower()" : "category";
  const assign =
    mutation === "overwrite"
      ? `        totals[${keyExpr}] = amount`
      : mutation === "count"
        ? `        totals[${keyExpr}] = totals.get(${keyExpr}, 0) + 1`
        : `        totals[${keyExpr}] = totals.get(${keyExpr}, 0) + amount`;
  const reset = mutation === "reset" ? "        totals = {}\n" : "";
  return `def total_by_category(pairs):\n    totals = {}\n    for category, amount in pairs:\n${reset}${assign}\n    return totals\n`;
}

function renderJs(mutation: Mutation, lower: boolean): string {
  const keyExpr = lower && mutation !== "nolower" ? "category.toLowerCase()" : "category";
  const assign =
    mutation === "overwrite"
      ? `    totals[${keyExpr}] = amount;`
      : mutation === "count"
        ? `    totals[${keyExpr}] = (totals[${keyExpr}] || 0) + 1;`
        : `    totals[${keyExpr}] = (totals[${keyExpr}] || 0) + amount;`;
  const reset = mutation === "reset" ? "    totals = {};\n" : "";
  return (
    `function totalByCategory(pairs) {\n  let totals = {};\n  for (const [category, amount] of pairs) {\n` +
    reset +
    assign +
    `\n  }\n  return totals;\n}\n\nmodule.exports = { totalByCategory };\n`
  );
}

function titleCase(cat: string): string {
  return cat[0]!.toUpperCase() + cat.slice(1);
}

function makeDebugGenerator(family: string, language: "python" | "javascript"): ExerciseGenerator {
  return {
    family,
    axis: "debugging",
    kind: "fix",
    language,
    tiers: [1, 2],
    generate(seed, tier) {
      const rng = rngFor(family, seed, tier);
      const lower = tier === 2;
      const mutation: Mutation = lower
        ? pick(rng, ["overwrite", "count", "reset", "nolower"] as const)
        : pick(rng, ["overwrite", "count", "reset"] as const);

      // Data that provably exposes every mutation: a repeated category with
      // distinct amounts >= 2, plus (tier 2) a mixed-case duplicate.
      const cats = sample(rng, CATEGORIES, 3);
      const rep = cats[0]!;
      const a1 = int(rng, 2, 49);
      const a2 = a1 + int(rng, 2, 40);
      const mainCase: Pair[] = [
        [rep, a1],
        [cats[1]!, int(rng, 2, 99)],
        [lower ? titleCase(rep) : rep, a2],
        [cats[2]!, int(rng, 2, 99)],
      ];
      const cases: Pair[][] = [
        mainCase,
        [],
        [[cats[1]!, int(rng, 2, 99)]],
        [
          [cats[2]!, int(rng, 2, 30)],
          [cats[2]!, int(rng, 31, 60)],
        ],
      ];
      const tests = cases.map((pairs) => ({
        args: [pairs],
        expected: refTotals(pairs, lower),
      }));

      // Construction-time guarantee: the planted bug must be visible.
      const exposed = cases.some(
        (pairs) => canon(buggyTotals(pairs, mutation, lower)) !== canon(refTotals(pairs, lower)),
      );
      if (!exposed) {
        throw new Error(`${family}-${seed}: mutation ${mutation} not exposed by generated tests`);
      }

      const fnName = language === "python" ? "total_by_category" : "totalByCategory";
      const lowerText = lower
        ? " Category names are case-insensitive - keys in the result must be lowercase."
        : "";
      const raw: unknown = {
        id: `${family}-${seed}`,
        kind: "fix",
        axis: "debugging",
        language,
        tier,
        title: "The totals are wrong",
        prompt:
          `${fnName}(pairs) receives [category, amount] pairs and should return a ` +
          `${language === "python" ? "dict" : "object"} mapping each category to the SUM of its amounts.${lowerText}\n` +
          `Users report wrong totals. Find and fix the bug - smallest change wins, don't rewrite from scratch.`,
        functionName: fnName,
        starterCode: language === "python" ? renderPython(mutation, lower) : renderJs(mutation, lower),
        softTimeLimitSeconds: SOFT_LIMIT_BY_TIER[tier] ?? 300,
        tests,
      };
      return exerciseSchema.parse(raw) as Exercise;
    },
  };
}

/**
 * Java debugging generator: a small array scan carrying ONE planted semantic bug,
 * the archetype chosen per seed. Same construction-time guarantee the python/js
 * family above makes - what the shipped starter returns is simulated here, and a
 * variant whose bug no generated test can see throws instead of becoming a drill.
 */
type ScanVariant = "maxOffByOne" | "stringEqRef";

const WORDS = ["alpha", "bravo", "delta", "echo", "kilo", "mike", "sierra", "tango"] as const;

interface ScanSpec {
  fnName: string;
  title: string;
  prompt: string;
  starterCode: string;
  tests: { args: unknown[]; expected: number }[];
  /** What the shipped (buggy) starter returns per test - the exposure proof. */
  buggy: number[];
}

const refMax = (nums: number[]): number => nums.reduce((best, n) => (n > best ? n : best), nums[0]!);

/** The starter's loop stops one element early: max of nums[0..n-2]. */
function buggyMax(nums: number[]): number {
  let best = nums[0]!;
  for (let i = 1; i < nums.length - 1; i++) {
    if (nums[i]! > best) best = nums[i]!;
  }
  return best;
}

function maxSpec(rng: Rng, tier: number): ScanSpec {
  const lo = tier === 1 ? 1 : -40;
  const hi = tier === 1 ? 60 : 40;
  const len = tier === 1 ? 5 : int(rng, 6, 8);
  const body = (n: number): number[] => Array.from({ length: n }, () => int(rng, lo, hi));
  const above = (nums: number[]): number => Math.max(...nums) + int(rng, 1, 9);

  // The off-by-one is invisible everywhere except the final slot, so one case has to
  // put the maximum exactly there - and strictly, so a tie could not mask it.
  const tail = body(len - 1);
  const lastIsMax = [...tail, above(tail)];
  const firstIsMax = body(len);
  firstIsMax[0] = above(firstIsMax);
  const midIsMax = body(len);
  midIsMax[int(rng, 1, len - 2)] = above(midIsMax);

  const cases: number[][] = [lastIsMax, [int(rng, lo, hi)], firstIsMax, midIsMax];
  if (tier === 2) {
    // Two elements ascending: the loop body never runs at all.
    const first = int(rng, lo, hi);
    cases.push([first, first + int(rng, 1, 9)]);
  }

  return {
    fnName: "maxOf",
    title: "The maximum comes back wrong",
    prompt:
      "maxOf(int[] nums) should return the largest value in nums. nums is never empty.\n" +
      "Users report the wrong answer on some arrays. Find and fix the bug - smallest change wins, don't rewrite from scratch.",
    starterCode:
      `public class Solution {\n` +
      `    static int maxOf(int[] nums) {\n` +
      `        int best = nums[0];\n` +
      `        for (int i = 1; i < nums.length - 1; i++) {\n` +
      `            if (nums[i] > best) best = nums[i];\n` +
      `        }\n` +
      `        return best;\n` +
      `    }\n` +
      `}\n`,
    tests: cases.map((nums) => ({ args: [nums], expected: refMax(nums) })),
    buggy: cases.map(buggyMax),
  };
}

const refCount = (words: string[], target: string): number => words.filter((w) => w === target).length;

function countSpec(rng: Rng, tier: number): ScanSpec {
  const pool = sample(rng, WORDS, tier === 1 ? 4 : 6);
  const target = pool[0]!;
  const others = pool.slice(1);

  const repeat = (n: number): string[] => Array.from({ length: n }, () => target);
  const cases: { words: string[]; target: string }[] = [
    { words: shuffle(rng, [...repeat(int(rng, 2, 3)), ...sample(rng, others, 2)]), target },
    // No match at all: the only shape the buggy starter gets right, and the reason
    // a drill on it still shows some green.
    { words: shuffle(rng, others), target },
    { words: [others[0]!, target, others[1]!], target },
    { words: repeat(int(rng, 2, 4)), target },
  ];
  if (tier === 2) {
    // Case-differing near misses: `equalsIgnoreCase` is the wrong fix, and these say so.
    cases.push({ words: [titleCase(target), target, target.toUpperCase()], target });
  }

  return {
    fnName: "countMatches",
    title: "The match count comes back wrong",
    prompt:
      "countMatches(String[] words, String target) should return how many entries of words are equal to " +
      "target by value (case-sensitive).\n" +
      "Users report counts that are too low. Find and fix the bug - smallest change wins, don't rewrite from scratch.",
    starterCode:
      `public class Solution {\n` +
      `    static int countMatches(String[] words, String target) {\n` +
      `        int count = 0;\n` +
      `        for (String w : words) {\n` +
      `            if (w == target) count++;\n` +
      `        }\n` +
      `        return count;\n` +
      `    }\n` +
      `}\n`,
    tests: cases.map(({ words, target: t }) => ({ args: [words, t], expected: refCount(words, t) })),
    // Reference equality, not value equality: every String in a test vector is minted by
    // the harness's own JSON parse of tests.json, so no two of them are ever `==`. The
    // starter therefore counts nothing, whatever the words say.
    buggy: cases.map(() => 0),
  };
}

function makeJavaScanGenerator(family: string): ExerciseGenerator {
  return {
    family,
    axis: "debugging",
    kind: "fix",
    language: "java",
    tiers: [1, 2],
    generate(seed, tier) {
      const rng = rngFor(family, seed, tier);
      const variant: ScanVariant = pick(rng, ["maxOffByOne", "stringEqRef"] as const);
      const spec = variant === "maxOffByOne" ? maxSpec(rng, tier) : countSpec(rng, tier);

      // Construction-time guarantee: the planted bug must be visible.
      if (!spec.tests.some((t, i) => spec.buggy[i] !== t.expected)) {
        throw new Error(`${family}-${seed}: ${variant} not exposed by generated tests`);
      }

      const raw: unknown = {
        id: `${family}-${seed}`,
        kind: "fix",
        axis: "debugging",
        language: "java",
        tier,
        title: spec.title,
        prompt: spec.prompt,
        functionName: spec.fnName,
        starterCode: spec.starterCode,
        softTimeLimitSeconds: SOFT_LIMIT_BY_TIER[tier] ?? 300,
        // Grading java pays javac + JVM cold start, which the schema's 10s default does not cover.
        testTimeoutMs: 20_000,
        tests: spec.tests,
      };
      return exerciseSchema.parse(raw) as Exercise;
    },
  };
}

export const debuggingGenerators: ExerciseGenerator[] = [
  makeDebugGenerator("dbg-py-agg", "python"),
  makeDebugGenerator("dbg-js-agg", "javascript"),
  makeJavaScanGenerator("dbg-java-scan"),
];
