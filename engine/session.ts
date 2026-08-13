import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import pc from "picocolors";
import {
  totalUnits,
  type ClozeExercise,
  type CodeLikeExercise,
  type Exercise,
  type OutlineExercise,
  type PredictExercise,
  type RecallExercise,
} from "../bank/schema.js";
import {
  grade,
  gradeCloze,
  gradePrediction,
  gradeRecall,
  solutionFileName,
  type GradeResult,
} from "./grader.js";
import { exerciseScore } from "./scoring.js";

export interface DrillOutcome {
  exercise: Exercise;
  passed: number;
  total: number;
  elapsedSeconds: number;
  score: number;
  abandoned: boolean;
}

const LOCKFILE_TEXT = `This directory is an Atrophy drill in progress.

AI OFF, honor system: no Copilot, no chat models, no AI autocomplete.
The whole point is measuring what YOU can do unaided. Search engines and
official docs are fine; generated code is not.
`;

/** Run one drill for any exercise kind. `solutionOverride` grades a
 *  pre-written answer file instead of going interactive (scripting/tests). */
export async function runDrill(
  ex: Exercise,
  solutionOverride?: string,
): Promise<DrillOutcome> {
  switch (ex.kind) {
    case "write":
    case "fix":
    case "write-harness":
    case "fix-harness":
      return codeDrill(ex, solutionOverride);
    case "predict-output":
      return predictDrill(ex, solutionOverride);
    case "cloze":
      return clozeDrill(ex, solutionOverride);
    case "outline":
      return outlineDrill(ex, solutionOverride);
    case "recall":
      return recallDrill(ex, solutionOverride);
  }
}

// ---------- shared helpers ----------

function makeOutcome(
  ex: Exercise,
  passed: number,
  elapsedSeconds: number,
  abandoned = false,
): DrillOutcome {
  const total = totalUnits(ex);
  return {
    exercise: ex,
    passed: abandoned ? 0 : passed,
    total,
    elapsedSeconds,
    score: abandoned ? 0 : exerciseScore(passed, total, elapsedSeconds, ex.softTimeLimitSeconds),
    abandoned,
  };
}

function printHeader(ex: Exercise): void {
  console.log(pc.bold(`\n${ex.title}`) + pc.dim(`  [${ex.axis} · ${ex.language} · tier ${ex.tier}]`));
  console.log(pc.dim("─".repeat(60)));
  console.log(ex.prompt.trim());
  console.log(pc.dim("─".repeat(60)));
}

/** Print an exercise without running or recording it (`drill --show`). */
export function previewExercise(ex: Exercise): void {
  printHeader(ex);
  switch (ex.kind) {
    case "write":
    case "fix":
    case "write-harness":
    case "fix-harness":
      console.log(pc.dim("starter code:"));
      console.log(ex.starterCode.trim());
      break;
    case "predict-output":
      console.log(ex.snippet.trimEnd());
      console.log(pc.dim("─".repeat(60)));
      console.log(pc.dim("(you would predict this program's exact stdout)"));
      break;
    case "cloze":
      console.log(ex.snippet.trimEnd());
      console.log(pc.dim("─".repeat(60)));
      console.log(pc.dim("(you would fill the ____ blank)"));
      break;
    case "outline":
      console.log(pc.dim(`(you would outline an approach, self-scored against ${ex.rubric.length} rubric points)`));
      break;
    case "recall":
      console.log(pc.dim("(you would type a short answer; numeric forms like 1/4, 0.25, 25% are equivalent)"));
      break;
  }
  console.log(
    pc.dim(`\nid: ${ex.id}  ·  soft limit ${Math.round(ex.softTimeLimitSeconds / 60)} min  ·  preview only, not graded`),
  );
}

function printTimer(ex: Exercise): void {
  console.log(
    pc.yellow("AI off. ") +
      `Soft limit ${Math.round(ex.softTimeLimitSeconds / 60)} min - timer started.`,
  );
}

/** VS Code is the most common case - use it when no editor is configured. */
function detectVsCode(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(finder, ["code"], { stdio: "ignore", shell: true });
    return r.status === 0 ? "code" : null;
  } catch {
    return null;
  }
}

function openEditor(file: string): boolean {
  const editor =
    process.env.ATROPHY_EDITOR ||
    process.env.VISUAL ||
    process.env.EDITOR ||
    detectVsCode();
  if (!editor) return false;
  // Fire and forget: the drill timer runs while the user edits.
  const child = spawn(editor, [file], {
    stdio: "ignore",
    detached: true,
    shell: true,
  });
  child.on("error", () => {});
  child.unref();
  return true;
}

/** The three-step contract shown before every editor-based drill. */
function printEditorInstructions(file: string, opened: boolean, what: string): void {
  console.log(`\n  1. ${opened ? "Your editor just opened" : "Open"} ${pc.cyan(file)}`);
  console.log(`  2. Write ${what} there and ${pc.bold("save the file")}`);
  console.log(`  3. Come back here and press ${pc.bold("Enter")} - don't type code into this terminal`);
  if (!opened) {
    console.log(pc.dim("     (set $ATROPHY_EDITOR to auto-open next time, e.g. setx ATROPHY_EDITOR code)"));
  }
}

function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-"));
  writeFileSync(join(dir, "AI-OFF.lock"), LOCKFILE_TEXT, "utf8");
  return fn(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  });
}

function withReadline<T>(fn: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return fn(rl).finally(() => rl.close());
}

/** Read a multi-line answer terminated by a lone "." line. */
async function readMultiline(rl: Interface): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("");
    if (line.trim() === ".") return lines.join("\n");
    lines.push(line);
  }
}

// ---------- write / fix (editor + hidden tests) ----------

function commentPrefix(ex: CodeLikeExercise): string {
  return ex.language === "python" ? "#" : "//";
}

/** fix-shaped kinds hand the user buggy code; write-shaped kinds hand them a blank slate. */
function isFixKind(ex: CodeLikeExercise): boolean {
  return ex.kind === "fix" || ex.kind === "fix-harness";
}

function buildSolutionFile(ex: CodeLikeExercise): string {
  const c = commentPrefix(ex);
  const promptLines = ex.prompt
    .trim()
    .split("\n")
    .map((l) => `${c} ${l}`.trimEnd())
    .join("\n");
  const task = isFixKind(ex) ? "Find and fix the bug below" : ex.title;
  return `${c} ${task}  [${ex.axis} / tier ${ex.tier} / ${ex.language}]
${c}
${promptLines}
${c}
${c} Soft time limit: ${Math.round(ex.softTimeLimitSeconds / 60)} min (going over shrinks the score, nothing explodes).

${ex.starterCode.trim()}
`;
}

function printFailures(result: GradeResult): void {
  if (result.harnessError) {
    console.log(pc.red("\nYour code did not run:"));
    console.log(pc.dim(result.harnessError));
    return;
  }
  for (const f of result.failures.slice(0, 3)) {
    // Exercise-supplied harnesses report named checks, not call/expected pairs:
    // their index is a failure-list ordinal, so "test #N" would be a lie.
    if (f.args === undefined) {
      console.log(pc.red(`\n✗ ${f.error ?? "check failed"}`));
      continue;
    }
    if (f.index === -1) {
      console.log(pc.red("\nCould not load your solution:"));
      console.log(pc.dim(f.error ?? "unknown error"));
      continue;
    }
    console.log(pc.red(`\n✗ test #${f.index + 1}`) + pc.dim(`  args: ${JSON.stringify(f.args)}`));
    console.log(`  expected: ${JSON.stringify(f.expected)}`);
    if (f.error) console.log(pc.dim(`  raised:   ${f.error.split("\n").pop()}`));
    else console.log(`  got:      ${JSON.stringify(f.actual)}`);
  }
  const hidden = result.failures.length - Math.min(3, result.failures.length);
  if (hidden > 0) console.log(pc.dim(`  …and ${hidden} more failing test(s)`));
}

async function codeDrill(ex: CodeLikeExercise, solutionOverride?: string): Promise<DrillOutcome> {
  return withScratchDir(async (dir) => {
    const file = join(dir, solutionFileName(ex));
    writeFileSync(file, buildSolutionFile(ex), "utf8");

    const started = Date.now();
    const elapsed = () => (Date.now() - started) / 1000;

    if (solutionOverride) {
      copyFileSync(solutionOverride, file);
      const result = await grade(ex, dir);
      const passed = result.harnessError ? 0 : result.passed;
      return makeOutcome(ex, passed, elapsed());
    }

    printHeader(ex);
    const opened = openEditor(file);
    printEditorInstructions(file, opened, isFixKind(ex) ? "the fix" : "your solution");
    printTimer(ex);

    const initialContent = buildSolutionFile(ex);
    return withReadline(async (rl) => {
      let canStop = false; // "s" only makes sense after a graded attempt
      let lastPassed = 0;
      let warnedUnchanged = false;
      for (;;) {
        const label = canStop
          ? "\n[Enter] fix & resubmit · [s] stop here · [q] abandon > "
          : "\n[Enter] submit · [q] abandon > ";
        const answer = (await rl.question(pc.bold(label))).trim().toLowerCase();
        if (answer === "q") return makeOutcome(ex, 0, elapsed(), true);
        if (answer === "s" && canStop) return makeOutcome(ex, lastPassed, elapsed());
        if (answer !== "") {
          console.log(
            pc.yellow("\nCode goes in the solution file, not this terminal:") +
              `\n  ${pc.cyan(file)}\n` +
              pc.dim("Write it there, save, then press Enter here."),
          );
          continue;
        }
        if (!warnedUnchanged && readFileSync(file, "utf8") === initialContent) {
          warnedUnchanged = true;
          console.log(
            pc.yellow("\nThe solution file hasn't changed - did you save it?") +
              `\n  ${pc.cyan(file)}\n` +
              pc.dim("Save your edits, then press Enter. (Enter again grades it as-is.)"),
          );
          continue;
        }

        const result = await grade(ex, dir);
        const passed = result.harnessError ? 0 : result.passed;
        // Whiteboard mode: one graded submission, no fix-and-resubmit loop.
        // submitPolicy has no schema default, so "not single" is the loop, not "loop".
        // A harnessError is never drill evidence though - a missing JDK, a broken
        // install or a javac error produced no graded checks, so it must not burn
        // the single submission. Those fall through and stay interactive.
        if (ex.submitPolicy === "single" && !result.harnessError) {
          if (passed === result.total) {
            console.log(pc.green(`\n✓ ${passed}/${result.total} tests passed`) + pc.dim(` in ${Math.round(elapsed())}s`));
          } else {
            console.log(pc.red(`\n${passed}/${result.total} tests passed.`) + pc.dim("  whiteboard mode: single submission, no retries"));
            printFailures(result);
          }
          return makeOutcome(ex, passed, elapsed());
        }
        if (passed === result.total) {
          console.log(pc.green(`\n✓ ${passed}/${result.total} tests passed`) + pc.dim(` in ${Math.round(elapsed())}s`));
          return makeOutcome(ex, passed, elapsed());
        }
        console.log(pc.red(`\n${passed}/${result.total} tests passed.`));
        printFailures(result);
        canStop = true;
        lastPassed = passed;
      }
    });
  });
}

// ---------- predict-output (read code, type the stdout) ----------

async function predictDrill(ex: PredictExercise, solutionOverride?: string): Promise<DrillOutcome> {
  return withScratchDir(async (dir) => {
    const started = Date.now();
    const elapsed = () => (Date.now() - started) / 1000;

    if (solutionOverride) {
      const prediction = readFileSync(solutionOverride, "utf8");
      const r = await gradePrediction(ex, dir, prediction);
      return makeOutcome(ex, r.credit, elapsed());
    }

    printHeader(ex);
    console.log(ex.snippet.trimEnd());
    console.log(pc.dim("─".repeat(60)));
    printTimer(ex);
    console.log(
      pc.bold("\nType the program's exact stdout.") +
        pc.dim(" Finish with a single '.' on its own line; 'q.' alone abandons."),
    );

    return withReadline(async (rl) => {
      const prediction = await readMultiline(rl);
      if (prediction.trim().toLowerCase() === "q") return makeOutcome(ex, 0, elapsed(), true);
      const r = await gradePrediction(ex, dir, prediction);
      if (r.error) {
        console.log(pc.red(`\n${r.error}`));
        return makeOutcome(ex, 0, elapsed(), true); // bank bug - don't punish the user
      }
      if (r.correct) {
        console.log(pc.green("\n✓ exact match") + pc.dim(` in ${Math.round(elapsed())}s`));
      } else if (r.whitespaceOnly) {
        console.log(
          pc.yellow("\n≈ Almost: the content is right, but the stdout formatting differs.") +
            pc.dim(" partial credit."),
        );
        console.log(
          pc.dim("Exact output matters here - your answer differed only in whitespace/layout. Actual:"),
        );
        console.log(pc.dim(r.actual ?? ""));
      } else {
        console.log(pc.red("\n✗ not quite.") + " Actual output:");
        console.log(pc.dim(r.actual ?? ""));
      }
      return makeOutcome(ex, r.credit, elapsed());
    });
  });
}

// ---------- cloze (fill in the blank) ----------

async function clozeDrill(ex: ClozeExercise, solutionOverride?: string): Promise<DrillOutcome> {
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;

  if (solutionOverride) {
    const answer = readFileSync(solutionOverride, "utf8").split(/\r?\n/)[0] ?? "";
    return makeOutcome(ex, gradeCloze(ex, answer) ? 1 : 0, elapsed());
  }

  printHeader(ex);
  console.log(ex.snippet.trimEnd());
  console.log(pc.dim("─".repeat(60)));
  printTimer(ex);

  return withReadline(async (rl) => {
    const answer = (await rl.question(pc.bold("\nFill the blank ____ (q to abandon) > "))).trim();
    if (answer.toLowerCase() === "q") return makeOutcome(ex, 0, elapsed(), true);
    const correct = gradeCloze(ex, answer);
    if (correct) {
      console.log(pc.green("\n✓ correct") + pc.dim(` in ${Math.round(elapsed())}s`));
    } else {
      console.log(pc.red("\n✗ nope.") + ` Accepted: ${ex.acceptedAnswers.join(" | ")}`);
    }
    return makeOutcome(ex, correct ? 1 : 0, elapsed());
  });
}

// ---------- recall (short answer, numeric-tolerant) ----------

async function recallDrill(ex: RecallExercise, solutionOverride?: string): Promise<DrillOutcome> {
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;

  const finish = (correct: boolean): DrillOutcome => {
    if (correct) console.log(pc.green("\n✓ correct") + pc.dim(` in ${Math.round(elapsed())}s`));
    else console.log(pc.red("\n✗ nope.") + ` Accepted: ${ex.acceptedAnswers.join(" | ")}`);
    // The reveal is the teaching moment, so it follows both outcomes - but only after
    // an answer: abandoning returns above, without being handed the derivation.
    if (ex.reveal) console.log(pc.dim(`\n${ex.reveal.trim()}`));
    return makeOutcome(ex, correct ? 1 : 0, elapsed());
  };

  if (solutionOverride) {
    const answer = readFileSync(solutionOverride, "utf8").split(/\r?\n/)[0] ?? "";
    return finish(gradeRecall(ex, answer));
  }

  printHeader(ex);
  printTimer(ex);

  return withReadline(async (rl) => {
    const answer = (await rl.question(pc.bold("\nYour answer (q to abandon) > "))).trim();
    if (answer.toLowerCase() === "q") return makeOutcome(ex, 0, elapsed(), true);
    return finish(gradeRecall(ex, answer));
  });
}

// ---------- outline (decomposition, self-scored against a rubric) ----------

function buildOutlineFile(ex: OutlineExercise): string {
  return `# ${ex.title}

${ex.prompt.trim()}

AI OFF. Write your outline below the line - pseudocode or bullets, 5-10 points.

---

-
`;
}

async function outlineDrill(ex: OutlineExercise, solutionOverride?: string): Promise<DrillOutcome> {
  if (solutionOverride) {
    throw new Error("--solution is not supported for outline drills (they are self-scored interactively)");
  }
  return withScratchDir(async (dir) => {
    const file = join(dir, solutionFileName(ex));
    writeFileSync(file, buildOutlineFile(ex), "utf8");

    const started = Date.now();
    const elapsed = () => (Date.now() - started) / 1000;

    printHeader(ex);
    const opened = openEditor(file);
    printEditorInstructions(file, opened, "your outline");
    printTimer(ex);

    return withReadline(async (rl) => {
      let answer: string;
      for (;;) {
        answer = (
          await rl.question(pc.bold("\n[Enter] submit outline · [q] abandon > "))
        ).trim().toLowerCase();
        if (answer === "" || answer === "q") break;
        console.log(
          pc.yellow("\nWrite the outline in the file, not this terminal:") +
            `\n  ${pc.cyan(file)}\n` +
            pc.dim("Save it, then press Enter here."),
        );
      }
      if (answer === "q") return makeOutcome(ex, 0, elapsed(), true);

      console.log(pc.bold("\nRubric - score yourself honestly:"));
      ex.rubric.forEach((point, i) => console.log(`  ${i + 1}. ${point}`));
      const n = ex.rubric.length;
      for (;;) {
        const raw = (
          await rl.question(pc.bold(`\nHow many of these ${n} points does your outline genuinely cover? (0-${n}) > `))
        ).trim();
        const covered = Number.parseInt(raw, 10);
        if (Number.isInteger(covered) && covered >= 0 && covered <= n) {
          return makeOutcome(ex, covered, elapsed());
        }
        console.log(pc.dim(`enter a number between 0 and ${n}`));
      }
    });
  });
}
