import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { loadBank, type CodeExercise } from "../bank/schema.js";
import { grade, pythonCommand, solutionFileName } from "../engine/grader.js";
import { MIN_JDK_MAJOR, javacCommand, missingJdkHint, parseJavaMajor } from "../engine/javatool.js";
import { Store } from "../store/db.js";
import { DEFAULT_LEADERBOARD_URL, syncDisabled } from "./publish.js";

/**
 * `atrophy doctor`: environment self-diagnosis. Each check is small and
 * independent; the pure ones are unit-tested. Nothing here ever throws - a
 * broken environment is exactly what we are trying to report, not crash on.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const MIN_NODE_MAJOR = 22;

/** Node runtime meets the engines requirement. */
export function checkNode(version: string = process.version): CheckResult {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) {
    return { name: "Node.js", status: "warn", detail: `could not parse version "${version}"` };
  }
  return major >= MIN_NODE_MAJOR
    ? { name: "Node.js", status: "pass", detail: `${version} (>= ${MIN_NODE_MAJOR})` }
    : { name: "Node.js", status: "fail", detail: `${version} - Atrophy needs Node >= ${MIN_NODE_MAJOR}` };
}

function detectVsCode(): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(finder, ["code"], { stdio: "ignore", shell: true }).status === 0;
  } catch {
    return false;
  }
}

/** An editor is resolvable for opening drills. `hasVsCode` is injectable for tests. */
export function checkEditor(
  env: NodeJS.ProcessEnv = process.env,
  hasVsCode: boolean = detectVsCode(),
): CheckResult {
  const configured = env.ATROPHY_EDITOR || env.VISUAL || env.EDITOR;
  if (configured) return { name: "Editor", status: "pass", detail: String(configured) };
  if (hasVsCode) return { name: "Editor", status: "pass", detail: "VS Code (code) detected" };
  return {
    name: "Editor",
    status: "warn",
    detail: "none found - set $ATROPHY_EDITOR (e.g. code); drills fall back to manual open",
  };
}

/** Python interpreter is present and runnable (Python drills need it). */
export function checkPython(): CheckResult {
  const cmd = pythonCommand();
  try {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0) {
      const v = (r.stdout || r.stderr || "").trim();
      return { name: "Python", status: "pass", detail: `${cmd}: ${v}` };
    }
  } catch {
    /* fall through to warn */
  }
  return {
    name: "Python",
    status: "warn",
    detail: `${cmd} not runnable - JavaScript drills still work; set $ATROPHY_PYTHON for Python ones`,
  };
}

/**
 * The number people call this JDK. Legacy builds print "1.8.0_452" and
 * parseJavaMajor faithfully returns 1; the 1.x scheme only ever covered Java
 * 5-8, so the second component is the name to show a human.
 */
function humanMajor(major: number, versionOutput: string): number {
  if (major !== 1) return major;
  const legacy = /\b1\.(\d+)/.exec(versionOutput);
  return legacy ? Number.parseInt(legacy[1]!, 10) : major;
}

/**
 * The render half of `checkJava`, split out so the spawn is the only untested
 * part. A JDK that answered but printed something we cannot parse still passes:
 * a false alarm here is worse than a missed old JDK, which the compile step
 * would report anyway.
 */
export function javaCheckResult(cmd: string, versionOutput: string): CheckResult {
  const version = versionOutput.trim();
  const major = parseJavaMajor(version);
  if (major !== null && major < MIN_JDK_MAJOR) {
    return {
      name: "Java (JDK)",
      status: "warn",
      detail: `${cmd}: Java ${humanMajor(major, version)} - Java drills need JDK >= ${MIN_JDK_MAJOR} (Python/JavaScript drills are unaffected)`,
    };
  }
  return { name: "Java (JDK)", status: "pass", detail: version ? `${cmd}: ${version}` : cmd };
}

/**
 * JDK present and modern enough for Java drills. Warn-only: py/js drills are
 * unaffected. Probes directly rather than via `hasJdk()`, whose per-process
 * cache would answer for whatever ATROPHY_JAVA_HOME was set earlier in the run.
 */
export function checkJava(): CheckResult {
  const cmd = javacCommand();
  try {
    const r = spawnSync(cmd, ["-version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    // JDK 8 prints -version to stderr; 9+ to stdout
    if (r.status === 0) return javaCheckResult(cmd, r.stdout || r.stderr || "");
  } catch {
    /* fall through to warn */
  }
  return { name: "Java (JDK)", status: "warn", detail: missingJdkHint(cmd) };
}

/**
 * SQL drills need no toolchain of their own: the same better-sqlite3 the store runs on
 * is the engine that grades them, so this reports a version rather than a search. It
 * can only fail on an install so broken that `atrophy` itself would not have started.
 */
export function checkSql(): CheckResult {
  try {
    const pkg = createRequire(import.meta.url)("better-sqlite3/package.json") as { version?: string };
    return {
      name: "SQL (SQLite)",
      status: "pass",
      detail: `better-sqlite3 ${pkg.version ?? "(unknown version)"} - bundled, nothing to install`,
    };
  } catch (err) {
    return { name: "SQL (SQLite)", status: "fail", detail: `better-sqlite3 not loadable: ${(err as Error).message}` };
  }
}

/** The SQLite store opens and is writable. */
export function checkDb(path: string): CheckResult {
  try {
    new Store(path).close();
    return { name: "Database", status: "pass", detail: path };
  } catch (err) {
    return { name: "Database", status: "fail", detail: `cannot open ${path}: ${(err as Error).message}` };
  }
}

/**
 * The exercise bank (base dir plus any packs merged on top) loads and is
 * non-empty. `resolveError` is why the caller could not produce a dir at all -
 * a missing *pack* fails resolution too, and reporting that as "set
 * $ATROPHY_BANK" sends the user after the wrong file.
 */
export function checkBank(dir: string | string[] | null, resolveError?: string | null): CheckResult {
  if (!dir) {
    const detail = resolveError || "bank directory not found (set $ATROPHY_BANK)";
    return { name: "Exercise bank", status: "fail", detail };
  }
  try {
    const bank = loadBank(dir);
    return bank.length === 0
      ? { name: "Exercise bank", status: "fail", detail: "no exercises found" }
      : { name: "Exercise bank", status: "pass", detail: `${bank.length} exercises loaded` };
  } catch (err) {
    return { name: "Exercise bank", status: "fail", detail: (err as Error).message };
  }
}

/**
 * Every configured pack directory exists and loads cleanly. Paths come back
 * canonicalised by `packDirs`, so the report may show different casing than the
 * user typed - that is the directory actually being read.
 */
export function checkPacks(dirs: string[]): CheckResult {
  if (dirs.length === 0) return { name: "Packs", status: "pass", detail: "no packs configured" };
  const parts: string[] = [];
  for (const dir of dirs) {
    // A path that exists but is a *file* passes an existence check and then fails
    // deep inside readdir with a raw ENOTDIR; both mistakes get the same friendly line.
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      /* missing (or unreadable) - same message */
    }
    if (!isDir) {
      return {
        name: "Packs",
        status: "fail",
        detail: `${dir}: not found or not a directory (check $ATROPHY_PACKS / "packs" in your config)`,
      };
    }
    try {
      const n = loadBank(dir).length;
      parts.push(`${dir}: ${n} exercise${n === 1 ? "" : "s"}`);
    } catch (err) {
      return { name: "Packs", status: "fail", detail: `${dir}: ${(err as Error).message}` };
    }
  }
  return { name: "Packs", status: "pass", detail: parts.join(" · ") };
}

/** End-to-end sandbox check: grade a trivial correct solution in a subprocess. */
export async function checkGrading(): Promise<CheckResult> {
  const probe: CodeExercise = {
    kind: "write",
    id: "doctor-probe",
    axis: "syntax-recall",
    tier: 1,
    title: "probe",
    prompt: "probe",
    softTimeLimitSeconds: 60,
    testTimeoutMs: 8000,
    language: "javascript",
    functionName: "probe",
    starterCode: "module.exports = { probe: (a, b) => a + b };\n",
    tests: [{ args: [2, 3], expected: 5 }],
  };
  const dir = mkdtempSync(join(tmpdir(), "atrophy-doctor-"));
  try {
    writeFileSync(join(dir, solutionFileName(probe)), probe.starterCode, "utf8");
    const result = await grade(probe, dir);
    if (result.harnessError) {
      return { name: "Sandbox grading", status: "fail", detail: result.harnessError.split("\n")[0] ?? "harness error" };
    }
    return result.passed === result.total
      ? { name: "Sandbox grading", status: "pass", detail: "subprocess grading works" }
      : { name: "Sandbox grading", status: "fail", detail: `probe scored ${result.passed}/${result.total}` };
  } catch (err) {
    return { name: "Sandbox grading", status: "fail", detail: (err as Error).message };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

/** Optional connectivity check. Info only - never a hard failure. */
export async function checkLeaderboard(): Promise<CheckResult> {
  if (syncDisabled()) {
    return { name: "Leaderboard", status: "pass", detail: "sync disabled (ATROPHY_NO_SYNC)" };
  }
  const url = process.env.ATROPHY_LEADERBOARD_URL ?? DEFAULT_LEADERBOARD_URL;
  try {
    const res = await fetch(`${url}/v1/leaderboard`, { signal: AbortSignal.timeout(5000) });
    return res.ok
      ? { name: "Leaderboard", status: "pass", detail: "reachable" }
      : { name: "Leaderboard", status: "warn", detail: `HTTP ${res.status} (publishing may fail)` };
  } catch {
    return { name: "Leaderboard", status: "warn", detail: "unreachable (offline?) - drills are unaffected" };
  }
}

const BADGE: Record<CheckStatus, string> = {
  pass: pc.green("✓"),
  warn: pc.yellow("⚠"),
  fail: pc.red("✗"),
};

export function printResult(r: CheckResult): void {
  console.log(`  ${BADGE[r.status]} ${r.name.padEnd(16)} ${pc.dim(r.detail)}`);
}

export interface DoctorDeps {
  bankDir: string | string[] | null;
  /** Why `bankDir` is null, when the caller knows (see `checkBank`). */
  bankError?: string | null;
  packDirs: string[];
  dbPath: string;
}

/** Run every check, print the report, return a process exit code (0 or 1). */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  console.log(pc.bold("\n  atrophy doctor\n"));
  const results: CheckResult[] = [
    checkNode(),
    checkPython(),
    checkJava(),
    checkSql(),
    checkEditor(),
    checkDb(deps.dbPath),
    checkBank(deps.bankDir, deps.bankError),
    checkPacks(deps.packDirs),
    await checkGrading(),
    await checkLeaderboard(),
  ];
  for (const r of results) printResult(r);

  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  console.log();
  if (fails > 0) {
    console.log(
      pc.red(`  ${fails} failing check${fails === 1 ? "" : "s"}`) +
        pc.dim(` · ${warns} warning${warns === 1 ? "" : "s"}`),
    );
    console.log();
    return 1;
  }
  console.log(pc.green("  all systems go") + (warns ? pc.dim(` · ${warns} warning${warns === 1 ? "" : "s"}`) : ""));
  console.log();
  return 0;
}
