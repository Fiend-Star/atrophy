import { exerciseSchema, type Exercise } from "../schema.js";
import { int, pick, sample, shuffle, type Rng } from "../../engine/rng.js";
import { PREDICT_LIMIT_BY_TIER, rngFor, type ExerciseGenerator } from "./types.js";

/**
 * Code-reading generators render a randomized deterministic snippet; the
 * grader computes ground truth by actually running it, so variants can never
 * ship a wrong answer key.
 */

/** Running a java snippet pays JVM cold start, which the schema's 10s default does not cover. */
const JAVA_PREDICT_TIMEOUT_MS = 20_000;

function predictExercise(
  family: string,
  language: "python" | "javascript" | "java",
  seed: string,
  tier: number,
  title: string,
  snippet: string,
): Exercise {
  const raw: unknown = {
    id: `${family}-${seed}`,
    kind: "predict-output",
    axis: "code-reading",
    language,
    tier,
    title,
    prompt: "Read the snippet. Predict its exact stdout - every line, exactly as it prints.",
    softTimeLimitSeconds: PREDICT_LIMIT_BY_TIER[tier] ?? 180,
    snippet,
    // Absent for python/js, so those keep the schema default.
    ...(language === "java" ? { testTimeoutMs: JAVA_PREDICT_TIMEOUT_MS } : {}),
  };
  return exerciseSchema.parse(raw) as Exercise;
}

/** Python aliasing vs copying: which names share the same list? */
const pyAlias: ExerciseGenerator = {
  family: "cr-py-alias",
  axis: "code-reading",
  language: "python",
  tiers: [1, 2],
  generate(seed, tier) {
    const rng = rngFor(this.family, seed, tier);
    const [a, b, c] = sample(rng, ["xs", "ys", "data", "vals", "buf"], 3) as [string, string, string];
    const base = [int(rng, 1, 9), int(rng, 1, 9)];
    const n1 = int(rng, 10, 99);
    const n2 = int(rng, 10, 99);
    const copyExpr = pick(rng, [`${a}[:]`, `list(${a})`, `${a}.copy()`]);
    const lines = [
      `${a} = ${JSON.stringify(base)}`,
      `${b} = ${a}`,
      `${b}.append(${n1})`,
      `print(len(${a}))`,
      `print(${a} is ${b})`,
      `${c} = ${copyExpr}`,
      `${c}.append(${n2})`,
      `print(${a})`,
    ];
    if (tier === 2) {
      // a second twist: mutating through the copy vs the alias
      lines.push(`${b}[0] = ${int(rng, 100, 999)}`, `print(${a}[0])`, `print(${c}[0])`);
    }
    return predictExercise(this.family, "python", seed, tier, "Two names, one list?", lines.join("\n") + "\n");
  },
};

/** Python slicing drills with randomized word and slice expressions. */
const pySlice: ExerciseGenerator = {
  family: "cr-py-slice",
  axis: "code-reading",
  language: "python",
  tiers: [1, 2],
  generate(seed, tier) {
    const rng = rngFor(this.family, seed, tier);
    const word = pick(rng, ["developer", "atrophy", "keyboard", "terminal", "baseline", "language"]);
    const i = int(rng, 1, 3);
    const j = int(rng, 4, Math.min(6, word.length - 1));
    const k = int(rng, 2, 3);
    const step = pick(rng, [2, 3]);
    const exprs = [`s[${i}:${j}]`, `s[-${k}:]`, `s[::${step}]`, `s[${i}:100]`];
    if (tier === 2) exprs.push("s[::-1]", `s[${j}:${i}]`);
    const chosen = sample(rng, exprs, tier === 1 ? 4 : 5);
    const snippet = `s = ${JSON.stringify(word)}\n` + chosen.map((e) => `print(${e})`).join("\n") + "\n";
    return predictExercise(this.family, "python", seed, tier, "Slice and dice", snippet);
  },
};

/** JS: coercion (t1), array chains (t2), closures (t3). */
const jsRead: ExerciseGenerator = {
  family: "cr-js-gen",
  axis: "code-reading",
  language: "javascript",
  tiers: [1, 2, 3],
  generate(seed, tier) {
    const rng = rngFor(this.family, seed, tier);
    let snippet: string;
    let title: string;
    if (tier === 1) {
      title = "Coercion warm-up";
      const n = int(rng, 1, 9);
      const m = int(rng, 2, 9);
      const linePool = [
        `console.log(${n} + "${m}");`,
        `console.log("${m}" - ${n});`,
        `console.log(typeof null);`,
        `console.log(Boolean(""));`,
        `console.log("${n}" + ${n});`,
        `console.log(typeof undefined);`,
        `console.log(Number(""));`,
      ];
      snippet = sample(rng, linePool, 4).join("\n") + "\n";
    } else if (tier === 2) {
      title = "Filter, map, stringify";
      const nums = Array.from({ length: 5 }, () => int(rng, 1, 9));
      const parity = pick(rng, [
        { test: "n % 2 === 1", name: "odd" },
        { test: "n % 2 === 0", name: "even" },
      ]);
      const op = pick(rng, ["n * n", `n * ${int(rng, 2, 10)}`, "n + 100"]);
      const [s0, s1] = [int(rng, 0, 1), int(rng, 2, 3)];
      snippet =
        `const nums = ${JSON.stringify(nums)};\n` +
        `const result = nums.filter((n) => ${parity.test}).map((n) => ${op});\n` +
        `console.log(JSON.stringify(result));\n` +
        `console.log(nums.length);\n` +
        `console.log(JSON.stringify(nums.slice(${s0}, ${s1})));\n`;
    } else {
      title = "Closures keep score";
      const step = int(rng, 2, 5);
      const start = int(rng, 0, 3);
      snippet =
        `function makeCounter(start, step) {\n` +
        `  let value = start;\n` +
        `  return function () {\n` +
        `    value += step;\n` +
        `    return value;\n` +
        `  };\n` +
        `}\n` +
        `const a = makeCounter(${start}, ${step});\n` +
        `const b = makeCounter(${start * 10}, ${step});\n` +
        `console.log(a());\n` +
        `console.log(a());\n` +
        `console.log(b());\n` +
        `console.log(a() + b());\n`;
    }
    return predictExercise(this.family, "javascript", seed, tier, title, snippet);
  },
};

/**
 * Java trace: a seeded int array walked once by three counters (t1), or folded into a
 * TreeMap and a LinkedHashMap printed back to back (t2).
 *
 * Two rules shape everything below. Every construct it renders is deterministic *by
 * specification* - no HashMap iteration, no locale-sensitive formatting, no default
 * toString of an array or an object - because the grader takes the snippet's one real
 * run as ground truth, so a snippet that could print something else would mark a
 * correct prediction wrong. And each tier renders exactly one shape, varying its data
 * rather than its structure: the JDK-gated snippet gate samples one seed per tier
 * (every pass costs a JVM), so a structural branch would be code that reaches users
 * having never been run.
 */

const MAP_VALUES = [2, 3, 5, 7, 9, 11, 13] as const;

/** Tier 1: sum and max carried through the loop, evens counted for the closing line. */
function traceSnippet(rng: Rng): { title: string; snippet: string } {
  const nums = Array.from({ length: int(rng, 4, 6) }, () => int(rng, -6, 20));
  return {
    title: "Three counters, one pass",
    snippet:
      `public class Main {\n` +
      `    public static void main(String[] args) {\n` +
      `        int[] nums = {${nums.join(", ")}};\n` +
      `        int sum = 0;\n` +
      `        int best = nums[0];\n` +
      `        int evens = 0;\n` +
      `        for (int n : nums) {\n` +
      `            sum += n;\n` +
      `            if (n > best) best = n;\n` +
      `            if (n % 2 == 0) evens++;\n` +
      `            System.out.println(sum + " " + best);\n` +
      `        }\n` +
      `        System.out.println("evens=" + evens);\n` +
      `    }\n` +
      `}\n`,
  };
}

/** Tier 2: the same counts read out twice, in sorted order and in arrival order. */
function mapSnippet(rng: Rng): { title: string; snippet: string } {
  const ascending = sample(rng, MAP_VALUES, 3).sort((a, b) => a - b);
  // A rotation is never the identity, so first-appearance order is never ascending
  // order - and it has to differ, or the two maps print the same lines and the drill
  // has nothing left to teach.
  const rot = int(rng, 1, 2);
  const firstSeen = [...ascending.slice(rot), ...ascending.slice(0, rot)];
  const counts = pick(rng, [
    [3, 2, 1],
    [2, 2, 1],
    [2, 1, 1],
  ] as const);
  // One of each value up front pins the insertion order; the extra copies follow in a
  // shuffled tail, so the counts are worth tracing without putting that order in doubt.
  const repeats = firstSeen.flatMap((v, i) => Array.from({ length: counts[i]! - 1 }, () => v));
  const nums = [...firstSeen, ...shuffle(rng, repeats)];
  return {
    title: "Sorted, or as it arrived?",
    snippet:
      `import java.util.LinkedHashMap;\n` +
      `import java.util.Map;\n` +
      `import java.util.TreeMap;\n` +
      `\n` +
      `public class Main {\n` +
      `    public static void main(String[] args) {\n` +
      `        int[] nums = {${nums.join(", ")}};\n` +
      `        TreeMap<Integer, Integer> sorted = new TreeMap<>();\n` +
      `        LinkedHashMap<Integer, Integer> seen = new LinkedHashMap<>();\n` +
      `        for (int n : nums) {\n` +
      `            sorted.put(n, sorted.getOrDefault(n, 0) + 1);\n` +
      `            seen.put(n, seen.getOrDefault(n, 0) + 1);\n` +
      `        }\n` +
      `        for (Map.Entry<Integer, Integer> e : sorted.entrySet()) {\n` +
      `            System.out.println("sorted " + e.getKey() + "=" + e.getValue());\n` +
      `        }\n` +
      `        for (Map.Entry<Integer, Integer> e : seen.entrySet()) {\n` +
      `            System.out.println("seen " + e.getKey() + "=" + e.getValue());\n` +
      `        }\n` +
      `        System.out.println(sorted.firstKey() + " " + sorted.lastKey() + " " + seen.size());\n` +
      `    }\n` +
      `}\n`,
  };
}

const javaTrace: ExerciseGenerator = {
  family: "cr-java-trace",
  axis: "code-reading",
  language: "java",
  tiers: [1, 2],
  generate(seed, tier) {
    const rng = rngFor(this.family, seed, tier);
    const { title, snippet } = tier === 1 ? traceSnippet(rng) : mapSnippet(rng);
    return predictExercise(this.family, "java", seed, tier, title, snippet);
  },
};

export const codeReadingGenerators: ExerciseGenerator[] = [pyAlias, pySlice, jsRead, javaTrace];
