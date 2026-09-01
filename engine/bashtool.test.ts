import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_BASH_MAJOR,
  PINNED_TOOLS,
  SHELL_ENV,
  bashCommand,
  bashCommandDetailed,
  hasBash,
  missingBashHint,
  parseBashMajor,
  resolveBash,
  versionLine,
} from "./bashtool.js";
import { run } from "./runner.js";

/** Discovery must never touch the host in unit tests: every dep is injected. */
const noneExist = () => false;
const noGit = () => undefined;

const WIN_DEFAULT = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const WIN_X86 = "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe";
const GIT_EXEC_PATH = "C:/Program Files/Git/mingw64/libexec/git-core";
/** What rule 2 must derive from GIT_EXEC_PATH: up three, then usr/bin/bash.exe (P16). */
const DERIVED = join(dirname(dirname(dirname(GIT_EXEC_PATH))), "usr", "bin", "bash.exe");

describe("parseBashMajor", () => {
  it("reads the major from what $BASH_VERSION actually prints", () => {
    expect(parseBashMajor("5.2.37(1)-release")).toBe(5);
    expect(parseBashMajor("4.0.0")).toBe(4);
    expect(parseBashMajor("3.2.57(1)-release")).toBe(3);
    expect(parseBashMajor("5.2.37(1)-release\n")).toBe(5);
  });
  it("returns undefined when there is no version to read", () => {
    expect(parseBashMajor("")).toBeUndefined();
    expect(parseBashMajor("gibberish")).toBeUndefined();
    // A shell that is not bash prints an empty $BASH_VERSION - the probe must not
    // invent a number from the surrounding noise.
    expect(parseBashMajor("\n")).toBeUndefined();
  });
  it("rejects a runnable non-bash whose banner merely contains a number", () => {
    // cmd.exe does not understand -c, prints this, and exits 0 because stdin is at EOF.
    // Accepting the 10 out of "[Version 10.0...]" would open the gate to cmd.exe grading
    // shell drills, and no `command not found` would ever flag it.
    expect(parseBashMajor(
      "Microsoft Windows [Version 10.0.26200.9168]\r\n(c) Microsoft Corporation.\r\n\r\nC:\\x>",
    )).toBeUndefined();
    // powershell.exe answers with nothing at all.
    expect(parseBashMajor("")).toBeUndefined();
    // The version must lead, so no prose form is accepted - including bash's own
    // `--version` sentence, which no call site passes.
    expect(parseBashMajor("GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)")).toBeUndefined();
  });
  it("wants a major.minor shape, not a bare number", () => {
    expect(parseBashMajor("release (1)")).toBeUndefined();
    expect(parseBashMajor("bash-5.2")).toBeUndefined();
    expect(parseBashMajor("10 things happened")).toBeUndefined();
  });
  it("reads the first non-empty line, so gating and doctor can never disagree", () => {
    // Both `hasBash` and `bashCheckResult` parse the raw probe stdout through here, so
    // the line choice has to live in one place: a leading blank line must not make one
    // of them see a version the other does not.
    expect(parseBashMajor("\n5.2.37(1)-release\n")).toBe(5);
    expect(parseBashMajor("5.2.37(1)-release\ntrailing junk")).toBe(5);
  });
  it("survives a leading date rather than parsing it as a version", () => {
    expect(parseBashMajor("2026-08-20")).toBeUndefined();
    expect(parseBashMajor("2026.08.20")).toBeUndefined();
  });
});

describe("versionLine", () => {
  it("is the single line both the gate and the report use", () => {
    expect(versionLine("5.2.37(1)-release\n")).toBe("5.2.37(1)-release");
    expect(versionLine("\n\n  5.2.37(1)-release  \nnoise")).toBe("5.2.37(1)-release");
    expect(versionLine("")).toBe("");
    // \r survives the split and must not reach the report.
    expect(versionLine("5.2.37(1)-release\r\nmore")).toBe("5.2.37(1)-release");
  });
});

describe("discovery order (win32)", () => {
  it("takes ATROPHY_BASH verbatim, ahead of git and the well-known installs", () => {
    const found = resolveBash({
      platform: "win32",
      env: { ATROPHY_BASH: "D:\\msys64\\usr\\bin\\bash.exe" },
      exists: () => true,
      gitExecPath: () => GIT_EXEC_PATH,
    });
    expect(found).toEqual({ command: "D:\\msys64\\usr\\bin\\bash.exe", rule: "$ATROPHY_BASH" });
  });

  it("honours ATROPHY_BASH even when the file is not there (the user's call, reported by doctor)", () => {
    expect(resolveBash({ platform: "win32", env: { ATROPHY_BASH: "nope" }, exists: noneExist, gitExecPath: noGit }))
      .toEqual({ command: "nope", rule: "$ATROPHY_BASH" });
  });

  it("derives Git Bash from `git --exec-path` (P16): up three, then usr/bin/bash.exe", () => {
    const found = resolveBash({
      platform: "win32",
      env: {},
      exists: (p) => p === DERIVED,
      gitExecPath: () => GIT_EXEC_PATH,
    });
    expect(found).toEqual({ command: DERIVED, rule: "git --exec-path" });
    expect(found?.command).not.toContain("mingw64");
    expect(found?.command).toContain(join("usr", "bin"));
  });

  it("trims the exec-path output before deriving", () => {
    const found = resolveBash({
      platform: "win32",
      env: {},
      exists: (p) => p === DERIVED,
      gitExecPath: () => `${GIT_EXEC_PATH}\n`,
    });
    expect(found?.command).toBe(DERIVED);
  });

  it("falls back to the well-known installs when git answers nothing", () => {
    expect(resolveBash({ platform: "win32", env: {}, exists: (p) => p === WIN_DEFAULT, gitExecPath: noGit }))
      .toEqual({ command: WIN_DEFAULT, rule: "well-known install" });
    expect(resolveBash({ platform: "win32", env: {}, exists: (p) => p === WIN_X86, gitExecPath: noGit }))
      .toEqual({ command: WIN_X86, rule: "well-known install" });
  });

  it("falls back to the well-known installs when git's derived path is not there", () => {
    const found = resolveBash({
      platform: "win32",
      env: {},
      exists: (p) => p === WIN_DEFAULT,
      gitExecPath: () => "C:/nowhere/mingw64/libexec/git-core",
    });
    expect(found).toEqual({ command: WIN_DEFAULT, rule: "well-known install" });
  });

  it("prefers the 64-bit install over the x86 one", () => {
    expect(resolveBash({ platform: "win32", env: {}, exists: () => true, gitExecPath: noGit })?.command)
      .toBe(WIN_DEFAULT);
  });

  it("never falls back to bare `bash` on win32 (P1: that is the WSL launcher)", () => {
    expect(resolveBash({ platform: "win32", env: {}, exists: noneExist, gitExecPath: noGit })).toBeUndefined();
  });
});

describe("discovery order (posix)", () => {
  it("takes ATROPHY_BASH first", () => {
    expect(resolveBash({ platform: "linux", env: { ATROPHY_BASH: "/opt/bash" }, exists: noneExist }))
      .toEqual({ command: "/opt/bash", rule: "$ATROPHY_BASH" });
  });
  it("then /bin/bash", () => {
    expect(resolveBash({ platform: "linux", env: {}, exists: (p) => p === "/bin/bash" }))
      .toEqual({ command: "/bin/bash", rule: "standard location" });
  });
  it("then bare bash from PATH - which is safe off win32", () => {
    expect(resolveBash({ platform: "darwin", env: {}, exists: noneExist }))
      .toEqual({ command: "bash", rule: "PATH" });
  });
  it("never consults git off win32", () => {
    let asked = false;
    resolveBash({
      platform: "linux",
      env: {},
      exists: noneExist,
      gitExecPath: () => {
        asked = true;
        return GIT_EXEC_PATH;
      },
    });
    expect(asked).toBe(false);
  });
});

describe("SHELL_ENV", () => {
  const bash = join("C:", "Program Files", "Git", "usr", "bin", "bash.exe");

  it("pins locale, timezone, and msys path conversion", () => {
    const env = SHELL_ENV(bash, { PATH: "/usr/bin" });
    expect(env.LC_ALL).toBe("C");
    expect(env.LANG).toBe("C");
    expect(env.TZ).toBe("UTC");
    expect(env.MSYS_NO_PATHCONV).toBe("1");
    expect(env.MSYS2_ARG_CONV_EXCL).toBe("*");
  });

  it("pins PATH with the bash dir FIRST, then the inherited tail (P2/P3)", () => {
    const env = SHELL_ENV(bash, { PATH: `/usr/bin${delimiter}/bin` });
    expect(env.PATH).toBe(`${dirname(bash)}${delimiter}/usr/bin${delimiter}/bin`);
  });

  it("reads the inherited PATH however the host spelled it", () => {
    // A spread copy of process.env on Windows keeps the literal key "Path".
    expect(SHELL_ENV("/bin/bash", { Path: "/usr/bin" }).PATH).toBe(`/bin${delimiter}/usr/bin`);
  });

  it("leaves no dangling delimiter when there is no PATH to inherit", () => {
    expect(SHELL_ENV("/bin/bash", {}).PATH).toBe("/bin");
  });

  it("sets exactly the six pins and nothing else", () => {
    expect(Object.keys(SHELL_ENV("/bin/bash", {})).sort()).toEqual([
      "LANG",
      "LC_ALL",
      "MSYS2_ARG_CONV_EXCL",
      "MSYS_NO_PATHCONV",
      "PATH",
      "TZ",
    ]);
  });
});

describe("PINNED_TOOLS", () => {
  it("is exactly the contract set (spec 4.2)", () => {
    expect([...PINNED_TOOLS]).toEqual([
      "ls", "cat", "grep", "sed", "awk", "cut", "sort", "uniq", "tr", "head", "tail", "wc",
      "find", "xargs", "tee", "printf", "seq", "basename", "dirname", "date", "sleep", "env",
      "comm", "join", "paste", "nl", "fold", "od", "mktemp", "readlink", "stat", "du", "diff",
      "tac", "split", "expr",
    ]);
  });
  it("is frozen and duplicate-free", () => {
    expect(Object.isFrozen(PINNED_TOOLS)).toBe(true);
    expect(new Set(PINNED_TOOLS).size).toBe(PINNED_TOOLS.length);
  });
  it("excludes the tools Git Bash does not ship (P14)", () => {
    for (const absent of ["jq", "python", "curl", "rev"]) expect(PINNED_TOOLS).not.toContain(absent);
  });
});

describe("constants and hints", () => {
  it("pins the minimum bash major", () => {
    expect(MIN_BASH_MAJOR).toBe(4);
  });
  it("names the resolved binary and the override env var", () => {
    const hint = missingBashHint(WIN_DEFAULT);
    expect(hint).toContain(WIN_DEFAULT);
    expect(hint).toMatch(/bash >= 4/);
    expect(hint).toMatch(/ATROPHY_BASH/);
  });
  it("still hints when discovery found nothing to name", () => {
    const hint = missingBashHint();
    expect(hint).toMatch(/bash/);
    expect(hint).toMatch(/ATROPHY_BASH/);
  });
});

describe("bashCommand", () => {
  it("probes once and caches the answer", () => {
    const first = bashCommand();
    expect(bashCommand()).toBe(first);
    expect(bashCommandDetailed()?.command).toBe(first);
  });
  it("does not answer from the cache for an injected env, in either direction", () => {
    // Captured before any injection: comparing two post-injection reads would compare
    // the poisoned cache with itself and pass either way.
    const before = bashCommand();
    expect(bashCommand({ ATROPHY_BASH: "/injected/a" })).toBe("/injected/a");
    // A second injected env proves the injected answer is not cached either.
    expect(bashCommand({ ATROPHY_BASH: "/injected/b" })).toBe("/injected/b");
    expect(bashCommand()).toBe(before);
  });
  it("probes for bash once and caches that too", () => {
    const first = hasBash();
    expect(typeof first).toBe("boolean");
    expect(hasBash()).toBe(first);
  });
});

if (!hasBash()) console.warn("⚠ bash not found - shell toolchain probe tests SKIPPED. Install Git for Windows or set ATROPHY_BASH.");
describe.skipIf(!hasBash())("the real host's bash", () => {
  it("resolves to a runnable binary", () => {
    const found = bashCommandDetailed();
    expect(found).toBeDefined();
    // A bare `bash` from PATH is the only non-path answer, and only off win32.
    if (isAbsolute(found!.command)) expect(existsSync(found!.command)).toBe(true);
    else expect(process.platform).not.toBe("win32");
  });

  it("reports a version at or above the floor", () => {
    const r = spawnSync(bashCommand()!, ["-c", "echo $BASH_VERSION"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(r.status).toBe(0);
    const major = parseBashMajor(r.stdout ?? "");
    expect(major).toBeDefined();
    expect(major!).toBeGreaterThanOrEqual(MIN_BASH_MAJOR);
  });

  it("resolves every PINNED_TOOL through SHELL_ENV (P3 - unpinned, P2 is a silent exit 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-bashenv-"));
    try {
      const bash = bashCommand()!;
      const probe = PINNED_TOOLS.map((t) => `command -v ${t} >/dev/null || echo ${t}`).join("; ");
      const r = await run(bash, ["-c", probe], { cwd: dir, timeoutMs: 20_000, env: SHELL_ENV(bash) });
      // Naming the absentees beats a bare count: a Git Bash missing one tool is an
      // install to fix, and every shell drill may assume the whole set.
      expect(r.stdout.trim()).toBe("");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("actually runs one of them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-bashenv-"));
    try {
      const bash = bashCommand()!;
      const r = await run(bash, ["-c", "grep --version"], { cwd: dir, timeoutMs: 15_000, env: SHELL_ENV(bash) });
      expect(r.stderr).not.toMatch(/command not found/);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toLowerCase()).toContain("grep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
