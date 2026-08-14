import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { grade, gradePrediction, normalizeRecallAnswer, solutionFileName } from "../engine/grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk, javacCommand } from "../engine/javatool.js";
import { run } from "../engine/runner.js";
import { isHarness, loadBank, type CodeLikeExercise, type PredictExercise } from "./schema.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/**
 * Any bank dir can be validated, not just the built-in one - this is how a pack
 * gets checked before it is trusted: `ATROPHY_BANK=<pack-dir> npx vitest run
 * bank/bank-integrity.test.ts`. Like the CLI, the variable replaces the bank rather
 * than adding to it; unlike the CLI, an empty value is not read as "unset" - it
 * fails loudly here instead of silently validating the built-in bank.
 */
const bankRoot = process.env.ATROPHY_BANK ?? join(here, "exercises");
const bank = loadBank(bankRoot);
const validatingBuiltInBank = !process.env.ATROPHY_BANK;

/**
 * Everything outside the JDK-gated describe below must be runnable without a JDK,
 * so java content is filtered out of every loop that spawns a toolchain.
 */
const nonJava = bank.filter((e) => e.language !== "java");

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-bank-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("bank integrity", () => {
  it("the bank root holds exercises at all", () => {
    // An existing-but-exercise-less dir loads as [] without throwing, and every loop
    // below then passes by iterating nothing: a pack author would read that green as
    // "my pack is valid". This is the one check no bank of any shape may skip.
    expect(bank.length, `no exercises found under ${bankRoot}`).toBeGreaterThan(0);
  });

  it("every fix exercise ships a bug that actually fails at least one test", async () => {
    const fixes = nonJava.filter((e) => e.kind === "fix");
    // The built-in bank losing its fixes would silently make this test vacuous. A pack
    // pointed at by ATROPHY_BANK may legitimately be pure-java (validated under the JDK
    // gate below) or ship no fix exercises at all, so it is not held to that.
    if (validatingBuiltInBank) expect(fixes.length).toBeGreaterThan(0);
    for (const ex of fixes) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      expect(r.passed, `${ex.id}: planted bug passes all tests - no bug to find`).toBeLessThan(r.total);
      expect(r.passed + (r.harnessError ? 0 : 1), `${ex.id}: starter should at least load`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("every predict-output snippet runs cleanly and deterministically", async () => {
    const predicts = nonJava.filter((e) => e.kind === "predict-output");
    for (const ex of predicts) {
      const first = await gradePrediction(ex, scratch(), "");
      expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
      expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
      const second = await gradePrediction(ex, scratch(), first.actual!);
      expect(second.correct, `${ex.id}: output is not deterministic`).toBe(true);
    }
  }, 120_000);

  it("cloze blanks actually appear in their snippets", () => {
    for (const ex of bank.filter((e) => e.kind === "cloze")) {
      expect(ex.snippet, `${ex.id}: snippet has no ____ blank`).toContain("____");
    }
  });

  it("every recall answer still says something after normalization", () => {
    // The schema only demands a non-empty string, so " " gets through - and grading
    // compares normalized forms, which would make such an answer unmatchable by anyone.
    for (const ex of bank.filter((e) => e.kind === "recall")) {
      for (const accepted of ex.acceptedAnswers) {
        const { text } = normalizeRecallAnswer(accepted);
        expect(text, `${ex.id}: accepted answer ${JSON.stringify(accepted)} normalizes to nothing`).not.toBe("");
      }
    }
  });
});

/**
 * Kinds whose grading starts a JVM. The schema's 10s default `testTimeoutMs` is a
 * flake factory once javac + JVM cold start are on the clock, so java content is
 * held to a floor. Static JSON only - this lint spawns nothing and stays ungated.
 */
const JVM_KINDS = new Set(["write", "fix", "write-harness", "fix-harness", "predict-output"]);

describe("java timeout floors", () => {
  const javaJvm = bank.filter((ex) => ex.language === "java" && JVM_KINDS.has(ex.kind));

  it("the built-in bank ships JVM-graded java exercises at all", () => {
    // Every java check in this file - the floors here and the whole JDK-gated describe
    // below - iterates this set, so losing the shipped java content would turn all of
    // them green by iterating nothing. A pack pointed at by ATROPHY_BANK may legitimately
    // ship no java, so only the built-in bank is held to this.
    if (validatingBuiltInBank) expect(javaJvm.length).toBeGreaterThan(0);
  });

  it("every JVM-spawning java exercise allows at least 20s", () => {
    const bad = javaJvm.filter((ex) => ex.testTimeoutMs < 20_000);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });

  it("tier-3 harness drills allow at least 30s", () => {
    // Harness drills run the exercise's own checks (threads, latches, watchdog) on top
    // of compile + startup; the hardest tier needs the extra headroom.
    const bad = javaJvm.filter((ex) => isHarness(ex) && ex.tier === 3 && ex.testTimeoutMs < 30_000);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });
});

const javaCode = bank.filter(
  (e): e is CodeLikeExercise =>
    (e.kind === "write" || e.kind === "fix" || isHarness(e)) && e.language === "java",
);
const javaPredicts = bank.filter(
  (e): e is PredictExercise => e.kind === "predict-output" && e.language === "java",
);

// Java content is validated only where a toolchain exists; the presence check above
// guarantees the built-in bank keeps these loops non-empty.
// Generated java families ship no JSON and so never reach this bank, but they reach the
// same grader: their copy of these gates lives beside the other generator contracts,
// in bank/generators/generators.test.ts ("generator contracts - java").
if (!hasJdk()) console.warn("⚠ JDK not found - Java exercises NOT validated. Install JDK 21.");
describe.skipIf(!hasJdk())("bank integrity - java", () => {
  it("every java starter compiles (no javac vomit on first submit)", async () => {
    for (const ex of javaCode) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      // Same locale pin as the grader's javac call, so a failure reads the same everywhere.
      const r = await run(
        javacCommand(),
        ["-J-Duser.language=en", "-J-Duser.country=US", "-encoding", "UTF-8", solutionFileName(ex)],
        { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS },
      );
      expect(r.exitCode, `${ex.id}: starter does not compile:\n${r.stderr}`).toBe(0);
    }
  }, 300_000);

  it("every java fix/fix-harness starter actually fails, and harness totals match totalChecks", async () => {
    for (const ex of javaCode.filter((e) => e.kind === "fix" || e.kind === "fix-harness")) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      expect(r.passed, `${ex.id}: planted bug passes all checks - no bug to find`).toBeLessThan(r.total);
    }
    for (const ex of javaCode.filter(isHarness)) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      // grade() itself hard-fails on a total mismatch; reaching here with no harnessError proves the contract
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      expect(r.total, `${ex.id}: reported total must equal totalChecks`).toBe(ex.totalChecks);
    }
  }, 300_000);

  it("every java predict-output snippet runs cleanly and deterministically", async () => {
    for (const ex of javaPredicts) {
      const first = await gradePrediction(ex, scratch(), "");
      expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
      expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
      const second = await gradePrediction(ex, scratch(), first.actual!);
      expect(second.correct, `${ex.id}: output is not deterministic`).toBe(true);
    }
  }, 300_000);
});
