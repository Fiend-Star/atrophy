import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exerciseSchema, isShellWrite, type ShellWriteExercise } from "../bank/schema.js";
import { bashCommand, hasBash, SHELL_ENV } from "./bashtool.js";
import {
  grade,
  gradeShell,
  missingPinnedTools,
  type ShellCaseReport,
  shellCaseFailure,
  shellOutputTruncated,
  solutionFileName,
} from "./grader.js";
import { run } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Parse a fixture and narrow it - never assert - so the shell shape is proved, not claimed. */
function shellExercise(raw: unknown): ShellWriteExercise {
  const parsed = exerciseSchema.parse(raw);
  if (!isShellWrite(parsed)) throw new Error(`fixture is not a shell write: ${parsed.id}`);
  return parsed;
}

const base = {
  axis: "syntax-recall",
  tier: 1,
  softTimeLimitSeconds: 60,
  kind: "write",
  language: "shell",
  starterCode: "# your pipeline here\n",
};

/** Distinct counts on purpose: `sort -rn` is not stable, so a tie would not be an answer. */
const IN_1 = "banana\napple\nbanana\ncherry\napple\nbanana\n";
const IN_2 = "kiwi\nfig\nkiwi\nlime\nkiwi\nfig\nkiwi\n";

const topThree = shellExercise({
  ...base,
  id: "sr-sh-901",
  title: "three most frequent lines",
  prompt: "print the three most frequent lines of in.txt as '<line> <count>', most frequent first",
  shellCases: [
    { files: { "in.txt": IN_1 }, expectedStdout: "banana 3\napple 2\ncherry 1" },
    { files: { "in.txt": IN_2 }, expectedStdout: "kiwi 4\nfig 2\nlime 1" },
  ],
});

/** The drill's own reference answer. `uniq -c`'s count padding never reaches stdout. */
const REFERENCE = "sort in.txt | uniq -c | sort -rn | head -3 | awk '{ print $2, $1 }'\n";

/** Write an answer into a fresh scratch dir and hand back the dir `grade` works in. */
function solve(ex: ShellWriteExercise, script: string): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-shell-"));
  dirs.push(d);
  writeFileSync(join(d, solutionFileName(ex)), script, "utf8");
  return d;
}

// ---------------------------------------------------------------------------
// Pure helpers: comparison, failure naming, the P2 classifier. No bash, no spawn,
// so these run on every host - including the ones the suites below skip.
// ---------------------------------------------------------------------------

function report(over: Partial<ShellCaseReport> = {}): ShellCaseReport {
  return {
    caseNumber: 1,
    expectedStdout: "a\nb",
    stdout: "a\nb",
    expectedExitCode: 0,
    exitCode: 0,
    stderr: "",
    truncated: false,
    ...over,
  };
}

describe("shellCaseFailure - comparison", () => {
  it("passes on an exact match", () => {
    expect(shellCaseFailure(report())).toBeUndefined();
  });
  it("passes through normalizeOutput: trailing newline and trailing spaces are not the answer", () => {
    expect(shellCaseFailure(report({ stdout: "a  \nb\n\n" }))).toBeUndefined();
  });
  it("fails a whitespace-only difference: no partial credit on this path", () => {
    // WHITESPACE_PARTIAL_CREDIT is predict-output's rule. In a pipeline drill the
    // column alignment often *is* the answer, so inner spacing is graded strictly.
    const failure = shellCaseFailure(report({ expectedStdout: "a b", stdout: "a  b" }));
    expect(failure).toContain("wrong stdout");
  });
  it("fails on the exit status even when stdout matches", () => {
    const failure = shellCaseFailure(report({ caseNumber: 2, expectedExitCode: 3, exitCode: 0 }));
    expect(failure).toContain("case 2:");
    expect(failure).toContain("exit status");
    expect(failure).toContain("expected 3");
    expect(failure).toContain("got 0");
    // stdout matched, so there is nothing to show as expected-vs-got.
    expect(failure).not.toContain("wrong stdout");
  });
  it("names a signal kill rather than printing a bare null", () => {
    const failure = shellCaseFailure(report({ exitCode: null }));
    expect(failure).toContain("exit status");
    expect(failure).not.toContain("null");
  });
});

describe("shellCaseFailure - naming", () => {
  it("names the case and shows expected vs got, whitespace visible", () => {
    const failure = shellCaseFailure(report({ caseNumber: 2, stdout: "a" }));
    expect(failure).toContain("case 2:");
    expect(failure).toContain("expected:");
    expect(failure).toContain("got:");
    // Quoted, so "a\nb" vs "a" is readable as a shape difference and not as two
    // lines of output the reader has to align by eye.
    expect(failure).toContain('"a\\nb"');
  });
  it("attaches a stderr excerpt when the run said something", () => {
    const failure = shellCaseFailure(report({ stdout: "", stderr: "in.txt: No such file or directory\n" }));
    expect(failure).toContain("stderr:");
    expect(failure).toContain("No such file or directory");
  });
  it("says so when the runner capped the output, so a mismatch is not a mystery", () => {
    const failure = shellCaseFailure(report({ stdout: "a".repeat(400), truncated: true }));
    expect(failure).toMatch(/capped|truncat/i);
  });
  it("keeps a runaway output out of the message", () => {
    const failure = shellCaseFailure(report({ stdout: "x".repeat(50_000), truncated: true }));
    expect(failure!.length).toBeLessThan(2000);
  });
});

describe("missingPinnedTools - the P2 broken-toolchain signature", () => {
  it("names a pinned tool bash could not find", () => {
    expect(missingPinnedTools("bash: grep: command not found")).toEqual(["grep"]);
    expect(missingPinnedTools("solution.sh: line 3: sort: command not found\n")).toEqual(["sort"]);
  });
  it("ignores a tool the contract never promised", () => {
    // The user reached for jq. That is an ordinary failure - the drill's world is
    // PINNED_TOOLS, and reaching outside it is an answer, not a broken install.
    expect(missingPinnedTools("bash: jq: command not found")).toEqual([]);
    expect(missingPinnedTools("bash: python: command not found")).toEqual([]);
  });
  it("sees nothing in the System32-shadow scenario, which is why the PATH pin exists", () => {
    // An unpinned PATH resolves `sort` to C:\WINDOWS\system32\sort.exe: a different
    // program that answers wrongly with exit 0 and clean stderr. Nothing to detect
    // after the fact - SHELL_ENV's pin is the defense, this classifier is not.
    expect(missingPinnedTools("")).toEqual([]);
    const failure = shellCaseFailure(report({ expectedStdout: "a\nb", stdout: "b\na", stderr: "", exitCode: 0 }));
    expect(failure).toContain("wrong stdout");
  });
  it("reports each missing tool once, however many lines complained", () => {
    const stderr = "s.sh: line 1: cut: command not found\ns.sh: line 2: cut: command not found\n";
    expect(missingPinnedTools(stderr)).toEqual(["cut"]);
  });
});

describe("shellOutputTruncated", () => {
  it("is false for ordinary drill output", () => {
    expect(shellOutputTruncated("")).toBe(false);
    expect(shellOutputTruncated("x".repeat(1024))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Everything below really runs bash.
// ---------------------------------------------------------------------------

if (!hasBash()) {
  console.warn("⚠ bash not found - shell grading tests SKIPPED. Install Git for Windows or set ATROPHY_BASH.");
}

describe.skipIf(!hasBash())("shell grading", () => {
  it("the reference pipeline grades 1.00", async () => {
    const r = await grade(topThree, solve(topThree, REFERENCE));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
    expect(r.total).toBe(2);
    expect(r.failures).toEqual([]);
  });

  it("a wrong answer fails the right case by name, with expected vs got", async () => {
    // Ascending instead of descending: both cases come out in the wrong order.
    const wrong = "sort in.txt | uniq -c | sort -n | head -3 | awk '{ print $2, $1 }'\n";
    const r = await grade(topThree, solve(topThree, wrong));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(0);
    expect(r.failures).toHaveLength(2);
    // No args: printFailures renders these as named checks, so the message is all
    // the user sees - it has to name the case and say what differed.
    expect(r.failures[0]?.args).toBeUndefined();
    expect(r.failures[0]?.error).toContain("case 1:");
    expect(r.failures[0]?.error).toContain("banana 3");
    expect(r.failures[0]?.error).toContain("cherry 1");
    expect(r.failures[1]?.error).toContain("case 2:");
  });

  it("echoing case 1's answer scores sub-1.00", async () => {
    const cheese = "printf '%s\\n' 'banana 3' 'apple 2' 'cherry 1'\n";
    const r = await grade(topThree, solve(topThree, cheese));
    expect(r.passed).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.error).toContain("case 2:");
  });

  it("a script that reads nothing fails both cases", async () => {
    const r = await grade(topThree, solve(topThree, "true\n"));
    expect(r.passed).toBe(0);
    expect(r.harnessError).toBeUndefined();
  });
});

describe.skipIf(!hasBash())("shell grading - exit status", () => {
  const exitCodes = shellExercise({
    ...base,
    id: "sr-sh-902",
    title: "exit with the argument",
    prompt: "exit with the status named by $1",
    shellCases: [
      { args: ["3"], expectedStdout: "", expectedExitCode: 3 },
      { args: ["0"], expectedStdout: "" },
    ],
  });

  it("grades the exit status, not just stdout", async () => {
    const r = await grade(exitCodes, solve(exitCodes, 'exit "$1"\n'));
    expect(r.passed).toBe(2);
  });

  it("same stdout, wrong status fails the case that discriminates", async () => {
    const r = await grade(exitCodes, solve(exitCodes, "exit 0\n"));
    expect(r.passed).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.error).toContain("case 1:");
    expect(r.failures[0]?.error).toContain("exit status");
  });

  it("passes args as argv, never through a shell", async () => {
    const args = shellExercise({
      ...base,
      id: "sr-sh-903",
      title: "echo the argument",
      prompt: "print $1",
      shellCases: [
        // If this ever reached a shell it would expand, not print.
        { args: ["$HOME; echo pwned"], expectedStdout: "$HOME; echo pwned" },
        { args: ["plain"], expectedStdout: "plain" },
      ],
    });
    const r = await grade(args, solve(args, 'printf "%s\\n" "$1"\n'));
    expect(r.passed).toBe(2);
  });
});

describe.skipIf(!hasBash())("shell grading - staging", () => {
  const staged = shellExercise({
    ...base,
    id: "sr-sh-904",
    title: "read the nested log",
    prompt: "print logs/app.log, then whether a marker file already exists",
    shellCases: [
      { files: { "logs/app.log": "alpha\n" }, expectedStdout: "alpha\nno-marker" },
      { files: { "logs/app.log": "beta\n" }, expectedStdout: "beta\nno-marker" },
    ],
  });
  // Case 1 leaves a marker behind. A shared directory would make case 2 print
  // "marker" and fail, which is the whole point of a fresh dir per case.
  const script = 'cat logs/app.log\nif [ -e marker ]; then echo marker; else echo no-marker; fi\n: > marker\n';

  it("stages a nested files key and isolates the cases from each other", async () => {
    const r = await grade(staged, solve(staged, script));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
  });

  it("re-grades the same submission identically, one attempt not seeing the last", async () => {
    // The drill loop calls grade() again on the same temp dir after every resubmit, so
    // a case that writes a file has to find its directory empty the second time too.
    const d = solve(staged, script);
    expect((await grade(staged, d)).passed).toBe(2);
    expect((await grade(staged, d)).passed).toBe(2);
  });

  it("the script never sees the drill's own directory", async () => {
    // solution.sh is staged into each case dir, so `ls` there is the case's world.
    const world = shellExercise({
      ...base,
      id: "sr-sh-905",
      title: "list the world",
      prompt: "list the files beside the script",
      shellCases: [
        { files: { "a.txt": "" }, expectedStdout: "a.txt\nsolution.sh" },
        { files: { "b.txt": "" }, expectedStdout: "b.txt\nsolution.sh" },
      ],
    });
    const r = await grade(world, solve(world, "ls | sort\n"));
    expect(r.passed).toBe(2);
  });
});

describe.skipIf(!hasBash())("shell grading - CRLF submissions", () => {
  const counted = shellExercise({
    ...base,
    id: "sr-sh-906",
    title: "top n",
    prompt: "print the most frequent lines",
    shellCases: [
      { files: { "in.txt": IN_1 }, expectedStdout: "banana 3\napple 2\ncherry 1" },
      { files: { "in.txt": IN_2 }, expectedStdout: "kiwi 4\nfig 2\nlime 1" },
    ],
  });
  // CR-fragile by construction: with the carriage returns left in, `count` is "3\r"
  // and `head -3\r` is an invalid number of lines on both toolchains.
  const CR_FRAGILE = "count=3\nsort in.txt | uniq -c | sort -rn | head -$count | awk '{ print $2, $1 }'\n";

  it("grades a CRLF script the same as an LF one", async () => {
    const r = await grade(counted, solve(counted, CR_FRAGILE.replace(/\n/g, "\r\n")));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
  });

  it("...because what bash is handed carries no CR at all", async () => {
    // The behavioural control is not assertable here: Git Bash's bash ignores an
    // end-of-line CR and glibc's bash does not, which is the split the strip exists
    // to close - on msys the CRLF submission would have passed anyway. So the proof
    // is the artifact: the bytes staged into the case dir, on either host.
    const d = solve(counted, CR_FRAGILE.replace(/\n/g, "\r\n"));
    expect(readFileSync(join(d, solutionFileName(counted)), "utf8")).toContain("\r");
    await grade(counted, d);
    expect(readFileSync(join(d, "case-1", solutionFileName(counted)), "utf8")).not.toContain("\r");
  });
});

describe.skipIf(!hasBash())("shell grading - broken toolchain is never a score", () => {
  it("a bash that will not spawn is a harnessError naming the fix", async () => {
    const d = solve(topThree, REFERENCE);
    // An injected env bypasses bashCommand's process-wide cache in both directions.
    const r = await gradeShell(topThree, d, { ...process.env, ATROPHY_BASH: join(d, "no-such-bash") });
    expect(r.harnessError).toBeDefined();
    expect(r.harnessError).toContain("ATROPHY_BASH");
    expect(r.harnessError).toContain("no-such-bash");
    expect(r.passed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("an infinite loop is a timeout, not a stdout mismatch", async () => {
    const looper = shellExercise({
      ...base,
      id: "sr-sh-907",
      title: "loop",
      prompt: "print a and b",
      testTimeoutMs: 1500,
      shellCases: [{ expectedStdout: "a" }, { expectedStdout: "b" }],
    });
    const r = await grade(looper, solve(looper, "while true; do :; done\n"));
    // A killed run prints no verdict of its own, and a timeout is not evidence about
    // the answer: parseMarker's rule, spelled per case.
    expect(r.harnessError).toMatch(/timed out/);
    expect(r.harnessError).toContain("case 1");
    expect(r.passed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("reaching for a tool the contract does not provide is an ordinary failure", async () => {
    const r = await grade(topThree, solve(topThree, "jq . in.txt\n"));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(0);
    expect(r.failures[0]?.error).toContain("case 1:");
  });

  it("a failing case that lost a pinned tool voids the attempt", async () => {
    // A bogus (non-empty) PATH is the needle: an *empty* one makes bash say "No such
    // file or directory" instead. This is P2's shape - the tool is gone, the case
    // cannot pass, and nothing about that is evidence about the user.
    const r = await grade(topThree, solve(topThree, "PATH=/nonexistent sort in.txt\n"));
    expect(r.harnessError).toBeDefined();
    expect(r.harnessError).toContain("sort");
    expect(r.passed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("...but a case that passed is never voided by noise on its stderr", async () => {
    // The answer is right; the script merely made a mess on the way. Voiding here would
    // record nothing at all on the --solution path - a correct answer thrown away.
    const noisy = `PATH=/nonexistent sort /dev/null\n${REFERENCE}`;
    const r = await grade(topThree, solve(topThree, noisy));
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
  });
});

describe.skipIf(!hasBash())("shell grading - HOME", () => {
  const homeDrill = shellExercise({
    ...base,
    id: "sr-sh-909",
    title: "write home",
    prompt: "write $1 to a file under ~ and read it back",
    shellCases: [
      { args: ["alpha"], expectedStdout: "alpha" },
      { args: ["beta"], expectedStdout: "beta" },
    ],
  });

  it("~ is the case's own directory, not the user's home", async () => {
    const d = solve(homeDrill, 'printf "%s\\n" "$1" > ~/out.txt\ncat ~/out.txt\n');
    const r = await grade(homeDrill, d);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
    // Where the write landed is the point: unpinned, `~` is the user's real home on
    // Windows and empty under glibc - the same script writing outside the scratch dir
    // on one host and failing on the other.
    expect(readFileSync(join(d, "case-1", "out.txt"), "utf8").trim()).toBe("alpha");
    expect(readFileSync(join(d, "case-2", "out.txt"), "utf8").trim()).toBe("beta");
  });
});

describe.skipIf(!hasBash())("shell grading - the pinned environment", () => {
  const pinned = shellExercise({
    ...base,
    id: "sr-sh-908",
    title: "pins",
    prompt: "print the locale and the timezone the graded run uses",
    shellCases: [
      { args: ["locale"], expectedStdout: "C" },
      { args: ["tz"], expectedStdout: "UTC" },
    ],
  });

  it("every graded run gets SHELL_ENV, with no benign-degradation mode", async () => {
    const script = 'if [ "$1" = locale ]; then printf "%s\\n" "$LC_ALL"; else printf "%s\\n" "$TZ"; fi\n';
    const r = await grade(pinned, solve(pinned, script));
    expect(r.passed).toBe(2);
  });

  it("the pinned tools all resolve under that PATH", async () => {
    // P2's real failure mode was 33 of 36 tools missing while the script still
    // exited 0. If the pin ever slips, this names exactly which tools went.
    const bash = bashCommand()!;
    const d = mkdtempSync(join(tmpdir(), "atrophy-shell-path-"));
    dirs.push(d);
    const probe = await run(bash, ["-c", "for t in ls cat grep sed awk sort uniq head tail wc find xargs printf seq tr cut; do command -v $t >/dev/null || echo $t; done"], {
      cwd: d,
      timeoutMs: 30_000,
      env: SHELL_ENV(bash),
    });
    expect(probe.stdout.trim()).toBe("");
  });
});

describe.skipIf(!hasBash())("shellOutputTruncated - mirrored from the runner", () => {
  // The runner's cap is a private constant, so these two restate it independently of the
  // mirror under test - deriving the sizes from the exported helper's own number would
  // make the pair drift along with any change instead of catching it.
  /** Print `2^n - drop` characters from bash builtins alone, and hand back what survived. */
  async function capture(n: number, drop: 0 | 1): Promise<string> {
    const bash = bashCommand()!;
    const d = mkdtempSync(join(tmpdir(), "atrophy-shell-cap-"));
    dirs.push(d);
    const script = `s=x; for i in {1..${n}}; do s="$s$s"; done; printf "%s" "${drop ? "${s:1}" : "$s"}"`;
    const r = await run(bash, ["-c", script], { cwd: d, timeoutMs: 60_000, env: SHELL_ENV(bash) });
    return r.stdout;
  }

  it("flags an output the runner really did cut off", async () => {
    // 2^19 characters, comfortably past the 256 KB cap.
    const stdout = await capture(19, 0);
    expect(stdout.length).toBeLessThan(1 << 19);
    expect(shellOutputTruncated(stdout)).toBe(true);
  });

  it("...and does not flag one that just fits", async () => {
    // 2^18 - 1 = one character under the cap: a complete output, so a mirror set *below*
    // the runner's real cap fails here. Without this the pair only catches drift upward.
    const stdout = await capture(18, 1);
    expect(stdout.length).toBe(256 * 1024 - 1);
    expect(shellOutputTruncated(stdout)).toBe(false);
  });
});
