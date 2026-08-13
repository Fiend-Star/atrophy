import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { grade, gradePrediction, solutionFileName } from "../../engine/grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk, javacCommand } from "../../engine/javatool.js";
import { run } from "../../engine/runner.js";
import { isCode, type CodeExercise, type PredictExercise } from "../schema.js";
import { allGenerators } from "./index.js";

const SEEDS = ["a1b2c3", "000000", "ffffff"];

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
    const predicts = allGenerators.filter((g) => g.axis === "code-reading");
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
  it("every generated java fix starter fails at least one of its own tests", async () => {
    // Several seeds per tier, not one: the archetype a variant plants is a seed
    // choice, so a single seed would leave whole planted bugs ungraded.
    let graded = 0;
    for (const g of javaGenerators) {
      for (const tier of g.tiers) {
        for (const seed of SEEDS) {
          const ex = g.generate(seed, tier);
          if (ex.kind !== "fix") continue;
          const dir = scratch();
          writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
          const r = await grade(ex, dir);
          // grade() compiles before it runs, so this also proves the buggy starter
          // is a *semantic* bug: a javac error would arrive here as a harnessError.
          expect(r.harnessError, `${g.family} t${tier} ${seed}: ${r.harnessError}`).toBeUndefined();
          expect(r.passed, `${g.family} t${tier} ${seed}: planted bug passes all tests`).toBeLessThan(r.total);
          graded++;
        }
      }
    }
    expect(graded, "no generated java fix exercises were graded").toBeGreaterThan(0);
  }, 300_000);

  it("every generated java write starter compiles", async () => {
    // A write starter is never graded before the user edits it, so nothing else in the
    // suite would ever hand it to javac - a broken one would first surface as javac
    // vomit on a real drill's first submit.
    let compiled = 0;
    for (const g of javaGenerators) {
      for (const tier of g.tiers) {
        const ex = g.generate("9a8b7c", tier);
        if (ex.kind !== "write") continue;
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
});
