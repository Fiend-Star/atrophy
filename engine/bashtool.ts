import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Finding a bash we are willing to grade with. The `javatool.ts` sibling in shape -
 * cached probe, version floor, env-var override, a hint that names the override - but
 * with one hazard java does not have: on Windows the *name* `bash` resolves to the
 * wrong program.
 *
 * P1 (scout probe): `bash.exe` on PATH is `C:\WINDOWS\system32\bash.exe`, the WSL
 * launcher; Git Bash is not on PATH at all. So discovery on win32 never falls back to
 * a bare name - it derives the real path or gives up (and a bash-less host simply
 * hides the shell drills that need one; see MIN_BASH_MAJOR).
 */

/** bash 4 is where associative arrays land; macOS still ships 3.2 and is hidden, never nagged. */
export const MIN_BASH_MAJOR = 4;

/** Which rule in the discovery order produced the answer - doctor reports it verbatim. */
export type BashRule = "$ATROPHY_BASH" | "git --exec-path" | "well-known install" | "standard location" | "PATH";

export interface BashDiscovery {
  command: string;
  rule: BashRule;
}

/**
 * Where Git for Windows lands by default. These are data, not logic - a relocated
 * install (scoop, winget, a custom prefix) is found by the `git --exec-path`
 * derivation above them, which is why this list stays short.
 */
const WELL_KNOWN_WIN32 = [
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

const POSIX_BASH = "/bin/bash";

/**
 * The set of external commands a shell drill may assume (P14: the intersection of what
 * Git Bash's `usr/bin` ships with a normal POSIX box). A `command not found` naming one
 * of these is a broken toolchain - a harnessError, never a score against the user -
 * while one naming anything else is an ordinary failure: the drill reached for a tool
 * the contract does not provide.
 *
 * Notable absences, all verified missing from Git Bash's `usr/bin`: `jq`, `python`,
 * `curl` (it lives in `mingw64/bin`), and `rev`.
 */
export const PINNED_TOOLS: readonly string[] = Object.freeze([
  "ls", "cat", "grep", "sed", "awk", "cut", "sort", "uniq", "tr", "head", "tail", "wc",
  "find", "xargs", "tee", "printf", "seq", "basename", "dirname", "date", "sleep", "env",
  "comm", "join", "paste", "nl", "fold", "od", "mktemp", "readlink", "stat", "du", "diff",
  "tac", "split", "expr",
]);

/**
 * The `JAVA_RUNTIME_FLAGS` analog, as environment rather than argv: every graded bash
 * run gets exactly these, and `engine/runner.ts` lets `opts.env` win over the base env
 * it builds, so the PATH pin here is the PATH the script sees.
 *
 * `env` is the inherited environment to take the PATH tail from; it is a parameter so
 * tests never depend on the host's.
 */
export function SHELL_ENV(bashPath: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const tail = inheritedPath(env);
  return {
    // P6: unpinned collation makes `sort` and glob order host-dependent.
    LC_ALL: "C",
    LANG: "C",
    // P7: unpinned, `date` prints whatever zone the host sits in. The pin fixes the
    // instant but not the *name* - msys prints "GMT" where GNU coreutils prints "UTC"
    // for the same TZ=UTC - which is why fixtures are barred from `date +%Z` outright.
    TZ: "UTC",
    // P11: msys rewrites `/tmp/x`-shaped argv into a Windows path before the child sees it.
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*",
    // P2/P3: without the bash dir first, a script launched from a PowerShell parent loses
    // 33 of the 36 PINNED_TOOLS to `command not found` - and still exits 0, a silent,
    // empty-output pass. The three survivors are the real argument for pinning rather
    // than merely appending: `sort` and `find` resolve to C:\WINDOWS\system32\{sort,find}.exe,
    // different programs with different flags, so an unpinned PATH does not just hide a
    // tool - it silently swaps one in. The inherited tail follows the pin so a POSIX host
    // keeps its normal resolution.
    PATH: tail ? `${dirname(bashPath)}${delimiter}${tail}` : dirname(bashPath),
  };
}

/**
 * PATH however the host spelled it. `process.env` is case-insensitive on Windows, but a
 * spread copy of it is not: `{...process.env}.PATH` is undefined there, because the live
 * key is literally `Path`.
 */
function inheritedPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return (key ? env[key] : undefined) ?? "";
}

export function missingBashHint(cmd?: string): string {
  const what = cmd ? `${cmd} not runnable` : "no bash found";
  return `${what} - shell drills need bash >= ${MIN_BASH_MAJOR} (Git for Windows ships one). Install one or set ATROPHY_BASH to the bash binary.`;
}

/**
 * The major from `echo $BASH_VERSION` ("5.2.37(1)-release" -> 5), and from the sentence
 * `bash --version` prints ("GNU bash, version 5.2.37(1)-release ..." -> 5).
 *
 * Same anchoring as `parseJavaMajor`, for the same two reasons: the token must start at
 * a boundary, so the build number in "(1)-release" is not a candidate and "bash-5.2"
 * does not read as version 5; and the 3-digit cap keeps a line opening with a date
 * (2026-08-20) from parsing as version 2026. A shell that is not bash prints an empty
 * `$BASH_VERSION`, which yields undefined - and `hasBash` treats that as "not bash".
 */
export function parseBashMajor(out: string): number | undefined {
  const m = /(?:^|[\s"])(\d{1,3})(?=[.\-"\s]|$)/.exec(out);
  return m ? Number.parseInt(m[1]!, 10) : undefined;
}

export interface BashResolveDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Existence test for a candidate binary - injected so unit tests never probe the host. */
  exists: (path: string) => boolean;
  /** `git --exec-path`'s output, or undefined when git is absent or failed. */
  gitExecPath: () => string | undefined;
}

/**
 * `git --exec-path`, spawned the way the runner spawns: no shell, so a `.cmd` shim is
 * simply a miss (discovery falls through to the well-known installs, exactly as it does
 * when git is not installed at all).
 */
function probeGitExecPath(): string | undefined {
  try {
    const r = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status !== 0) return undefined;
    return (r.stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * P16: `git --exec-path` answers `<root>/mingw64/libexec/git-core`, so the install root
 * is three levels up and bash sits at `<root>\usr\bin\bash.exe`. This is the robust rule -
 * git is already a hard dependency of anyone using this tool, so it finds Git Bash
 * wherever scoop, winget, or a custom prefix put it.
 */
function gitBashFrom(execPath: string): string {
  return join(dirname(dirname(dirname(execPath.trim()))), "usr", "bin", "bash.exe");
}

/**
 * Resolve bash by the discovery order, with every host interaction injectable. Uncached:
 * `bashCommandDetailed` is the cached front door, and `doctor` wants a fresh answer.
 *
 * `ATROPHY_BASH` is taken verbatim (the `ATROPHY_PYTHON` shape - one binary, no `bin/`
 * layout to derive), including when it does not exist: it is the escape hatch for MSYS2,
 * Cygwin, or a deliberate WSL choice, and a wrong value is a diagnostic doctor prints
 * back rather than a value we quietly discard.
 */
export function resolveBash(deps: Partial<BashResolveDeps> = {}): BashDiscovery | undefined {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;

  const override = env.ATROPHY_BASH?.trim();
  if (override) return { command: override, rule: "$ATROPHY_BASH" };

  if (platform === "win32") {
    const execPath = (deps.gitExecPath ?? probeGitExecPath)();
    if (execPath) {
      const derived = gitBashFrom(execPath);
      if (exists(derived)) return { command: derived, rule: "git --exec-path" };
    }
    const wellKnown = WELL_KNOWN_WIN32.find(exists);
    if (wellKnown) return { command: wellKnown, rule: "well-known install" };
    // Deliberately no PATH fallback: P1.
    return undefined;
  }

  if (exists(POSIX_BASH)) return { command: POSIX_BASH, rule: "standard location" };
  return { command: "bash", rule: "PATH" };
}

/** `undefined` = not resolved yet, `null` = resolved to nothing (the javatool cache shape). */
let discoveryCache: BashDiscovery | null | undefined;

/**
 * The resolved bash plus which rule found it, once per process. An injected `env` skips
 * the cache in both directions - a test (or a caller reading someone else's environment)
 * must neither read a stale answer nor poison the process-wide one.
 */
export function bashCommandDetailed(env: NodeJS.ProcessEnv = process.env): BashDiscovery | undefined {
  if (env !== process.env) return resolveBash({ env });
  if (discoveryCache === undefined) discoveryCache = resolveBash() ?? null;
  return discoveryCache ?? undefined;
}

/** Thin projection of `bashCommandDetailed` - the path only. */
export function bashCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return bashCommandDetailed(env)?.command;
}

let bashProbe: boolean | undefined;

/**
 * One cached probe per process: is there a runnable bash at or above the floor? Unlike
 * `hasJdk`, this gates on the version too - bash 3.2 (macOS) cannot run the drills, and
 * a shell that reports no `$BASH_VERSION` is not bash. Both cases hide shell-exec
 * content rather than demanding an install.
 */
export function hasBash(): boolean {
  if (bashProbe === undefined) {
    bashProbe = false;
    const cmd = bashCommand();
    if (cmd) {
      try {
        const r = spawnSync(cmd, ["-c", "echo $BASH_VERSION"], {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        const major = r.status === 0 ? parseBashMajor(r.stdout ?? "") : undefined;
        bashProbe = major !== undefined && major >= MIN_BASH_MAJOR;
      } catch {
        bashProbe = false;
      }
    }
  }
  return bashProbe;
}
