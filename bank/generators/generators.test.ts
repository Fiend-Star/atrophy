import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gradeCloze } from "../../engine/cloze.js";
import { grade, gradePrediction, solutionFileName } from "../../engine/grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk, javacCommand } from "../../engine/javatool.js";
import { run } from "../../engine/runner.js";
import { isCode, isHarness, type ClozeExercise, type CodeExercise, type PredictExercise } from "../schema.js";
import { allGenerators } from "./index.js";

const SEEDS = ["a1b2c3", "000000", "ffffff"];

/** A wider spread, for families whose variant is itself an rng draw from a table. */
const SEED_SPREAD = Array.from({ length: 24 }, (_, i) => (i * 0x1111).toString(16).padStart(6, "0"));

/**
 * Same floor bank-integrity.test.ts puts on static java content: grading these kinds
 * pays javac + JVM cold start, which the schema's 10s default does not cover.
 */
const JVM_KINDS = new Set(["write", "fix", "write-harness", "fix-harness", "predict-output"]);

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-gen-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The `int[] nums = {...}` literal a java trace snippet walks, as numbers. */
function seededArray(snippet: string): number[] {
  const m = /int\[\] nums = \{([^}]*)\};/.exec(snippet);
  if (!m) throw new Error(`no seeded int[] literal in snippet:\n${snippet}`);
  return m[1]!.split(",").map((s) => Number(s.trim()));
}

describe("generator contracts", () => {
  it("every generator is deterministic and schema-valid for every tier and seed", () => {
    for (const g of allGenerators) {
      for (const tier of g.tiers) {
        for (const seed of SEEDS) {
          const a = g.generate(seed, tier); // schema-validated inside generate
          const b = g.generate(seed, tier);
          expect(b, `${g.family} t${tier} ${seed} not deterministic`).toEqual(a);
          expect(a.id).toBe(`${g.family}-${seed}`);
          expect(a.tier).toBe(tier);
          expect(a.axis).toBe(g.axis);
          expect(a.language).toBe(g.language);
          if (a.language === "java" && JVM_KINDS.has(a.kind)) {
            expect(a.testTimeoutMs, `${g.family} tier ${tier}`).toBeGreaterThanOrEqual(20_000);
            // Same tier-3 harness clause bank-integrity puts on static java content:
            // the exercise's own checks run on top of compile + startup, and the
            // hardest tier needs the headroom. Vacuous until a family emits them.
            if (isHarness(a) && a.tier === 3) {
              expect(a.testTimeoutMs, `${g.family} tier ${tier}`).toBeGreaterThanOrEqual(30_000);
            }
          }
        }
      }
    }
  });

  it("distinct seeds produce distinct exercises (spot check)", () => {
    for (const g of allGenerators) {
      const tier = g.tiers[0]!;
      const variants = new Set(
        ["111111", "222222", "333333", "444444", "555555"].map((s) =>
          JSON.stringify({ ...g.generate(s, tier), id: "x" }),
        ),
      );
      expect(variants.size, `${g.family}: variants collapse to one exercise`).toBeGreaterThan(1);
    }
  });

  it("debugging generators plant bugs that really fail their tests", async () => {
    // Java families get the same invariant under the JDK gate at the bottom of this
    // file; this loop spawns python/node only, so it stays runnable without a JDK.
    const debug = allGenerators.filter((g) => g.axis === "debugging" && g.language !== "java");
    expect(debug.length).toBeGreaterThan(0);
    for (const g of debug) {
      for (const [seed, tier] of [["9a8b7c", g.tiers[0]!], ["cafe01", g.tiers[g.tiers.length - 1]!]] as const) {
        const ex = g.generate(seed, tier);
        if (!isCode(ex)) throw new Error("debugging generator must produce code exercises");
        const dir = scratch();
        writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
        const r = await grade(ex as CodeExercise, dir);
        expect(r.passed, `${ex.id}: planted bug passes all tests`).toBeLessThan(r.total);
        expect(r.harnessError, `${ex.id}: starter should at least run`).toBeUndefined();
      }
    }
  }, 120_000);

  it("predict-output generators produce runnable, deterministic snippets", async () => {
    // Java families get the same invariant under the JDK gate at the bottom of this
    // file; this loop spawns python/node only, so it stays runnable without a JDK.
    const predicts = allGenerators.filter((g) => g.axis === "code-reading" && g.language !== "java");
    expect(predicts.length).toBeGreaterThan(0);
    for (const g of predicts) {
      for (const tier of g.tiers) {
        const ex = g.generate("0dd001", tier) as PredictExercise;
        const first = await gradePrediction(ex, scratch(), "");
        expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
        expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
        const second = await gradePrediction(ex, scratch(), first.actual!);
        expect(second.correct, `${ex.id}: output not deterministic`).toBe(true);
      }
    }
  }, 120_000);

  it("sr-java-cond renders a compiling-shape java starter with a matching functionName", () => {
    const gen = allGenerators.find((g) => g.family === "sr-java-cond")!;
    const ex = gen.generate("abc123", 1);
    expect(ex.kind).toBe("write");
    expect(ex.language).toBe("java");
    if (ex.kind !== "write") throw new Error("unreachable");
    expect(ex.starterCode).toContain("public class Solution");
    expect(ex.starterCode).not.toContain("package ");
    expect(ex.starterCode).toContain(`static int ${ex.functionName}(int[] nums)`);
    expect(ex.testTimeoutMs).toBeGreaterThanOrEqual(20_000);
  });

  it("dbg-java-scan renders compiling-shape java fix starters for both archetypes", () => {
    const gen = allGenerators.find((g) => g.family === "dbg-java-scan")!;
    const onGradedSeeds = new Set<string>();
    for (const tier of gen.tiers) {
      for (const seed of [...SEEDS, "111111", "222222", "333333"]) {
        const ex = gen.generate(seed, tier);
        expect(ex.kind).toBe("fix");
        expect(ex.language).toBe("java");
        if (ex.kind !== "fix") throw new Error("unreachable");
        expect(ex.starterCode).toContain("public class Solution");
        expect(ex.starterCode).not.toContain("package ");
        expect(ex.starterCode).toContain(`static int ${ex.functionName}(`);
        expect(ex.testTimeoutMs).toBeGreaterThanOrEqual(20_000);
        expect(ex.tests.length).toBeGreaterThanOrEqual(4);
        expect(ex.tests.length).toBeLessThanOrEqual(6);
        if (SEEDS.includes(seed)) onGradedSeeds.add(ex.functionName);
      }
    }
    // Which archetype a seed plants is an rng draw, and the JDK-gated loop below only
    // grades SEEDS. Asserting over exactly those seeds keeps that loop honest: if a
    // future change made them all land on one archetype, the other archetype's planted
    // bug would stop being graded anywhere, silently.
    expect([...onGradedSeeds].sort()).toEqual(["countMatches", "maxOf"]);
  });

  it("cr-java-trace renders snippets whose output is deterministic by construction", () => {
    const gen = allGenerators.find((g) => g.family === "cr-java-trace")!;
    // Constructs whose output depends on the machine, the locale, or the run. Ground
    // truth for a predict-output drill is whatever the snippet printed the one time the
    // grader ran it, so a nondeterministic snippet marks a correct answer wrong. The
    // lookbehind lets LinkedHashMap through - it iterates in insertion order - while a
    // bare HashMap, whose iteration order is unspecified, fails.
    const banned = [
      /(?<![A-Za-z])HashMap/,
      /printf|String\.format/,
      /random/i, // Math.random, new Random(, ThreadLocalRandom
      /Thread|currentTimeMillis|nanoTime|Instant|LocalDate|hashCode/,
    ];
    for (const tier of gen.tiers) {
      for (const seed of [...SEEDS, "111111", "222222", "333333"]) {
        const ex = gen.generate(seed, tier);
        expect(ex.kind).toBe("predict-output");
        expect(ex.language).toBe("java");
        if (ex.kind !== "predict-output") throw new Error("unreachable");
        // Predict-output java runs through the single-file source launcher as Main.java.
        expect(ex.snippet).toContain("public class Main");
        expect(ex.snippet).not.toContain("package ");
        expect(ex.testTimeoutMs).toBeGreaterThanOrEqual(20_000);
        for (const re of banned) expect(ex.snippet, `${ex.id} t${tier}: ${re}`).not.toMatch(re);

        const nums = seededArray(ex.snippet);
        expect(nums.length, `${ex.id}: array is not 4-6 elements`).toBeGreaterThanOrEqual(4);
        expect(nums.length, `${ex.id}: array is not 4-6 elements`).toBeLessThanOrEqual(6);
        if (tier === 2) {
          expect(ex.snippet).toContain("TreeMap");
          expect(ex.snippet).toContain("LinkedHashMap");
          const firstSeen = [...new Set(nums)];
          // Printing both maps only teaches something when they disagree: with an
          // already-ascending insertion order the two halves print identically.
          expect(firstSeen, `${ex.id}: insertion order is already sorted`).not.toEqual(
            [...firstSeen].sort((a, b) => a - b),
          );
          expect(firstSeen.length, `${ex.id}: no repeated value to count`).toBeLessThan(nums.length);
        }
      }
    }
  });

  it("api-java-blank renders exactly one blank per snippet and reaches every table row", () => {
    const gen = allGenerators.find((g) => g.family === "api-java-blank")!;
    expect(gen.tiers).toEqual([1, 2]);
    const titlesByTier = new Map<number, Set<string>>();
    for (const tier of gen.tiers) {
      const titles = new Set<string>();
      for (const seed of [...SEEDS, ...SEED_SPREAD]) {
        const ex = gen.generate(seed, tier);
        if (ex.kind !== "cloze") throw new Error("api-java-blank must produce cloze");
        expect(ex.language).toBe("java");
        // No JVM is ever spawned for a cloze, so this kind keeps the schema default
        // rather than the 20s floor the java code/predict kinds need.
        expect(ex.testTimeoutMs).toBe(10_000);
        // Two blanks would make the answer ambiguous under exact-match grading, and
        // bank-integrity's `toContain("____")` cannot see the difference.
        expect(ex.snippet.match(/____/g), `${ex.id} t${tier}: not exactly one blank`).toHaveLength(1);
        // Ambient code in a drill reads as approved code. The subtraction comparator
        // is the canonical int-overflow bug, and static api-java-004 teaches the right
        // ordering for these very int[] rows - the family must not contradict it.
        expect(ex.snippet, `${ex.id}: subtraction comparator`).not.toMatch(/\w\[\d\]\s*-\s*\w\[\d\]/);
        expect(ex.acceptedAnswers.length).toBeGreaterThan(0);
        // Every answer is a bare java method name: no punctuation, no call parens,
        // nothing whose normalization could differ from what the user types.
        for (const a of ex.acceptedAnswers) expect(a, `${ex.id}: ${a}`).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        titles.add(ex.title);
      }
      // A row that stopped rendering (or a fifth row nobody can draw) lands here.
      expect(titles.size, `tier ${tier} does not render all four table rows`).toBe(4);
      titlesByTier.set(tier, titles);
    }
    const [t1, t2] = [titlesByTier.get(1)!, titlesByTier.get(2)!];
    expect([...t1].filter((t) => t2.has(t)), "the 4/4 tier split leaks a row across tiers").toEqual([]);
  });

  it("api-java-blank's accepted sets hold the line on aliases", () => {
    const gen = allGenerators.find((g) => g.family === "api-java-blank")!;
    const byTitle = (tier: number, title: string) => {
      const ex = SEED_SPREAD.map((s) => gen.generate(s, tier)).find((e) => e.title === title);
      if (!ex || ex.kind !== "cloze") throw new Error(`no ${title} variant rendered`);
      return ex;
    };
    /** Every fact here is one blank: the typed answer either fills it or it doesn't. */
    const accepts = (ex: ClozeExercise, answer: string) => {
      const { blanksCorrect, totalBlanks } = gradeCloze(ex, [answer]);
      return blanksCorrect === totalBlanks;
    };

    // Deque.push is specified as "equivalent to addFirst", so the alias is a right
    // answer to a prompt that asks for the behaviour - grading it wrong would cost the
    // user rating. offerFirst does land in the same place on an unbounded ArrayDeque,
    // so the prompt has to exclude it by name ("the void insert, not the boolean offer
    // form") rather than the accepted set pretending it misbehaves; addLast is simply
    // the wrong end for the pop() below.
    const stack = byTitle(1, "Deque as a stack");
    expect(accepts(stack, "push")).toBe(true);
    expect(accepts(stack, "addFirst")).toBe(true);
    expect(accepts(stack, "offerFirst")).toBe(false);
    expect(accepts(stack, "addLast")).toBe(false);

    // The lambda in the second argument is what pins computeIfAbsent: putIfAbsent and
    // getOrDefault take a plain V there (a lambda is not a List), and compute /
    // computeIfPresent want a two-arg BiFunction. None of them would compile.
    const lists = byTitle(1, "One list per key");
    expect(accepts(lists, "computeIfAbsent")).toBe(true);
    expect(accepts(lists, "putIfAbsent")).toBe(false);
    expect(accepts(lists, "getOrDefault")).toBe(false);
    expect(accepts(lists, "computeIfPresent")).toBe(false);

    // "sequentially" in the prompt is what excludes parallelSort, which reorders the
    // same way through a different execution contract.
    const rows = byTitle(2, "Sort rows by first column");
    expect(accepts(rows, "sort")).toBe(true);
    expect(accepts(rows, "parallelSort")).toBe(false);
  });

  it("cloze generators always include the blank", () => {
    for (const g of allGenerators.filter((x) => x.axis === "api-memory")) {
      for (const tier of g.tiers) {
        for (const seed of SEEDS) {
          const ex = g.generate(seed, tier);
          if (ex.kind !== "cloze") throw new Error("api-memory generator must produce cloze");
          expect(ex.snippet).toContain("____");
          expect(ex.acceptedAnswers.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

const javaGenerators = allGenerators.filter((g) => g.language === "java");

/**
 * bank-integrity.test.ts holds static java JSON to two gates - the starter compiles,
 * and a `fix` starter really fails. Generated java content reaches users through the
 * exact same grader but ships no JSON, so it needs the gates applied to rendered
 * variants instead. Same JDK skip as the bank suite: no toolchain, no java claims.
 */
if (!hasJdk()) console.warn("⚠ JDK not found - java generator families NOT validated. Install JDK 21.");
describe.skipIf(!hasJdk())("generator contracts - java", () => {
  it("every generated java fix/fix-harness starter fails at least one of its own checks", async () => {
    // Several seeds per tier, not one: the archetype a variant plants is a seed
    // choice, so a single seed would leave whole planted bugs ungraded. Harness kinds
    // are held to the same invariant as the static bank holds them to - narrowing this
    // to `fix` would let a future fix-harness family through while the count guard
    // below stayed green off dbg-java-scan alone.
    let graded = 0;
    for (const g of javaGenerators) {
      for (const tier of g.tiers) {
        for (const seed of SEEDS) {
          const ex = g.generate(seed, tier);
          if (ex.kind !== "fix" && ex.kind !== "fix-harness") continue;
          const dir = scratch();
          writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
          const r = await grade(ex, dir);
          // grade() compiles before it runs, so this also proves the buggy starter
          // is a *semantic* bug: a javac error would arrive here as a harnessError.
          expect(r.harnessError, `${g.family} t${tier} ${seed}: ${r.harnessError}`).toBeUndefined();
          expect(r.passed, `${g.family} t${tier} ${seed}: planted bug passes all checks`).toBeLessThan(r.total);
          graded++;
        }
      }
    }
    expect(graded, "no generated java fix exercises were graded").toBeGreaterThan(0);
  }, 300_000);

  it("every generated java write/write-harness starter compiles", async () => {
    // A write starter is never graded before the user edits it, so nothing else in the
    // suite would ever hand it to javac - a broken one would first surface as javac
    // vomit on a real drill's first submit. Same for a write-harness starter, which the
    // fix loop above skips for exactly that reason: it has no planted bug to fail on.
    let compiled = 0;
    for (const g of javaGenerators) {
      for (const tier of g.tiers) {
        const ex = g.generate("9a8b7c", tier);
        if (ex.kind !== "write" && ex.kind !== "write-harness") continue;
        const dir = scratch();
        const file = solutionFileName(ex);
        writeFileSync(join(dir, file), ex.starterCode, "utf8");
        // Same locale pin as the grader's javac call, so a failure reads the same everywhere.
        const r = await run(
          javacCommand(),
          ["-J-Duser.language=en", "-J-Duser.country=US", "-encoding", "UTF-8", file],
          { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS },
        );
        expect(r.exitCode, `${g.family} t${tier}: generated starter does not compile:\n${r.stderr}`).toBe(0);
        compiled++;
      }
    }
    expect(compiled, "no generated java write starters were compiled").toBeGreaterThan(0);
  }, 300_000);

  it("every generated java predict-output snippet runs cleanly and deterministically", async () => {
    // One seed per tier, unlike the fix loop above: every rendered line of a trace
    // snippet is on the one code path its tier renders, so a single seed already puts
    // all of it through the launcher - and each pass here costs a fresh JVM.
    let ran = 0;
    for (const g of javaGenerators) {
      for (const tier of g.tiers) {
        const ex = g.generate("0dd001", tier);
        if (ex.kind !== "predict-output") continue;
        const first = await gradePrediction(ex, scratch(), "");
        expect(first.error, `${ex.id} t${tier}: ${first.error}`).toBeUndefined();
        expect(first.actual, `${ex.id} t${tier}: snippet prints nothing`).toBeTruthy();
        // Second run, fresh dir, graded against the first run's stdout: identical output
        // is exactly what "correct" means here.
        const second = await gradePrediction(ex, scratch(), first.actual!);
        expect(second.correct, `${ex.id} t${tier}: output is not deterministic`).toBe(true);
        ran++;
      }
    }
    expect(ran, "no generated java predict-output snippets were run").toBeGreaterThan(0);
  }, 300_000);
});
