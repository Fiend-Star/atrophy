import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isHarness, isShellWrite, isSqlWrite, stagedFileKeyProblem } from "../bank/schema.js";
import type {
  CodeLikeExercise,
  HarnessExercise,
  OutlineExercise,
  PredictExercise,
  RecallExercise,
  ShellCase,
  ShellWriteExercise,
  SqlWriteExercise,
  TestedExercise,
} from "../bank/schema.js";
import { bashCommand, missingBashHint, PINNED_TOOLS, SHELL_ENV } from "./bashtool.js";
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
  /** Absent for exercise-supplied harnesses: an Atrophy check is a named assertion, not a call. */
  args?: unknown[];
  expected?: unknown;
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
  if (ex.language === "sql") return "solution.sql";
  if (ex.language === "shell") return "solution.sh";
  return ex.language === "python" ? "solution.py" : "solution.js";
}

export function pythonCommand(): string {
  if (process.env.ATROPHY_PYTHON) return process.env.ATROPHY_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
}

function pythonHarness(ex: TestedExercise): string {
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

function nodeHarness(ex: TestedExercise): string {
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
 * The result-set canonicalization the sql harness uses, kept as source text because
 * that harness runs in a child process and cannot import the schema. On the unordered
 * path it must agree byte-for-byte with `canonicalRows` in bank/schema.ts - that is the
 * function deciding at parse time whether two cases are distinguishable, so a drift here
 * would let an exercise ship whose cases the grader cannot actually tell apart.
 * `grader.sql.test.ts` evaluates this string against it.
 */
export const SQL_CANON_SOURCE = `const canonicalRow = (row) => {
  const sorted = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return JSON.stringify(sorted);
};
const canonicalRows = (rows, ordered) => {
  const canonical = rows.map(canonicalRow);
  if (!ordered) canonical.sort();
  return JSON.stringify(canonical);
};`;

/**
 * sql write: run the user's query against every case's own fresh in-memory database
 * and compare result sets. better-sqlite3 is a dependency of the CLI, not of the temp
 * dir the child runs in, so the absolute resolved path is baked into the script.
 */
function sqlHarnessScript(ex: SqlWriteExercise, solutionFile: string): string {
  const betterSqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
  return `const path = require("node:path");
const { readFileSync } = require("node:fs");
let Database, sql;
try {
  Database = require(${JSON.stringify(betterSqlitePath)});
  sql = readFileSync(path.join(__dirname, ${JSON.stringify(solutionFile)}), "utf8");
} catch (err) {
  // Deliberately no ATROPHY_RESULT line: a broken install is not evidence about the
  // user, and parseMarker turns a marker-less run into a harnessError, not a 0/n.
  console.error("sql harness could not start: " + String(err && err.message || err));
  process.exit(1);
}

const cases = ${JSON.stringify(ex.cases)};
const ordered = ${JSON.stringify(ex.ordered === true)};
${SQL_CANON_SOURCE}
const msg = (err) => String(err && err.message || err);
const preview = (rows) => {
  const s = JSON.stringify(rows);
  return s.length > 300 ? s.slice(0, 300) + "..." : s;
};

// One case has three possible verdicts, and the third is the important one: the
// exercise itself is broken ("bug"), which is not a score at all.
const runCase = (c, i) => {
  const db = new Database(":memory:");
  try {
    try {
      db.exec(c.fixture);
      // The fixture is bank-authored and has just run; everything after it is the
      // user's answer, and an answer is a read. query_only turns a DELETE-then-SELECT
      // "solution" into a named error instead of a pass.
      db.pragma("query_only = 1");
    } catch (err) {
      // A fixture that will not build is nothing the user did.
      return { bug: "case " + (i + 1) + " fixture failed: " + msg(err) };
    }
    try {
      const rows = db.prepare(sql).all();
      if (canonicalRows(rows, ordered) === canonicalRows(c.expectedRows, ordered)) return { ok: true };
      return {
        error: "case " + (i + 1) + ": wrong rows" +
          "\\n  expected: " + preview(c.expectedRows) +
          "\\n  got:      " + preview(rows),
      };
    } catch (err) {
      // A syntax error, a multi-statement submission or a write attempt is a failed
      // case, not a crash: the other cases still run and the user still gets a score.
      return { error: "case " + (i + 1) + ": " + msg(err) };
    }
  } finally {
    try { db.close(); } catch { /* the process is about to exit anyway */ }
  }
};

let passed = 0;
const failures = [];
let bug = null;
for (let i = 0; i < cases.length && bug === null; i++) {
  const verdict = runCase(cases[i], i);
  if (verdict.bug) bug = verdict.bug;
  else if (verdict.ok) passed += 1;
  else failures.push({ index: i, error: verdict.error });
}

const emit = (r) => console.log("ATROPHY_RESULT " + JSON.stringify(r));
// A bank bug voids the whole attempt instead of reporting the cases that did grade:
// \`passed\` is what reaches the rating, and "1/2, because case 2 is malformed" is
// indistinguishable to the user from their own half-right answer.
if (bug !== null) {
  emit({
    passed: 0,
    total: cases.length,
    failures: [],
    harnessError: "exercise bug: " + bug + " - please report this exercise",
  });
} else {
  emit({ passed, total: cases.length, failures });
}
`;
}

/** A sql write has no interpreter to find: SQLite is bundled, so this lane always runs. */
async function gradeSql(ex: SqlWriteExercise, dir: string): Promise<GradeResult> {
  const total = ex.cases.length;
  const harnessName = "__atrophy_sql_harness__.cjs";
  try {
    writeFileSync(join(dir, harnessName), sqlHarnessScript(ex, solutionFileName(ex)), "utf8");
  } catch (err) {
    // resolve() of better-sqlite3 throws on a broken install, and the drill loop has
    // no catch: report it the way gradeJavaTests reports a missing resource dir.
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: `could not stage the sql harness: ${(err as Error).message}`,
    };
  }
  let result;
  try {
    result = await run(process.execPath, [harnessName], { cwd: dir, timeoutMs: ex.testTimeoutMs });
  } catch (err) {
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: `could not start ${process.execPath}: ${(err as Error).message}`,
    };
  }
  return parseMarker(result, total, ex.testTimeoutMs);
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
  // The marker line is pack-authored on the testCode path, so it is untrusted input:
  // an unterminated object (SyntaxError) or a bare `null` (which every downstream
  // property read would throw on) must come back as a result, not as an exception
  // thrown through grade() and out of the live drill loop.
  const unparseable: GradeResult = {
    passed: 0,
    total,
    failures: [],
    harnessError: "harness printed an unparseable ATROPHY_RESULT line - please report this exercise",
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(RESULT_MARKER.length));
  } catch {
    return unparseable;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unparseable;
  const graded = parsed as GradeResult;
  // A hand-rolled harness may omit an empty failures list; printFailures indexes it,
  // and reads .args off each element - a null entry would throw there, mid-drill.
  return {
    ...graded,
    // `passed` becomes a score and a stored column, so it has to be a number on every
    // language path, not just the harness one: an absent or non-numeric count reaching
    // recordSession as undefined throws on the better-sqlite3 bind and loses a rep the
    // user already earned. Non-finite is not evidence of anything - it scores 0.
    passed: Number.isFinite(graded.passed) ? graded.passed : 0,
    failures: Array.isArray(graded.failures)
      ? graded.failures.filter((f) => f !== null && typeof f === "object")
      : [],
  };
}

/**
 * runner.ts stops appending output once it holds 256 KB, and the cap is private to that
 * module - so it is mirrored here rather than imported. A capped run is the one mismatch
 * that is not about the answer (a runaway loop's first 256 KB will not equal anything an
 * exercise expects), so the failure has to say so instead of reading as a mystery.
 * `grader.shell.test.ts` pins the mirror against a real over-cap run.
 */
const RUNNER_OUTPUT_CAP = 256 * 1024;

/** Did the runner cut this output off? Its cap check runs *before* appending a chunk. */
export function shellOutputTruncated(stdout: string): boolean {
  return stdout.length >= RUNNER_OUTPUT_CAP;
}

/** How much of a mismatch to show before "..." - the sql preview budget. */
const SHELL_PREVIEW_CHARS = 300;

/** One finished shell case, as the failure builder sees it: no run, no fs, no bash. */
export interface ShellCaseReport {
  /** 1-based, because it is printed. */
  caseNumber: number;
  expectedStdout: string;
  stdout: string;
  expectedExitCode: number;
  exitCode: number | null;
  stderr: string;
  /** The runner hit its output cap: the mismatch may be the cap rather than the answer. */
  truncated: boolean;
}

function shellPreview(s: string): string {
  // Quoted: in a pipeline drill the layout is half the answer, so "a\nb" vs "a b" has
  // to be visible as a difference rather than as two lines the reader aligns by eye.
  const quoted = JSON.stringify(s);
  return quoted.length > SHELL_PREVIEW_CHARS ? `${quoted.slice(0, SHELL_PREVIEW_CHARS)}...` : quoted;
}

/**
 * The whole verdict for one shell case: `undefined` when it passed, otherwise the line
 * the drill prints. Comparison and naming live in one function on purpose - the message
 * has to name exactly what differed, which a builder that did not decide could not do.
 *
 * `WHITESPACE_PARTIAL_CREDIT` deliberately has no counterpart here: it is predict-output's
 * rule, and in a pipeline drill the column alignment often *is* the answer.
 */
export function shellCaseFailure(r: ShellCaseReport): string | undefined {
  const outputMatches = normalizeOutput(r.stdout) === normalizeOutput(r.expectedStdout);
  const statusMatches = r.exitCode === r.expectedExitCode;
  if (outputMatches && statusMatches) return undefined;

  // null is what the runner reports for a signal kill; a bare "null" would read as a
  // number the user was supposed to produce.
  const got = r.exitCode === null ? "killed by a signal" : String(r.exitCode);
  const what = [
    ...(outputMatches ? [] : ["wrong stdout"]),
    ...(statusMatches ? [] : [`wrong exit status (expected ${r.expectedExitCode}, got ${got})`]),
  ];
  const lines = [`case ${r.caseNumber}: ${what.join(", ")}`];
  if (!outputMatches) {
    lines.push(`  expected: ${shellPreview(normalizeOutput(r.expectedStdout))}`);
    lines.push(`  got:      ${shellPreview(normalizeOutput(r.stdout))}`);
  }
  if (r.truncated) {
    lines.push(`  (output was capped at ${RUNNER_OUTPUT_CAP} characters - the script printed far more than the drill asks for)`);
  }
  const stderr = r.stderr.trim();
  if (stderr) lines.push(`  stderr: ${stderr.slice(0, 500)}`);
  return lines.join("\n");
}

/**
 * The P2 signature: which `PINNED_TOOLS` members bash reported missing. A drill may
 * assume every one of them, so a `command not found` naming one is a broken toolchain -
 * never evidence about the user. A name outside the set is an ordinary failure: the
 * answer reached for a tool the contract does not provide.
 *
 * `LC_ALL=C` is what makes matching the English message sound; SHELL_ENV pins it.
 */
export function missingPinnedTools(stderr: string): string[] {
  const found = new Set<string>();
  for (const m of stderr.matchAll(/([^\s:]+): command not found/g)) {
    const name = m[1]!;
    if (PINNED_TOOLS.includes(name)) found.add(name);
  }
  return [...found];
}

/**
 * The GradeResult a shell attempt collapses to when bash itself is the problem - the two
 * ways that happens (nothing resolved, or the spawn rejected) say the same thing to the
 * user, and neither is a score.
 */
export function bashUnavailable(total: number, cmd?: string, cause?: Error): GradeResult {
  const detail = cause ? ` (${cause.message})` : "";
  return { passed: 0, total, failures: [], harnessError: `${missingBashHint(cmd)}${detail}` };
}

/**
 * Build one case's world: its own directory, its `files` written by Node (never by a shell
 * prelude - that would need the very tools the drill is testing), then the submitted
 * script over the top. Returns a harnessError message, or undefined when the case is ready.
 */
function stageShellCase(caseDir: string, c: ShellCase, scriptName: string, script: string): string | undefined {
  try {
    // Cleared, not just created: the drill loop re-grades in the same temp dir on every
    // resubmit, so a case that writes a file would otherwise find it already there on the
    // second attempt - the same leak between attempts that fresh dirs prevent between cases.
    rmSync(caseDir, { recursive: true, force: true });
    mkdirSync(caseDir, { recursive: true });
    for (const [key, contents] of Object.entries(c.files ?? {})) {
      // Parse already rejected these keys. The assertion is here because an exercise can
      // reach the grader without having come through the schema, and "../x" would write
      // outside the case's world - the one staging bug that is not self-limiting.
      const problem = stagedFileKeyProblem(key);
      if (problem) return `exercise bug: files key "${key}" ${problem} - please report this exercise`;
      const target = join(caseDir, key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    }
    writeFileSync(join(caseDir, scriptName), script, "utf8");
  } catch (err) {
    return `could not stage the shell case: ${(err as Error).message}`;
  }
  return undefined;
}

/**
 * shell write: run the submitted script once per case, each in a directory of its own,
 * and compare stdout and exit status here in TypeScript. There is no harness and no
 * marker line - bash would have to serialize JSON to produce one, and everything the
 * comparison needs already crosses the process boundary as stdout, stderr and a status.
 *
 * `env` is a parameter only so a test can grade against a fabricated `ATROPHY_BASH`:
 * `bashCommand` bypasses its cache for an injected env, which is also why the default
 * has to stay `process.env` - a multi-case drill must not re-resolve bash per case.
 */
export async function gradeShell(
  ex: ShellWriteExercise,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GradeResult> {
  const total = ex.shellCases.length;
  const bash = bashCommand(env);
  if (!bash) return bashUnavailable(total);

  const scriptName = solutionFileName(ex);
  let script: string;
  try {
    // Rule 1: msys bash tolerates CRLF and glibc bash does not, so the same submission
    // would pass on Windows and fail on Linux. Strip the CRs and the answer is one answer.
    script = readFileSync(join(dir, scriptName), "utf8").replace(/\r/g, "");
  } catch (err) {
    return { passed: 0, total, failures: [], harnessError: `could not read ${scriptName}: ${(err as Error).message}` };
  }

  // One pinned environment for the whole attempt: an unpinned PATH does not merely hide
  // the coreutils, it swaps System32's `sort` and `find` in, which answer wrongly with a
  // clean stderr and exit 0. No signature catches that afterwards - the pin is the defense.
  const shellEnv = SHELL_ENV(bash, env);
  const failures: TestFailure[] = [];
  let passed = 0;

  for (const [index, c] of ex.shellCases.entries()) {
    const caseNumber = index + 1;
    const caseDir = join(dir, `case-${caseNumber}`);
    const staging = stageShellCase(caseDir, c, scriptName, script);
    if (staging) return { passed: 0, total, failures: [], harnessError: staging };

    let result: RunResult;
    try {
      // argv, not a command line: the args reach the script as positional parameters
      // with no shell in between, and the script itself is named relative to its own
      // directory so `$0` reads the same on every host.
      result = await run(bash, [scriptName, ...(c.args ?? [])], {
        cwd: caseDir,
        timeoutMs: ex.testTimeoutMs,
        env: shellEnv,
      });
    } catch (err) {
      return bashUnavailable(total, bash, err as Error);
    }

    // Both of these void the attempt rather than scoring the cases that did grade: a
    // partial score is indistinguishable to the user from a half-right answer, and
    // neither a killed run nor a broken toolchain is evidence about them.
    if (result.timedOut) {
      return {
        passed: 0,
        total,
        failures: [],
        harnessError: `case ${caseNumber} timed out after ${ex.testTimeoutMs} ms (infinite loop?)`,
      };
    }
    const missing = missingPinnedTools(result.stderr);
    if (missing.length > 0) {
      return {
        passed: 0,
        total,
        failures: [],
        harnessError:
          `case ${caseNumber}: bash could not find ${missing.join(", ")}, which every shell drill may use - ` +
          `this is a broken bash install or PATH (${bash}), not your answer`,
      };
    }

    const failure = shellCaseFailure({
      caseNumber,
      expectedStdout: c.expectedStdout,
      stdout: result.stdout,
      expectedExitCode: c.expectedExitCode ?? 0,
      exitCode: result.exitCode,
      stderr: result.stderr,
      truncated: shellOutputTruncated(result.stdout),
    });
    if (failure) failures.push({ index, error: failure });
    else passed += 1;
  }

  return { passed, total, failures };
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
async function gradeJavaTests(ex: TestedExercise, dir: string): Promise<GradeResult> {
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
 * Java behavioral drills: the exercise ships its own `public class Harness`, compiled
 * alongside the solution and the Atrophy helper. The harness owns what "passing" means
 * (races, deadlocks, invariants), so the only thing we police is that it graded the
 * number of checks the exercise declared.
 */
async function gradeHarness(ex: HarnessExercise, dir: string): Promise<GradeResult> {
  const total = ex.totalChecks;
  try {
    writeFileSync(join(dir, "Harness.java"), ex.testCode, "utf8");
    copyFileSync(join(javaResourceDir(), "Atrophy.java"), join(dir, "Atrophy.java"));
  } catch (err) {
    // Same contract as gradeJavaTests: the drill loop has no catch, so a broken
    // install must come back as a result instead of ending the session.
    return { passed: 0, total, failures: [], harnessError: `could not stage the Java harness: ${(err as Error).message}` };
  }
  const outcome = await compileAndRunJava(
    dir,
    ["Solution.java", "Harness.java", "Atrophy.java"],
    "Harness",
    total,
    ex.testTimeoutMs,
  );
  if ("error" in outcome) return outcome.error;
  const parsed = parseMarker(outcome.result, total, ex.testTimeoutMs);
  if (!parsed.harnessError && parsed.total !== ex.totalChecks) {
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: `exercise bug: harness reported ${parsed.total} checks but the exercise declares ${ex.totalChecks} - please report this exercise`,
    };
  }
  // Clamp what gets rendered and persisted: the count is pack-authored, and
  // exerciseScore's clamp only protects the rating, not the stored row or "7/2 passed".
  // Non-finite (absent, null, a string, NaN) scores 0 - it is not evidence of anything.
  return {
    ...parsed,
    passed: Number.isFinite(parsed.passed) ? Math.min(Math.max(parsed.passed, 0), total) : 0,
  };
}

/**
 * Grade the solution file sitting in `dir` against the exercise's hidden tests.
 * Writes the language harness next to it and runs it in a subprocess.
 */
export async function grade(ex: CodeLikeExercise, dir: string): Promise<GradeResult> {
  if (isHarness(ex)) return gradeHarness(ex, dir);
  if (isSqlWrite(ex)) return gradeSql(ex, dir);
  if (isShellWrite(ex)) return gradeShell(ex, dir);
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
  // Java runs through the single-file source launcher (`java Main.java`): it compiles
  // in memory, so there is no javac step and no .class litter. One file only - that is
  // the launcher's limit, and predict-output snippets are single-file by design.
  const file = ex.language === "python" ? "snippet.py" : ex.language === "java" ? "Main.java" : "snippet.js";
  writeFileSync(join(dir, file), ex.snippet, "utf8");
  const cmd =
    ex.language === "python" ? pythonCommand() : ex.language === "java" ? javaCommand() : process.execPath;
  const cmdArgs = ex.language === "java" ? [...JAVA_RUNTIME_FLAGS, file] : [file];
  let result;
  try {
    result = await run(cmd, cmdArgs, { cwd: dir, timeoutMs: ex.testTimeoutMs });
  } catch (err) {
    // A missing JDK is an install problem, not a broken exercise: say how to fix it,
    // the same way compileAndRunJava does on the write/fix path.
    const detail =
      ex.language === "java"
        ? `${missingJdkHint(cmd)} (${(err as Error).message})`
        : `could not start ${cmd}: ${(err as Error).message}`;
    return { correct: false, credit: 0, whitespaceOnly: false, error: detail };
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

/**
 * Numeric-tolerant recall normalization: "1/4", "0.25", "25%" all mean 0.25.
 * A leading sign is optional everywhere a number can appear, exponents included -
 * String(1e21) is "1e+21", so the + form is what a bank author pastes.
 */
export function normalizeRecallAnswer(s: string): { num?: number; text: string } {
  const text = s.trim().toLowerCase().replace(/\s+/g, " ");
  const compact = text.replace(/\s+/g, "");
  // `num` means "the finite number this answer denotes". x/0 and overflow ("1e999")
  // are deliberately left as text: Infinity makes the tolerance below Infinity too,
  // which would accept every finite answer as a match.
  const numeric = (num: number): { num?: number; text: string } =>
    Number.isFinite(num) ? { num, text } : { text };

  const pct = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(compact);
  if (pct) return numeric(Number.parseFloat(pct[1]!) / 100);
  const frac = /^([+-]?(?:\d+\.?\d*|\.\d+))\/((?:\d+\.?\d*|\.\d+))$/.exec(compact);
  if (frac) {
    const denominator = Number.parseFloat(frac[2]!);
    if (denominator !== 0) return numeric(Number.parseFloat(frac[1]!) / denominator);
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(compact)) {
    return numeric(Number.parseFloat(compact));
  }
  return { text };
}

export function gradeRecall(ex: RecallExercise, answer: string): boolean {
  const given = normalizeRecallAnswer(answer);
  return ex.acceptedAnswers.some((accepted) => {
    const want = normalizeRecallAnswer(accepted);
    // An answer typed exactly as the bank wrote it is right whatever normalization
    // makes of it - including the forms that carry no number at all ("1/0", "O(n)").
    if (given.text === want.text) return true;
    if (given.num !== undefined && want.num !== undefined) {
      return Math.abs(given.num - want.num) <= 1e-9 * Math.max(1, Math.abs(want.num));
    }
    return false;
  });
}
