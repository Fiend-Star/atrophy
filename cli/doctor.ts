import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { LANGUAGES, loadBank, loadBankDetailed, type Axis, type CodeExercise, type Language } from "../bank/schema.js";
import { grade, pythonCommand, solutionFileName } from "../engine/grader.js";
import { MIN_JDK_MAJOR, javacCommand, missingJdkHint, parseJavaMajor } from "../engine/javatool.js";
import { Store } from "../store/db.js";
import { readConfig } from "./config.js";
import { DEFAULT_LEADERBOARD_URL, syncDisabled } from "./publish.js";
import { ambiguousTracks, resolveTracks } from "./tracks.js";

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
 * The line a drill prints when a missing JDK shrank the pool it drew from - or null
 * when this user should not hear it. Only a `--lang java` request should: for a python
 * or JS drill, hidden java content is noise about drills the user never asked for, and
 * a JDK-less host would repeat it on every single drill.
 *
 * An *empty* pool is a different message with a different rule: `drillOnce` reports
 * that one whatever the language, because "no exercises in the bank" would be a lie
 * when the drills are there and only ungradable.
 */
export function hiddenJavaNotice(hidden: number, axis: Axis, language?: Language): string | null {
  if (hidden <= 0 || language !== "java") return null;
  return `note: ${hidden} java drill(s) for "${axis}" are hidden - no JDK found (run \`atrophy doctor\`)`;
}

/** SQLite's own version, from a real query - which also proves the native addon loaded. */
function sqliteVersion(): string {
  const db = new Database(":memory:");
  try {
    const row = db.prepare("SELECT sqlite_version() AS version").get() as { version?: string } | undefined;
    return row?.version ?? "";
  } finally {
    db.close();
  }
}

/**
 * The npm package version, when it can be had. Strictly a nice-to-have beside the
 * SQLite number: `better-sqlite3/package.json` is reachable today, but a release that
 * adds an `exports` map would close that door, so it must never decide the check.
 */
function betterSqliteVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("better-sqlite3/package.json") as { version?: string };
    return pkg.version ?? "";
  } catch {
    return "";
  }
}

/**
 * SQL drills need no toolchain of their own: the same better-sqlite3 the store runs on
 * is the engine that grades them, so this reports a version rather than a search. The
 * SQLite version is the one that explains why two machines graded a query differently.
 * `probe` is injectable for tests.
 */
export function checkSql(probe: () => string = sqliteVersion): CheckResult {
  const name = "SQL (SQLite)";
  // Warn, never fail: there is nothing here for a user to go install, so exiting 1 over
  // our own probe would send them hunting for a problem they cannot fix.
  try {
    const version = probe();
    if (!version) {
      return { name, status: "warn", detail: "SQLite answered no version - sql drills may not grade" };
    }
    const pkg = betterSqliteVersion();
    return {
      name,
      status: "pass",
      detail: `SQLite ${version}${pkg ? ` via better-sqlite3 ${pkg}` : ""} - bundled, nothing to install`,
    };
  } catch (err) {
    return { name, status: "warn", detail: `SQLite probe failed: ${(err as Error).message}` };
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

/**
 * The language allowlist and track focus read from config (`~/.atrophy/config.json`
 * or `$ATROPHY_CONFIG`), plus every track discovered under `base` + `packs` and how
 * many drills each holds. Warn, never fail - like `checkSql`, there is nothing here
 * a user needs to go install; a stale or typo'd config is fixed by editing it (or
 * running the setup flow), not by treating doctor as red.
 *
 * `base` and `packs` are explicit parameters rather than a `bankRoots()` import: that
 * helper lives in cli/index.ts, which already imports from this file, and importing
 * it back here would create a cycle. The caller resolves roots the same way
 * `doctorAction` resolves `bankDir`/`packDirs` today and hands them in - mirroring how
 * `checkBank`/`checkPacks` take their directories as parameters instead of finding
 * them themselves.
 */
export function checkConfig(base: string, packs: string[], env: NodeJS.ProcessEnv = process.env): CheckResult {
  const name = "Config";
  try {
    const tracks = resolveTracks(base, packs);
    const ambiguous = new Set(ambiguousTracks(tracks));
    const counts = new Map<string, number>();
    for (const t of tracks) counts.set(t.dir, 0);
    for (const entry of loadBankDetailed([base, ...packs])) {
      counts.set(entry.root, (counts.get(entry.root) ?? 0) + 1);
    }

    let warned = false;

    // One read, reused for both fields below - configLanguages()/configTrack() each
    // read the file themselves, which would mean reading it three times over for one
    // check; their validation logic is short enough to inline against a single read.
    const config = readConfig(env);

    // languages: validation silently drops unknown entries - name what it dropped
    const rawLanguages: unknown = config.languages;
    const configuredLanguages: Language[] = Array.isArray(rawLanguages)
      ? rawLanguages.filter((l): l is Language => typeof l === "string" && (LANGUAGES as readonly string[]).includes(l))
      : [];
    let languagesLine =
      configuredLanguages.length === 0 ? "languages: all" : `languages: ${configuredLanguages.join(", ")}`;
    if (Array.isArray(rawLanguages)) {
      const known = new Set<string>(configuredLanguages);
      const dropped = rawLanguages
        .filter((l) => !(typeof l === "string" && known.has(l)))
        .map((l) => String(l));
      if (dropped.length > 0) {
        warned = true;
        languagesLine += ` - config lists unknown languages: ${dropped.join(", ")}`;
      }
    }

    // track: undefined means "all"; otherwise it must resolve to exactly one discovered track
    const rawTrack: unknown = config.track;
    const wanted = typeof rawTrack === "string" ? rawTrack.trim().toLowerCase() || undefined : undefined;
    let trackLine: string;
    if (wanted === undefined) {
      trackLine = "track: all";
    } else if (ambiguous.has(wanted)) {
      warned = true;
      const dirs = tracks.filter((t) => t.name === wanted).map((t) => t.dir);
      trackLine = `track: ${wanted} - ambiguous: ${dirs.join(", ")} (rename one via pack.json)`;
    } else {
      const match = tracks.find((t) => t.name === wanted);
      if (!match) {
        warned = true;
        trackLine = `track: ${wanted} - matches no discovered track (found: ${tracks.map((t) => t.name).join(", ")})`;
      } else {
        trackLine = `track: ${match.name} (${counts.get(match.dir) ?? 0} drills)`;
      }
    }

    const table = tracks.map((t) => `${t.name}  ${counts.get(t.dir) ?? 0} drills  ${t.dir}`).join("\n");
    const detail = `${languagesLine}\n${trackLine}\n${table}`;
    return { name, status: warned ? "warn" : "pass", detail };
  } catch (err) {
    return { name, status: "warn", detail: `config check failed: ${(err as Error).message}` };
  }
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
  /**
   * The built-in bank root (`bankRoots().base`), separate from `bankDir`'s flattened
   * base+packs list - `checkConfig` needs it to resolve tracks. Optional so an existing
   * caller that has not been updated to pass it (see `checkConfig`'s doc comment on why
   * this file cannot import `bankRoots` itself) still type-checks; the config check is
   * simply omitted from the report until a caller supplies it.
   */
  base?: string;
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
  if (deps.base !== undefined) results.push(checkConfig(deps.base, deps.packDirs));
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
