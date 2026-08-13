import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeExercise, Exercise, HarnessExercise } from "../bank/schema.js";
import { hasJdk } from "./javatool.js";
import { previewExercise, runDrill, type DrillOutcome } from "./session.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-session-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a pre-baked answer file for the `--solution` (non-interactive) path. */
function solutionFile(code: string): string {
  const file = join(scratch(), "answer.txt");
  writeFileSync(file, code, "utf8");
  return file;
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/**
 * Drive an interactive drill without a terminal: swap process.stdin for a stream and
 * feed the next answer whenever readline prints a prompt (the "[Enter] …" line). Waiting
 * on the prompt rather than a timer keeps it deterministic - an answer written while the
 * grader is running would be read as a line with no question pending and silently lost.
 */
async function driveDrill(
  ex: Exercise,
  answers: string[],
): Promise<{ outcome: DrillOutcome; output: string; prompts: string }> {
  const fake = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  const previousEditor = process.env.ATROPHY_EDITOR;
  process.env.ATROPHY_EDITOR = "echo"; // a no-op "editor" on both cmd and sh
  const { lines, restore: restoreLog } = captureLog();
  const queue = [...answers];
  // readline writes prompts here, not through console.log - assertions about which
  // prompt the user was offered ("fix & resubmit" vs not) have to read these chunks.
  const prompts: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      if (typeof chunk === "string") {
        prompts.push(chunk);
        if (chunk.includes("[Enter]")) {
          const next = queue.shift();
          if (next !== undefined) setImmediate(() => fake.write(`${next}\n`));
        }
      }
      return true;
    }) as typeof process.stdout.write);
  try {
    const outcome = await runDrill(ex);
    return { outcome, output: lines.join("\n"), prompts: prompts.join("\n") };
  } finally {
    writeSpy.mockRestore();
    restoreLog();
    Object.defineProperty(process, "stdin", stdinDescriptor);
    if (previousEditor === undefined) delete process.env.ATROPHY_EDITOR;
    else process.env.ATROPHY_EDITOR = previousEditor;
    fake.end();
  }
}

const pyEx: CodeExercise = {
  id: "sr-py-950",
  kind: "write",
  axis: "syntax-recall",
  language: "python",
  tier: 1,
  title: "double",
  prompt: "double it",
  functionName: "double",
  starterCode: "def double(x):\n    pass\n",
  softTimeLimitSeconds: 300,
  testTimeoutMs: 15_000,
  tests: [{ args: [2], expected: 4 }],
};

const harnessEx: HarnessExercise = {
  id: "conc-java-950",
  kind: "write-harness",
  axis: "syntax-recall",
  language: "java",
  tier: 3,
  title: "counter",
  prompt: "Make Counter.increment() thread-safe.",
  softTimeLimitSeconds: 600,
  testTimeoutMs: 30_000,
  totalChecks: 1,
  starterCode: "public class Solution {\n    private int n = 0;\n    public void increment() { n++; }\n    public int value() { return n; }\n}\n",
  // Deliberately deterministic (no race): this fixture is about session plumbing,
  // and grader.test.ts already owns the concurrency behaviour.
  testCode: `public class Harness {
    public static void main(String[] args) throws Exception {
        Atrophy.plan(1);
        Solution s = new Solution();
        s.increment();
        Atrophy.check("increment() advances value()", s.value() == 1);
        Atrophy.report();
    }
}`,
};

describe("previewExercise", () => {
  it("shows starter code for harness kinds (they are edit-a-solution drills too)", () => {
    const { lines, restore } = captureLog();
    try {
      previewExercise(harnessEx);
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(output).toContain("starter code:");
    expect(output).toContain("public void increment()");
  });
});

describe("runDrill - whiteboard mode (submitPolicy: single)", () => {
  it("grades exactly once and says so instead of offering a retry", async () => {
    // Two answers: the first Enter trips the "file hasn't changed" guard (not a
    // submission), the second is the one graded submission.
    const { outcome, output, prompts } = await driveDrill({ ...pyEx, submitPolicy: "single" }, ["", ""]);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(0);
    expect(outcome.total).toBe(1);
    expect(output).toContain("whiteboard mode: single submission, no retries");
    expect(prompts).not.toContain("fix & resubmit"); // the retry prompt was never offered
  }, 30_000);

  it("does not consume the single submission when the toolchain fails", async () => {
    // A harnessError is not drill evidence: a missing JDK (or any grading failure)
    // must leave the one submission intact rather than scoring the user 0.
    const previous = process.env.ATROPHY_JAVA_HOME;
    process.env.ATROPHY_JAVA_HOME = join(tmpdir(), "atrophy-no-such-jdk-home");
    try {
      const { outcome, output, prompts } = await driveDrill(
        { ...harnessEx, submitPolicy: "single" },
        ["", "", "q"],
      );
      expect(output).toContain("Your code did not run");
      expect(output).not.toContain("whiteboard mode");
      // Reaching a retry prompt at all is the proof the submission was not consumed.
      expect(prompts).toContain("fix & resubmit");
      expect(outcome.abandoned).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ATROPHY_JAVA_HOME;
      else process.env.ATROPHY_JAVA_HOME = previous;
    }
  }, 30_000);

  it("still loops when no policy is set (absent means loop, not 'loop')", async () => {
    // Same two answers, then "q": reaching the third prompt at all proves the
    // submit loop survived a failed attempt.
    const { outcome, output } = await driveDrill(pyEx, ["", "", "q"]);
    expect(outcome.abandoned).toBe(true);
    expect(output).not.toContain("whiteboard mode");
    expect(output).toContain("1 tests passed");
  }, 30_000);
});

if (!hasJdk()) console.warn("⚠ JDK not found - harness drill session tests SKIPPED. Install JDK 21 to validate them.");
describe.skipIf(!hasJdk())("runDrill - harness kinds", () => {
  it("routes write-harness through the code drill and grades the solution file", async () => {
    const answer = solutionFile(
      "public class Solution {\n    private int n = 0;\n    public synchronized void increment() { n++; }\n    public synchronized int value() { return n; }\n}\n",
    );
    const outcome = await runDrill(harnessEx, answer);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(1);
    expect(outcome.score).toBeGreaterThan(0);
  }, 90_000);

  it("renders a failed check by name, never as `test #N`", async () => {
    const failing: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-951",
      submitPolicy: "single",
      starterCode: "public class Solution {\n    public void increment() {}\n    public int value() { return 0; }\n}\n",
    };
    const { outcome, output } = await driveDrill(failing, ["", ""]);
    expect(outcome.passed).toBe(0);
    expect(output).toContain("✗ increment() advances value()");
    expect(output).not.toContain("test #");
  }, 90_000);
});
