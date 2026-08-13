import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClozeExercise,
  CodeExercise,
  CodeLikeExercise,
  OutlineExercise,
  PredictExercise,
} from "../bank/schema.js";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  javaCommand,
  javacCommand,
  javaResourceDir,
  missingJdkHint,
} from "./javatool.js";
import { run, type RunResult } from "./runner.js";

export interface TestFailure {
  index: number;
  args: unknown[];
  expected: unknown;
  actual?: unknown;
  error?: string;
}

export interface GradeResult {
  passed: number;
  total: number;
  failures: TestFailure[];
  /** Harness crashed / didn't produce a result (syntax error, timeout, ...). */
  harnessError?: string;
}

const RESULT_MARKER = "ATROPHY_RESULT ";

export function solutionFileName(ex: CodeLikeExercise | OutlineExercise): string {
  if (ex.kind === "outline") return "outline.md";
  if (ex.language === "java") return "Solution.java";
  return ex.language === "python" ? "solution.py" : "solution.js";
}

export function pythonCommand(): string {
  if (process.env.ATROPHY_PYTHON) return process.env.ATROPHY_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

function pythonHarness(ex: CodeExercise): string {
  const tests = JSON.stringify(ex.tests);
  return `import importlib.util, json, sys, traceback

spec = importlib.util.spec_from_file_location("solution", "solution.py")
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
    fn = getattr(mod, ${JSON.stringify(ex.functionName)})
except Exception:
    print("ATROPHY_RESULT " + json.dumps({
        "passed": 0, "total": ${ex.tests.length},
        "failures": [{"index": -1, "args": [], "expected": None,
                      "error": traceback.format_exc(limit=3)}]
    }))
    sys.exit(0)

tests = json.loads(${JSON.stringify(tests)})
def canon(v):
    return json.dumps(v, sort_keys=True, default=str)

failures = []
passed = 0
for i, t in enumerate(tests):
    try:
        actual = fn(*t["args"])
        actual = json.loads(json.dumps(actual, default=str))  # tuples -> lists etc.
        if canon(actual) == canon(t["expected"]):
            passed += 1
        else:
            failures.append({"index": i, "args": t["args"],
                             "expected": t["expected"], "actual": actual})
    except Exception:
        failures.append({"index": i, "args": t["args"], "expected": t["expected"],
                         "error": traceback.format_exc(limit=2)})

print("ATROPHY_RESULT " + json.dumps({"passed": passed, "total": len(tests),
                                      "failures": failures}))
`;
}

function nodeHarness(ex: CodeExercise): string {
  const tests = JSON.stringify(ex.tests);
  return `const path = require("node:path");
let fn;
const total = ${ex.tests.length};
const emit = (r) => console.log("ATROPHY_RESULT " + JSON.stringify(r));
try {
  const mod = require(path.join(__dirname, "solution.js"));
  fn = mod[${JSON.stringify(ex.functionName)}];
  if (typeof fn !== "function") {
    throw new Error(${JSON.stringify(ex.functionName)} + " is not exported (keep the module.exports line)");
  }
} catch (err) {
  emit({ passed: 0, total, failures: [{ index: -1, args: [], expected: null, error: String(err && err.stack || err) }] });
  process.exit(0);
}

const tests = JSON.parse(${JSON.stringify(tests)});
const canon = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
  }
  return v;
}

let passed = 0;
const failures = [];
tests.forEach((t, i) => {
  try {
    let actual = fn(...t.args);
    actual = actual === undefined ? null : JSON.parse(JSON.stringify(actual));
    if (canon(actual) === canon(t.expected)) passed += 1;
    else failures.push({ index: i, args: t.args, expected: t.expected, actual });
  } catch (err) {
    failures.push({ index: i, args: t.args, expected: t.expected, error: String(err && err.stack || err).split("\\n").slice(0, 3).join("\\n") });
  }
});
emit({ passed, total, failures });
`;
}

/**
 * Turn a finished harness run into a GradeResult: the timeout wins, then the
 * last ATROPHY_RESULT line, then whatever the process said before dying.
 * Shared by every language path so they fail the same way.
 */
function parseMarker(result: RunResult, total: number, timeoutMs: number): GradeResult {
  if (result.timedOut) {
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: `tests timed out after ${timeoutMs} ms (infinite loop?)`,
    };
  }

  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: detail || `harness produced no result (exit ${result.exitCode})`,
    };
  }
  return JSON.parse(line.slice(RESULT_MARKER.length)) as GradeResult;
}

/** javac + java with friendly errors; returns a GradeResult on failure, or the run result. */
async function compileAndRunJava(
  dir: string,
  sources: string[],
  mainClass: string,
  total: number,
  timeoutMs: number,
): Promise<{ error: GradeResult } | { result: RunResult }> {
  const fail = (harnessError: string) => ({ error: { passed: 0, total, failures: [], harnessError } });

  let compile;
  try {
    // Compile gets its own budget: javac time is not the user's thinking time.
    // -J pins javac's own JVM locale so diagnostics read the same on every host,
    // the way JAVA_RUNTIME_FLAGS pins the graded run.
    compile = await run(
      javacCommand(),
      ["-J-Duser.language=en", "-J-Duser.country=US", "-encoding", "UTF-8", ...sources],
      { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS },
    );
  } catch (err) {
    return fail(`${missingJdkHint(javacCommand())} (${(err as Error).message})`);
  }
  if (compile.timedOut) return fail(`javac timed out after ${JAVA_COMPILE_TIMEOUT_MS} ms`);
  if (compile.exitCode !== 0) {
    const detail = (compile.stderr || compile.stdout).trim().slice(0, 2000);
    return fail(`javac: ${detail || `exited ${compile.exitCode}`}`);
  }

  let result;
  try {
    result = await run(javaCommand(), [...JAVA_RUNTIME_FLAGS, mainClass], { cwd: dir, timeoutMs });
  } catch (err) {
    return fail(`${missingJdkHint(javaCommand())} (${(err as Error).message})`);
  }
  return { result };
}

/** Java write/fix: the shipped reflection harness reads tests.json and calls Solution. */
async function gradeJavaTests(ex: CodeExercise, dir: string): Promise<GradeResult> {
  const total = ex.tests.length;
  try {
    copyFileSync(join(javaResourceDir(), "Harness.java"), join(dir, "Harness.java"));
    writeFileSync(
      join(dir, "tests.json"),
      JSON.stringify({ functionName: ex.functionName, tests: ex.tests }),
      "utf8",
    );
  } catch (err) {
    // javaResourceDir() throws on a broken install; the drill loop has no catch, so
    // an escaping error would kill the session and the user's in-progress work.
    return { passed: 0, total, failures: [], harnessError: `could not stage the Java harness: ${(err as Error).message}` };
  }
  const outcome = await compileAndRunJava(dir, ["Solution.java", "Harness.java"], "Harness", total, ex.testTimeoutMs);
  if ("error" in outcome) return outcome.error;
  return parseMarker(outcome.result, total, ex.testTimeoutMs);
}

/**
 * Grade the solution file sitting in `dir` against the exercise's hidden tests.
 * Writes the language harness next to it and runs it in a subprocess.
 */
export async function grade(ex: CodeExercise, dir: string): Promise<GradeResult> {
  if (ex.language === "java") return gradeJavaTests(ex, dir);

  const isPy = ex.language === "python";
  const harnessName = isPy ? "__atrophy_harness__.py" : "__atrophy_harness__.cjs";
  writeFileSync(join(dir, harnessName), isPy ? pythonHarness(ex) : nodeHarness(ex), "utf8");

  const cmd = isPy ? pythonCommand() : process.execPath;
  let result;
  try {
    result = await run(cmd, [harnessName], { cwd: dir, timeoutMs: ex.testTimeoutMs });
  } catch (err) {
    return {
      passed: 0,
      total: ex.tests.length,
      failures: [],
      harnessError: `could not start ${cmd}: ${(err as Error).message}`,
    };
  }
  return parseMarker(result, ex.tests.length, ex.testTimeoutMs);
}

/** Canonicalize program output: CRLF→LF, strip per-line trailing space + outer blank lines. */
export function normalizeOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

export interface PredictionResult {
  /** Exact (normalized) match - full credit. */
  correct: boolean;
  /** Credit awarded: 1 exact, WHITESPACE_PARTIAL_CREDIT whitespace-only, else 0. */
  credit: number;
  /** True when only whitespace/layout differed: right content, wrong spacing. */
  whitespaceOnly: boolean;
  /** The snippet's real stdout (ground truth), when it ran cleanly. */
  actual?: string;
  /** The snippet itself failed to run - a bank bug, not a user mistake. */
  error?: string;
}

/** Partial credit for a right-content, wrong-whitespace code-reading answer. */
export const WHITESPACE_PARTIAL_CREDIT = 0.5;

/** Strip every whitespace character, for the whitespace-only near-miss check. */
export function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Grade a code-reading prediction: run the snippet for ground truth and
 * compare normalized stdout. Nothing to hand-maintain, nothing to drift.
 */
export async function gradePrediction(
  ex: PredictExercise,
  dir: string,
  prediction: string,
): Promise<PredictionResult> {
  const isPy = ex.language === "python";
  const file = isPy ? "snippet.py" : "snippet.js";
  writeFileSync(join(dir, file), ex.snippet, "utf8");
  const cmd = isPy ? pythonCommand() : process.execPath;
  let result;
  try {
    result = await run(cmd, [file], { cwd: dir, timeoutMs: ex.testTimeoutMs });
  } catch (err) {
    return { correct: false, credit: 0, whitespaceOnly: false, error: `could not start ${cmd}: ${(err as Error).message}` };
  }
  if (result.timedOut || result.exitCode !== 0) {
    const detail = result.timedOut ? "timed out" : result.stderr.trim().slice(0, 500);
    return {
      correct: false,
      credit: 0,
      whitespaceOnly: false,
      error: `snippet failed to run (${detail}) - please report this exercise`,
    };
  }
  const actual = normalizeOutput(result.stdout);
  if (actual === normalizeOutput(prediction)) {
    return { correct: true, credit: 1, whitespaceOnly: false, actual };
  }
  // Near-miss: identical once all whitespace is removed means the reader got the
  // content right and only the layout (e.g. Python's "[5, 4, 79]" spacing) wrong.
  const stripped = stripWhitespace(actual);
  if (stripped !== "" && stripped === stripWhitespace(prediction)) {
    return { correct: false, credit: WHITESPACE_PARTIAL_CREDIT, whitespaceOnly: true, actual };
  }
  return { correct: false, credit: 0, whitespaceOnly: false, actual };
}

/** Trim + collapse inner whitespace; cloze answers stay case-sensitive (API names are). */
export function normalizeClozeAnswer(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function gradeCloze(ex: ClozeExercise, answer: string): boolean {
  const norm = normalizeClozeAnswer(answer);
  return ex.acceptedAnswers.some((a) => normalizeClozeAnswer(a) === norm);
}
