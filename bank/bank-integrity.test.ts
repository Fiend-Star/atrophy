import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PINNED_TOOLS, hasBash } from "../engine/bashtool.js";
import {
  grade,
  gradePrediction,
  normalizeOutput,
  normalizeRecallAnswer,
  solutionFileName,
  type GradeResult,
} from "../engine/grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk, javacCommand } from "../engine/javatool.js";
import { run } from "../engine/runner.js";
import {
  JVM_KINDS,
  canonicalRows,
  countBlanks,
  isHarness,
  isShellWrite,
  isSqlWrite,
  loadBank,
  spawnsJvm,
  type ClozeExercise,
  type CodeLikeExercise,
  type PredictExercise,
  type ShellCase,
  type ShellWriteExercise,
  type SqlWriteExercise,
} from "./schema.js";

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

  it("cloze blanks actually appear in their snippets, and per-blank sets match them", () => {
    for (const ex of bank.filter((e): e is ClozeExercise => e.kind === "cloze")) {
      const blanks = countBlanks(ex.snippet);
      expect(blanks, `${ex.id}: snippet has no ____ blank`).toBeGreaterThan(0);
      // Only the nested shape has a count to check. The flat shape deliberately has none:
      // one set fills however many blanks there are, which is what several shipped
      // exercises rely on (two blanks, one shared set of answers).
      if (Array.isArray(ex.acceptedAnswers[0])) {
        expect(
          ex.acceptedAnswers.length,
          `${ex.id}: per-blank acceptedAnswers needs one set per ____ blank (blanks: ${blanks})`,
        ).toBe(blanks);
      }
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

/** Grade one hand-written query exactly the way a submission is graded (subprocess and all). */
async function gradeSqlSource(ex: SqlWriteExercise, sql: string) {
  const dir = scratch();
  writeFileSync(join(dir, solutionFileName(ex)), sql, "utf8");
  return grade(ex, dir);
}

/** A SQLite literal for one expected value - the building block of the hardcode cheese. */
function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Integers past this are already a different number by the time JSON.parse is done. */
const MAX_EXACT_INTEGER = 2 ** 53;

/**
 * Everything a fixture built: its schema, plus every user table's contents canonicalized
 * the way a result set is. Two fixtures that produce the same snapshot produce the same
 * database, whatever order the rows went in.
 */
function fixtureSnapshot(fixture: string): string {
  const db = new Database(":memory:");
  try {
    db.exec(fixture);
    const schema = db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all() as { type: string; name: string; sql: string | null }[];
    const data = schema
      .filter((o) => o.type === "table" && !o.name.startsWith("sqlite_"))
      .map((t) => [
        t.name,
        canonicalRows(db.prepare(`SELECT * FROM ${quoteIdent(t.name)}`).all() as Record<string, unknown>[]),
      ]);
    return JSON.stringify([schema, data]);
  } finally {
    db.close();
  }
}

/**
 * sql needs no toolchain gate the way java does - better-sqlite3 is a dependency of the
 * CLI itself, so any machine that can run atrophy can validate sql content, and every
 * pack validated through ATROPHY_BANK is held to these gates as well. What keeps them
 * from passing on an empty loop is the presence arm below (spec §3.5).
 */
describe("bank integrity - sql", () => {
  const sqlWrites = bank.filter(isSqlWrite);

  it("the built-in bank ships sql write content", () => {
    // spec §3.5's third vacuity arm, beside the two java ones above. Every gate in this
    // describe iterates sqlWrites, so a bank that lost its sql would turn all of them
    // green by iterating nothing. A pack pointed at by ATROPHY_BANK may legitimately ship
    // no sql at all, so only the built-in bank is held to this.
    if (!validatingBuiltInBank) return;
    expect(sqlWrites.length, "built-in bank ships no sql write content").toBeGreaterThan(0);
  });

  it("every fixture applies cleanly and builds the same database twice", () => {
    for (const ex of sqlWrites) {
      for (const [i, c] of ex.cases.entries()) {
        const where = `${ex.id} case ${i + 1}`;
        // A fixture that will not apply voids the whole attempt at grade time (gradeSql
        // reports an exercise bug rather than a score), so the user gets nothing at all.
        const build = () => {
          try {
            return fixtureSnapshot(c.fixture);
          } catch (err) {
            throw new Error(`${where}: fixture does not apply cleanly: ${(err as Error).message}`);
          }
        };
        // Twice, into two fresh databases: a fixture that seeds with random() or now()
        // expects rows that are only right on some runs.
        expect(build(), `${where}: fixture builds a different database on a second run`).toBe(build());
      }
    }
  });

  it("at least two cases expect different rows", () => {
    // The schema refuses this at parse time; re-asserted here because it is the premise
    // every other sql gate leans on - one indistinguishable pair and the drill is
    // answerable by a literal.
    for (const ex of sqlWrites) {
      const canon = new Set(ex.cases.map((c) => canonicalRows(c.expectedRows)));
      expect(canon.size, `${ex.id}: every case expects the same rows`).toBeGreaterThan(1);
    }
  });

  it("every expected value is a value SQLite can return, and integers stay exact", () => {
    for (const ex of sqlWrites) {
      for (const [i, c] of ex.cases.entries()) {
        for (const row of c.expectedRows) {
          for (const [column, value] of Object.entries(row)) {
            const where = `${ex.id} case ${i + 1}, column ${column}`;
            // canonicalRows sorts top-level keys only, so a nested object's own key order
            // would decide equality - and no SQLite column returns an object or an array
            // anyway, so such a value is unmatchable by any query.
            // A JSON boolean is rejected for the same reason: better-sqlite3 hands back
            // SQLite's 1/0 integers and never a JS boolean, so `true` in an expectedRow is
            // an answer no query can give. On an unordered drill the cheese gate below
            // catches it (the source case stops reproducing itself), but that arm is
            // skipped when `ordered` is set - so for an ordered drill this is the only
            // gate standing between a boolean and an unwinnable exercise.
            const scalar = value === null || typeof value === "string" || typeof value === "number";
            expect(
              scalar,
              `${where}: expected values must be a string, a number or null - SQLite returns nothing else, got ${JSON.stringify(value)}`,
            ).toBe(true);
            if (typeof value !== "number") continue;
            expect(Number.isFinite(value), `${where}: ${String(value)} is not a finite number`).toBe(true);
            // Same rule as java's `tests`: the exercise JSON goes through Node's JSON.parse
            // long before grading, so a bigger integer is already a different number here.
            if (Number.isInteger(value)) {
              expect(
                Math.abs(value),
                `${where}: integer ${value} is past 2^53 and cannot round-trip`,
              ).toBeLessThanOrEqual(MAX_EXACT_INTEGER);
            }
          }
        }
      }
    }
  });

  it("the hardcoded-literal cheese cannot pass every case", async () => {
    for (const ex of sqlWrites) {
      // spec §2.4(c): the cheese is rebuilt from the FIRST case that expects any rows.
      // A bank where no case does is already impossible - the gate above rejects it.
      const sourceIndex = ex.cases.findIndex((c) => c.expectedRows.length > 0);
      const source = ex.cases[sourceIndex];
      expect(source, `${ex.id}: every case expects zero rows - nothing to hardcode from`).toBeDefined();
      if (!source) continue;
      const columns = Object.keys(source.expectedRows[0] ?? {});
      expect(columns.length, `${ex.id}: case ${sourceIndex + 1} expects rows with no columns`).toBeGreaterThan(0);
      const cheese = source.expectedRows
        .map((row) => `SELECT ${columns.map((c) => `${sqlLiteral(row[c])} AS ${quoteIdent(c)}`).join(", ")}`)
        .join(" UNION ALL ");

      const r = await gradeSqlSource(ex, cheese);
      // Without these two, the gate below passes on a cheese that never ran: a broken
      // fixture (harnessError) or a cheese SQLite refuses to parse both score 0.
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      for (const f of r.failures) {
        // A case expecting 501+ rows builds a cheese past SQLITE_MAX_COMPOUND_SELECT (500
        // UNION ALL terms), which SQLite will not parse - this arm then reds carrying the
        // parse error as its message. That red is the design working, not a gate bug: an
        // uncheesable exercise is one this net cannot cover, so it wants smaller cases.
        expect(f.error, `${ex.id}: the cheese did not run as a query: ${f.error}`).toContain("wrong rows");
      }
      if (!ex.ordered) {
        // The cheese is this case's own rows, written out as literals, so it must
        // reproduce it. When it does not, an expected value is one no query can return
        // either (a JSON `true` comes back from SQLite as 1) - unmatchable, not cheese-proof.
        // Skipped for ordered drills only because UNION ALL's row order is unspecified.
        expect(
          r.failures.map((f) => f.index),
          `${ex.id}: case ${sourceIndex + 1}'s own rows as literals do not reproduce it`,
        ).not.toContain(sourceIndex);
      }
      // The letter of §2.4(c). The distinct-cases rule above already implies it - fixed
      // rows can match at most one of two distinct expectations - so this stays as the
      // statement of intent, and the two checks above are what actually catch a bad bank.
      expect(r.passed, `${ex.id}: a hardcoded literal passes every case`).toBeLessThan(ex.cases.length);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

/**
 * The reference-solution convention, and the one every shell drill follows: a shell
 * write ships its answer as a sibling file named `<id>.reference.sh`, beside the
 * exercise JSON. The gates below find it by that name anywhere under the bank root,
 * so a pack that prefers a `references/` subdirectory also works; adjacency is the
 * convention, not the rule.
 *
 * Why a sidecar rather than a field in the exercise JSON - sql, the structural twin,
 * settles nothing here, because a sql write ships no reference at all (its gates
 * synthesize the cheese and never grade an answer):
 *
 * - No exercise has ever shipped a *correct* solution inside its own document: a `fix`
 *   ships the buggy code, a `write` ships the starter. A separate file is also the only
 *   shape that can later be kept out of the published package - `package.json` "files"
 *   ships `bank/exercises` wholesale, and a glob can exclude a file where it could never
 *   exclude a JSON key.
 * - A bash reference is the hardest artifact in a shell drill to escape into JSON: one
 *   sed or awk program with backslashes and the field is unreviewable. A `.sh` file is
 *   byte-exact, runs under `bash <file>` by hand, and mounts straight into the
 *   dual-toolchain container gate the content spec requires of every shell wave.
 * - `loadBank` walks for `*.json` only, so nothing in the program can pick a reference
 *   up by accident. It exists for these gates and for the wave gates.
 */
const REFERENCE_SUFFIX = ".reference.sh";

interface ShellReference {
  /** Printed in every failure: the author has to open this file. */
  path: string;
  script: string;
}

const shellReferences = new Map<string, ShellReference>();
/** Two files claiming one id - asserted below rather than thrown, so the whole file still loads. */
const duplicateReferences: string[] = [];

(function collectReferences(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectReferences(full);
    else if (entry.isFile() && entry.name.endsWith(REFERENCE_SUFFIX)) {
      const id = entry.name.slice(0, -REFERENCE_SUFFIX.length);
      const previous = shellReferences.get(id);
      if (previous) duplicateReferences.push(`${id}: ${previous.path} and ${full}`);
      // gradeShell strips CR from the submitted script anyway; normalizing here keeps the
      // line-anchored lint below from depending on how git checked the file out.
      else shellReferences.set(id, { path: full, script: readFileSync(full, "utf8").replace(/\r\n/g, "\n") });
    }
  }
})(bankRoot);

const shellWrites = bank.filter(isShellWrite);
const shellPath = (p: string) => relative(bankRoot, p) || p;

/**
 * Per case, the full `testTimeoutMs` is the budget for one bash run, so the floor is a
 * per-case floor. Half the schema's 10 s default: measured on Git Bash (msys, the slower
 * of the two toolchains CI runs), an eight-stage pipeline over a 500-line fixture takes
 * ~80 ms warm and ~180 ms cold, so 5 s is ~30x the worst measured run and still leaves an
 * author room to tighten a drill deliberately. The java floors exist for the opposite
 * reason - javac plus JVM startup are most of their clock - which is why this number is
 * so much smaller and is stated as a measurement rather than borrowed from them.
 */
const SHELL_TIMEOUT_FLOOR_MS = 5000;

/**
 * Bash keywords and builtins. Together with `PINNED_TOOLS` this is the vocabulary a
 * shipped script may use; anything else is either absent from Git Bash's `usr/bin` or
 * never inventoried there, and the drill would fail on a host we claim to support.
 */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ":", ".", "[", "[[", "]]", "{", "}", "!", "alias", "bg", "bind", "break", "builtin",
  "caller", "case", "cd", "command", "compgen", "complete", "compopt", "continue",
  "coproc", "declare", "dirs", "disown", "do", "done", "echo", "elif", "else", "enable",
  "esac", "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for", "function",
  "getopts", "hash", "help", "history", "if", "in", "jobs", "kill", "let", "local",
  "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "select", "set", "shift", "shopt", "source", "suspend", "test", "then",
  "time", "times", "trap", "true", "type", "typeset", "ulimit", "umask", "unalias",
  "unset", "until", "wait", "while",
]);

/** Blank a span but keep its newlines, so every line number below stays the file's own. */
const blankSpan = (chunk: string) => chunk.replace(/[^\n]/g, " ");

/** `$(( … ))` out: a bitwise `&` in arithmetic is not a backgrounding `&`. */
const stripArithmetic = (s: string) => s.replace(/\$\(\([^)]*\)\)/g, blankSpan);

/**
 * Heredoc bodies out: they are data, and a `curl` inside one is a string, not a call.
 * The delimiter is taken from the `<<` line and the body blanked up to it.
 */
function stripHeredocs(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    out.push(line);
    const opener = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
    const delimiter = opener?.[1] ?? opener?.[2] ?? opener?.[3];
    if (!delimiter) continue;
    while (i + 1 < lines.length) {
      i += 1;
      // The closing delimiter is blanked with the body: on its own line it is a word in
      // command position, and left standing it reads as a call to a command named EOF.
      const done = lines[i]!.trim() === delimiter;
      out.push("");
      if (done) break;
    }
  }
  return out.join("\n");
}

/**
 * Quoted spans out. What survives is roughly the shell's *syntax*: separators, redirects
 * and command names, with every string literal blanked. This is what makes the command
 * scan below safe on real content - `sed 's/x/&/'` carries no `&` once the quotes are
 * gone, and an awk program is not a pile of unknown commands.
 *
 * One exception, and it is the common case rather than a corner: a `$( … )` inside double
 * quotes is *code*, not text. `"$(wc -l < in.txt)"` runs wc, so blanking it with the rest
 * of the string would hide every command a script writes that way - which is most of them.
 * Single quotes have no such carve-out: nothing inside them runs.
 */
function stripQuoted(s: string): string {
  // "normal" is top level, "subst" is inside a `$( … )` (its `)` returns to the frame
  // below), and the two quote frames differ in exactly the carve-out above.
  const stack: ("normal" | "subst" | "sq" | "dq")[] = ["normal"];
  let out = "";
  let i = 0;
  while (i < s.length) {
    const top = stack[stack.length - 1]!;
    const ch = s[i]!;
    const code = top === "normal" || top === "subst";
    if (top !== "sq" && ch === "\\") {
      out += ` ${s[i + 1] === "\n" ? "\n" : " "}`;
      i += 2;
      continue;
    }
    if ((code || top === "dq") && ch === "$" && s[i + 1] === "(") {
      out += "$(";
      stack.push("subst");
      i += 2;
      continue;
    }
    if (top === "subst" && ch === ")") {
      out += ")";
      stack.pop();
      i += 1;
      continue;
    }
    if (code && (ch === "'" || ch === '"')) {
      stack.push(ch === "'" ? "sq" : "dq");
      out += " ";
      i += 1;
      continue;
    }
    if ((top === "sq" && ch === "'") || (top === "dq" && ch === '"')) {
      stack.pop();
      out += " ";
      i += 1;
      continue;
    }
    out += code ? ch : blankSpan(ch);
    i += 1;
  }
  return out;
}

/** A `#` that begins a word, to end of line. Run after quote-stripping on the syntax pass. */
const stripComments = (s: string) => s.replace(/(^|[ \t])#[^\n]*/gm, "$1");

/**
 * Patterns read off the script with its strings still intact, because that is where they
 * hide: `"$RANDOM"` is still an expansion, and a `%Z` only ever appears inside a quoted
 * `date` format. Comments are stripped first (a `#` inside a string can end a line early,
 * which can hide a needle - a false negative, never a false positive).
 */
const SCRIPT_NEEDLES: readonly { re: RegExp; problem: string }[] = [
  { re: /\bnohup\b/, problem: "runs nohup: a graded run may not outlive the process being timed" },
  { re: /\bdisown\b/, problem: "runs disown: a graded run may not detach work from the process being timed" },
  { re: /\$RANDOM\b/, problem: "reads $RANDOM: a drill's output must be the same on every run" },
  { re: /\$SRANDOM\b/, problem: "reads $SRANDOM: a drill's output must be the same on every run" },
  { re: /\$\$/, problem: "reads $$: a pid differs on every run" },
  { re: /\$BASHPID\b/, problem: "reads $BASHPID: a pid differs on every run" },
  { re: /\$SECONDS\b/, problem: "reads $SECONDS: elapsed time differs on every run" },
  { re: /\$EPOCH(?:SECONDS|REALTIME)\b/, problem: "reads the clock: a drill's output must be the same on every run" },
  {
    re: /%Z/,
    problem: "formats %Z: msys `date` prints GMT where GNU coreutils prints UTC for the same TZ=UTC",
  },
  {
    re: /\$\{?(?:HOME|USER|LOGNAME|UID|EUID|PWD|OLDPWD|HOSTNAME)\b/,
    problem: "reads an identity variable: its value is the host's, and the graded run pins only $HOME",
  },
  {
    re: /(?:^|[\s;|&(])~(?:\/|\s|$)/m,
    problem: "uses ~: the case directory is already the working directory, and ~ prints a host-shaped path",
  },
  { re: /\b(?:export\s+)?PATH\s*=/, problem: "assigns PATH: SHELL_ENV pins it, and a bogus one fakes a broken toolchain" },
  {
    re: /(?:^|[\s"'=(<>|;&])\/(?:etc|tmp|usr|var|proc|sys|home|opt|root|bin|sbin|mnt|media|Users)\//,
    problem: "names an absolute path: a case's files are staged relative to its own directory",
  },
  {
    re: /(?:^|[\s"'=(<>|;&])\/dev\/(?!(?:null|stdin|stdout|stderr|zero|full)\b)/,
    problem: "names a device outside the portable set (/dev/null, /dev/std*, /dev/zero, /dev/full)",
  },
  { re: /\b[A-Za-z]:[\\/]/, problem: "names a drive-letter path: it exists on one CI leg only" },
  { re: /\bgrep\b[^\n]*\s-[A-Za-z]*P\b/, problem: "uses grep -P: it exits 2 under LC_ALL=C on the msys toolchain" },
  { re: /\\K/, problem: "uses \\K, which is PCRE-only: grep -P is unavailable on the msys toolchain" },
];

/** One command-position token, with the rest of its simple command and where it sits. */
interface ShellCommand {
  name: string;
  args: string;
  line: number;
}

/**
 * Command-position tokens, read off the stripped syntax. Deliberately a heuristic, and
 * deliberately biased toward silence: a missed call costs a backstop the reference run
 * would have caught anyway (a tool that is not there is `command not found`, and gate
 * "every reference solution grades 1.00" reds), while a false alarm blocks a correct drill.
 *
 * Known limits, all of them false *negatives*: a command named through a variable
 * (`$tool file`) is unresolvable and skipped; anything inside `$(( ))`, a heredoc body or
 * a *single*-quoted string is blanked, so an `awk 'BEGIN { "date" | getline x }'` hides
 * its payload inside another language's syntax; a backtick substitution reads as a
 * separator rather than as nesting; and `find -exec`/`xargs` are followed one token deep
 * only. The real enforcement is execution.
 */
function extractCommands(stripped: string): ShellCommand[] {
  const functionNames = new Set<string>();
  for (const m of stripped.matchAll(/(?:^|[\s;&|])(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\)/g)) {
    functionNames.add(m[1]!);
  }

  const found: ShellCommand[] = [];
  const lines = stripped.split("\n");
  // `)` closes a substitution or subshell when one is open, and a `case` label when none
  // is - which is how `foo)` is told apart from the `date` in `$(date)`.
  let openParens = 0;
  for (const [index, line] of lines.entries()) {
    const parts = line.split(/(\|\||&&|\$\(|[|;&(){}`)])/);
    for (let p = 0; p < parts.length; p += 2) {
      const segment = parts[p]!;
      const closer = parts[p + 1];
      const isCaseLabel = closer === ")" && openParens === 0;
      if (!isCaseLabel) {
        for (const cmd of simpleCommands(segment)) {
          if (!functionNames.has(cmd.name)) found.push({ ...cmd, line: index + 1 });
        }
      }
      if (closer === "$(" || closer === "(") openParens += 1;
      else if (closer === ")") openParens = Math.max(0, openParens - 1);
    }
  }
  return found;
}

/** Keywords that introduce another command rather than being one: skipped past, not reported. */
const COMMAND_PREFIX = /^(?:!|time|if|then|elif|else|while|until|do|command|builtin|exec|nice)\s+/;
/** `FOO=bar cmd` - a one-command environment tweak, not a command itself. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
/** What a command name can look like. A `>` redirect or a bare flag is neither. */
const COMMAND_NAME = /^[A-Za-z_.:[][A-Za-z0-9_.:[\]-]*$/;

/**
 * The command(s) one separator-free segment invokes: normally one, plus the token after
 * `xargs` or `find -exec`, which is a command name sitting in argument position.
 */
function simpleCommands(segment: string): { name: string; args: string }[] {
  let rest = segment.trim();
  for (;;) {
    const skipped = COMMAND_PREFIX.exec(rest) ?? ASSIGNMENT_PREFIX.exec(rest);
    if (!skipped) break;
    rest = rest.slice(skipped[0].length);
  }
  const head = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (!head) return [];
  const name = head[1]!;
  const args = head[2]!;
  // A name built from an expansion cannot be resolved, and a lone number or flag is not
  // a command at all: silence beats a guess on both.
  if (!COMMAND_NAME.test(name)) return [];

  const commands = [{ name, args }];
  const nested =
    name === "xargs"
      ? /^(?:\s*-\S+(?:\s+\S+)?)*\s*(\S+)/.exec(args)?.[1]
      : /\s-exec(?:dir)?\s+(\S+)/.exec(args)?.[1];
  if (nested && COMMAND_NAME.test(nested)) commands.push({ name: nested, args: "" });
  return commands;
}

/**
 * Everything wrong with one shipped shell script, as messages an author can act on.
 * Empty means the script stays inside the pinned toolchain and the determinism laws.
 */
export function shellScriptProblems(script: string): string[] {
  const text = script.replace(/\r\n/g, "\n");
  const problems: string[] = [];

  // Pass A: strings intact - "$RANDOM" is an expansion and a `date` format lives in quotes.
  const uncommented = stripComments(text);
  for (const needle of SCRIPT_NEEDLES) {
    if (needle.re.test(uncommented)) problems.push(needle.problem);
  }

  // Pass B: syntax only - what is left after arithmetic, heredocs, strings and comments go.
  const stripped = stripComments(stripQuoted(stripHeredocs(stripArithmetic(text))));
  // Every surviving lone `&` is a background operator: `&&`, `&>`, `2>&1` and `|&` are
  // excluded by shape, and a sed replacement's `&` went with the quotes.
  if (/(?<![&>|<])&(?![&>])/.test(stripped)) {
    problems.push("backgrounds a command with &: the runner times the script, not its orphans");
  }

  const commands = extractCommands(stripped);
  const names = new Set(commands.map((c) => c.name));
  for (const c of commands) {
    if (!PINNED_TOOLS.includes(c.name) && !SHELL_BUILTINS.has(c.name)) {
      problems.push(
        `line ${c.line}: invokes \`${c.name}\`, which is neither a bash builtin nor in PINNED_TOOLS - ` +
          "no host is promised to have it (add it to engine/bashtool.ts only if both CI toolchains ship it)",
      );
      continue;
    }
    if (c.name === "date" && !/(?:^|\s)(?:-d|-r|--date)\b/.test(c.args)) {
      problems.push(`line ${c.line}: calls \`date\` with no fixed input, which prints the time of the run`);
    }
    if (c.name === "du") {
      problems.push(`line ${c.line}: ranks by \`du\`, whose block size differs across filesystems - use \`wc -c\``);
    }
    if (c.name === "ls" && /(?:^|\s)-[A-Za-z]*l/.test(c.args)) {
      problems.push(`line ${c.line}: uses \`ls -l\`, whose columns differ across toolchains`);
    }
    if (c.name === "env" && !/[A-Za-z_][A-Za-z0-9_]*=/.test(c.args)) {
      problems.push(`line ${c.line}: enumerates the environment, which is the host's and not the drill's`);
    }
  }
  // Order is the whole answer in these two, and neither tool promises one. Scoped to the
  // script rather than the pipeline: a `sort` anywhere satisfies it, which is the limit.
  if (names.has("find") && !names.has("sort")) {
    problems.push("walks with `find` and never sorts: directory order is not an answer");
  }
  if (/\$\{!\w+\[[@*]\]\}/.test(text) && !names.has("sort")) {
    problems.push("iterates an associative array and never sorts: bash hash order is not an answer");
  }
  return problems;
}

/**
 * Every field of a shell exercise that bash will actually execute. Fixture content is
 * *not* linted unless its key names a script: a staged file is inert data written
 * byte-exact, and a log line legitimately reading "nohup: ignoring input" or naming
 * `/tmp/build.log` is not a determinism hazard. The determinism laws bind behaviour, and
 * behaviour lives in the scripts - the reference, the starter, and any `.sh` a case stages
 * for the drill to run.
 */
function shellScriptFields(ex: ShellWriteExercise, reference?: ShellReference): { label: string; script: string }[] {
  const fields = [{ label: `${ex.id} starterCode`, script: ex.starterCode }];
  if (reference) fields.push({ label: shellPath(reference.path), script: reference.script });
  for (const [i, c] of ex.shellCases.entries()) {
    for (const [key, contents] of Object.entries(c.files ?? {})) {
      if (/\.(?:sh|bash)$/i.test(key)) fields.push({ label: `${ex.id} case ${i + 1} files["${key}"]`, script: contents });
    }
  }
  return fields;
}

/** Keys that cannot coexist as files in one directory, whichever order they are staged in. */
export function stagedKeyConflicts(files: Record<string, string> | undefined): string[] {
  const keys = Object.keys(files ?? {});
  const conflicts: string[] = [];
  for (const [i, a] of keys.entries()) {
    for (const b of keys.slice(i + 1)) {
      // Compared case-insensitively throughout, for the reason the schema's own key rules
      // give: a Windows filesystem resolves "Logs/A.LOG" and "logs/a.log" to one path
      // where Linux keeps two, and that is the same drill staging two different trees.
      const [x, y] = [a.toLowerCase(), b.toLowerCase()];
      // {"a": …, "a/b": …} parses key by key and dies at stage time with EEXIST: `a` has
      // to be a file and a directory at once. Named here rather than left as an errno.
      if (y.startsWith(`${x}/`)) conflicts.push(`"${a}" is a file and the parent directory of "${b}"`);
      else if (x.startsWith(`${y}/`)) conflicts.push(`"${b}" is a file and the parent directory of "${a}"`);
      else if (x === y) conflicts.push(`"${a}" and "${b}" differ only in case`);
    }
  }
  return conflicts;
}

/**
 * The echoed-answer cheese: a script that prints case 1's expected stdout verbatim and
 * exits with its expected status. `printf '%s\n'` rather than `echo`, because echo's
 * treatment of `-n` and backslashes varies by shell - a line of expected output starting
 * with `-e` would silently become a flag.
 */
export function echoCheese(c: ShellCase): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const status = c.expectedExitCode ?? 0;
  const text = normalizeOutput(c.expectedStdout);
  const body = text === "" ? ":\n" : `printf '%s\\n' ${text.split("\n").map(quote).join(" ")}\n`;
  return status === 0 ? body : `${body}exit ${status}\n`;
}

/**
 * Static shell gates: no bash, so a host that cannot run the drills still catches a
 * missing reference, an unusable expectation, a staging conflict or a banned construct.
 */
describe("bank integrity - shell content", () => {
  it("the built-in bank ships no shell exercises yet", () => {
    // The inverse of the java and sql presence arms, and it says the same thing: every
    // gate below iterates `shellWrites`, so their green is only worth what the loop held.
    // Today the built-in bank ships none - executable shell lives in packs, which are
    // validated by pointing ATROPHY_BANK at them - and this states that rather than
    // leaving a reader to guess whether the gates ran. When base ships its first shell
    // drill, flip this to `toBeGreaterThan(0)` in the same commit; the shell paragraph in
    // README and cli/readme-claims.test.ts's `shell` row move with it.
    if (!validatingBuiltInBank) return;
    expect(shellWrites.map((e) => e.id), "the built-in bank now ships shell content - see the comment here").toEqual([]);
  });

  it("no two files claim the same exercise's reference", () => {
    expect(duplicateReferences).toEqual([]);
  });

  it("every shell write ships a reference solution, and every reference has its exercise", () => {
    const missing = shellWrites.filter((ex) => !shellReferences.has(ex.id)).map((ex) => `${ex.id}${REFERENCE_SUFFIX}`);
    expect(missing, "shell writes with no reference solution beside them - the gates cannot grade these").toEqual([]);
    const ids = new Set(shellWrites.map((ex) => ex.id));
    const orphans = [...shellReferences.entries()].filter(([id]) => !ids.has(id)).map(([, r]) => shellPath(r.path));
    // A rename that left the answer key behind: it grades nothing and no gate would notice.
    expect(orphans, "reference files naming no shell write").toEqual([]);
    for (const ex of shellWrites) {
      const ref = shellReferences.get(ex.id);
      if (ref) expect(ref.script.trim(), `${shellPath(ref.path)} is empty`).not.toBe("");
    }
  });

  it(`every shell write allows at least ${SHELL_TIMEOUT_FLOOR_MS} ms per case`, () => {
    const bad = shellWrites.filter((ex) => ex.testTimeoutMs < SHELL_TIMEOUT_FLOOR_MS);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });

  it("every expectedStdout is written exactly the way it is graded", () => {
    // Both sides go through normalizeOutput, so a trailing newline, a trailing space or a
    // leading blank line in the JSON is not part of the answer and cannot be made part of
    // one. Writing it anyway tells an author the drill grades something it does not.
    const bad: string[] = [];
    for (const ex of shellWrites) {
      for (const [i, c] of ex.shellCases.entries()) {
        if (c.expectedStdout !== normalizeOutput(c.expectedStdout)) {
          bad.push(`${ex.id} case ${i + 1}: ${JSON.stringify(c.expectedStdout)}`);
        }
      }
    }
    expect(bad, "expectedStdout carries whitespace the grader trims - write it normalized").toEqual([]);
  });

  it("no case stages a files map that cannot become a directory tree", () => {
    const bad: string[] = [];
    for (const ex of shellWrites) {
      for (const [i, c] of ex.shellCases.entries()) {
        for (const conflict of stagedKeyConflicts(c.files)) bad.push(`${ex.id} case ${i + 1}: ${conflict}`);
      }
    }
    // The schema checks each key on its own, so this pairing is the one staging failure it
    // cannot see. Caught here rather than as an EEXIST in the middle of someone's drill.
    expect(bad).toEqual([]);
  });

  it("every shipped shell script stays inside the pinned toolchain and the determinism laws", () => {
    const bad: string[] = [];
    for (const ex of shellWrites) {
      for (const field of shellScriptFields(ex, shellReferences.get(ex.id))) {
        for (const problem of shellScriptProblems(field.script)) bad.push(`${field.label}: ${problem}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/** Grade one script exactly the way a submission is graded, in a directory of its own. */
async function gradeShellSource(ex: ShellWriteExercise, script: string): Promise<GradeResult> {
  const dir = scratch();
  writeFileSync(join(dir, solutionFileName(ex)), script, "utf8");
  return grade(ex, dir);
}

/**
 * Reference runs, memoized by attempt: the 1.00 gate wants attempt 0 and the determinism
 * gate wants 0 and 1, so the pair costs two runs per exercise rather than four.
 */
const referenceRuns = new Map<string, Promise<GradeResult>>();
function gradeReference(ex: ShellWriteExercise, ref: ShellReference, attempt: number): Promise<GradeResult> {
  const key = `${ex.id}#${attempt}`;
  const pending = referenceRuns.get(key) ?? gradeShellSource(ex, ref.script);
  referenceRuns.set(key, pending);
  return pending;
}

// Like java, shell content is validated only where a toolchain exists - but unlike java,
// there is nothing in the built-in bank for it to validate, so this warning is about the
// pack runs (`ATROPHY_BANK=<pack-dir> npx vitest run bank/bank-integrity.test.ts`) and
// about the CI legs, where it must never appear.
if (!hasBash()) {
  console.warn("⚠ bash not found - shell exercises NOT validated. Install Git for Windows or set ATROPHY_BASH.");
}
describe.skipIf(!hasBash())("bank integrity - shell", () => {
  it("every reference solution grades 1.00", async () => {
    for (const ex of shellWrites) {
      const ref = shellReferences.get(ex.id);
      // Its absence is already one named failure above; failing twice for one cause only
      // makes the report harder to read.
      if (!ref) continue;
      const r = await gradeReference(ex, ref, 0);
      // Staging is graded here rather than in a gate of its own: every case's `files` map
      // is written before its run, so a tree that cannot be built shows up as this
      // harnessError - which is why the message says where to look.
      expect(
        r.harnessError,
        `${ex.id}: the reference never graded (a staging failure here is a files map that ` +
          `cannot become a directory tree, or a broken bash) - ${shellPath(ref.path)}`,
      ).toBeUndefined();
      expect(
        r.failures.map((f) => f.error),
        `${ex.id}: ${shellPath(ref.path)} does not pass its own drill`,
      ).toEqual([]);
      expect(r.passed, `${ex.id}: reference scored ${r.passed}/${r.total}`).toBe(r.total);
    }
  }, 300_000);

  it("...and grades identically on a second run", async () => {
    for (const ex of shellWrites) {
      const ref = shellReferences.get(ex.id);
      if (!ref) continue;
      const [first, second] = [await gradeReference(ex, ref, 0), await gradeReference(ex, ref, 1)];
      // The sql build-twice gate's twin, one level up: sql rebuilds the fixture and compares
      // databases, shell reruns the whole graded attempt and compares verdicts. A fixture
      // seeded from the clock, a script reading one, or a tool whose order is not pinned
      // shows up as two different results for one answer.
      expect(JSON.stringify(second), `${ex.id}: the same reference graded two different ways`).toBe(
        JSON.stringify(first),
      );
    }
  }, 300_000);

  it("the echoed-answer cheese cannot pass every case", async () => {
    for (const ex of shellWrites) {
      const first = ex.shellCases[0]!;
      const r = await gradeShellSource(ex, echoCheese(first));
      // Without this the gate below passes on a cheese that never ran.
      expect(r.harnessError, `${ex.id}: the cheese did not run at all: ${r.harnessError}`).toBeUndefined();
      // The cheese prints case 1's expectation verbatim, so it must reproduce case 1. When
      // it does not, the expectation is one no script could produce - unwinnable, not
      // cheese-proof - and the drill is broken in a way the reference gate might not show.
      expect(
        r.failures.map((f) => f.index),
        `${ex.id}: case 1's own output, printed verbatim, does not satisfy case 1`,
      ).not.toContain(0);
      // The schema's distinct-expectations rule already implies this; it stays as the
      // statement of intent, and the arm above is what catches a bad drill.
      expect(r.passed, `${ex.id}: a script that echoes case 1's answer passes every case`).toBeLessThan(
        ex.shellCases.length,
      );
    }
  }, 300_000);
});

/**
 * The gates above iterate an empty list in the built-in bank, so these are what prove they
 * fire at all: each one builds the shape it is meant to reject, in memory, and checks that
 * the gate's own helper reports it. Nothing here ships - the fixtures never touch disk
 * outside a scratch dir.
 */
describe("shell gates - proof they fire", () => {
  const clean = "sort in.txt | uniq -c | sort -rn | head -3 | awk '{ print $2, $1 }'\n";

  it("passes a script that stays inside the contract", () => {
    expect(shellScriptProblems(clean)).toEqual([]);
    // Shapes that look like the needles and are not: `&&`, `2>&1`, a quoted sed `&`, a
    // heredoc body, a function definition and its call, a case label, a `[` test.
    const busy = [
      "#!/usr/bin/env bash",
      "# nohup and $RANDOM in a comment are not calls",
      "count() { wc -l < \"$1\"; }",
      "if [ -f in.txt ] && grep -q x in.txt 2>&1; then",
      "  sed 's/x/& y/' in.txt | tr -d '\\r' > out.txt",
      "fi",
      "case $1 in",
      "  alpha) printf '%s\\n' \"$(count out.txt)\" ;;",
      "  *) cat <<EOF",
      "curl http://example.com/tmp/x",
      "EOF",
      "  ;;",
      "esac",
      "for f in *.txt; do printf '%s\\n' \"$f\"; done | sort",
      "n=$(( 6 & 3 ))",
      "find . -name '*.log' | sort | xargs cat",
      "date -d @1700000000 +%Y",
    ].join("\n");
    expect(shellScriptProblems(busy)).toEqual([]);
  });

  it("rejects backgrounding, however it is spelled", () => {
    expect(shellScriptProblems("sleep 5 &\nwait\n").join()).toContain("backgrounds");
    expect(shellScriptProblems("sleep 5 & echo done\n").join()).toContain("backgrounds");
    expect(shellScriptProblems("nohup sort in.txt\n").join()).toContain("nohup");
    expect(shellScriptProblems("sort in.txt\ndisown\n").join()).toContain("disown");
  });

  it("rejects every non-determinism the laws name", () => {
    const fires = (script: string) => shellScriptProblems(script).length > 0;
    expect(fires('printf "%s\\n" "$RANDOM"\n')).toBe(true);
    expect(fires('printf "%s\\n" "$$"\n')).toBe(true);
    expect(fires('printf "%s\\n" "$SECONDS"\n')).toBe(true);
    expect(fires('date "+%Z"\n')).toBe(true);
    expect(fires("date +%Y\n")).toBe(true);
    expect(fires('printf "%s\\n" "$HOME"\n')).toBe(true);
    expect(fires('printf "%s\\n" ~/notes\n')).toBe(true);
    expect(fires("env\n")).toBe(true);
    expect(fires("du -s . | sort\n")).toBe(true);
    expect(fires("ls -l\n")).toBe(true);
    expect(fires("find . -name '*.log'\n")).toBe(true);
    expect(fires('declare -A c\nfor k in "${!c[@]}"; do printf "%s\\n" "$k"; done\n')).toBe(true);
  });

  it("rejects a path or a tool no host is promised to have", () => {
    expect(shellScriptProblems("cat /etc/passwd\n").join()).toContain("absolute path");
    expect(shellScriptProblems("cat C:/Windows/x\n").join()).toContain("drive-letter");
    expect(shellScriptProblems("PATH=/nonexistent sort in.txt\n").join()).toContain("PATH");
    expect(shellScriptProblems("jq . in.json\n").join()).toContain("`jq`");
    expect(shellScriptProblems("cat in.txt | rev\n").join()).toContain("`rev`");
    expect(shellScriptProblems("grep -oP 'x\\K.*' in.txt\n").join()).toContain("grep -P");
    expect(shellScriptProblems("find . -type f -exec curl {} ;\n").join()).toContain("`curl`");
    // A command substitution inside double quotes is code, and most scripts spell it that
    // way - blanking it with the rest of the string would hide the call entirely.
    expect(shellScriptProblems('printf "%s\\n" "$(jq -r .name in.json)"\n').join()).toContain("`jq`");
    // /dev/null is portable and stays legal; /dev/urandom is neither.
    expect(shellScriptProblems("sort in.txt > /dev/null\n")).toEqual([]);
    expect(shellScriptProblems("head -c 4 /dev/urandom\n").join()).toContain("/dev/null");
  });

  it("names the files maps that cannot become a directory tree", () => {
    expect(stagedKeyConflicts({ "a": "x", "a/b": "y" }).join()).toContain("parent directory");
    expect(stagedKeyConflicts({ "logs": "x", "LOGS/a.log": "y" }).join()).toContain("parent directory");
    expect(stagedKeyConflicts({ "a.txt": "", "A.txt": "" }).join()).toContain("differ only in case");
    expect(stagedKeyConflicts({ "logs/a.log": "", "Logs/A.LOG": "" }).join()).toContain("differ only in case");
    // Siblings, a deeper tree, and a file beside a directory: all stageable.
    expect(stagedKeyConflicts({ "d/a": "", "d/b": "", "d/e/f": "", "e": "" })).toEqual([]);
    expect(stagedKeyConflicts(undefined)).toEqual([]);
  });

  it("builds a cheese that prints case 1 verbatim, quoting and exit status included", () => {
    expect(echoCheese({ expectedStdout: "a\nb" })).toBe("printf '%s\\n' 'a' 'b'\n");
    expect(echoCheese({ expectedStdout: "it's here" })).toBe("printf '%s\\n' 'it'\\''s here'\n");
    expect(echoCheese({ expectedStdout: "", expectedExitCode: 3 })).toBe(":\nexit 3\n");
    // Trailing whitespace is trimmed by the grader, so the cheese prints what is graded.
    expect(echoCheese({ expectedStdout: "a  \n\n" })).toBe("printf '%s\\n' 'a'\n");
  });

  it("catches an expectation the grader would trim", () => {
    const trimmed = (s: string) => s === normalizeOutput(s);
    expect(trimmed("a\nb")).toBe(true);
    expect(trimmed("a\nb\n")).toBe(false);
    expect(trimmed("\na")).toBe(false);
    expect(trimmed("a \nb")).toBe(false);
  });
});

describe.skipIf(!hasBash())("shell gates - proof they fire, by execution", () => {
  const fixture: ShellWriteExercise = {
    kind: "write",
    id: "sr-sh-gate",
    axis: "syntax-recall",
    tier: 1,
    title: "count the lines",
    prompt: "print the number of lines in in.txt",
    language: "shell",
    softTimeLimitSeconds: 60,
    testTimeoutMs: 10_000,
    starterCode: "# your pipeline here\n",
    shellCases: [
      { files: { "in.txt": "a\nb\nc\n" }, expectedStdout: "3" },
      { files: { "in.txt": "a\n" }, expectedStdout: "1" },
    ],
  };
  const reference: ShellReference = { path: "sr-sh-gate.reference.sh", script: "wc -l < in.txt | tr -d ' '\n" };

  it("a good reference grades 1.00, twice, identically", async () => {
    const first = await gradeShellSource(fixture, reference.script);
    expect(first.harnessError).toBeUndefined();
    expect(first.passed).toBe(2);
    const second = await gradeShellSource(fixture, reference.script);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 60_000);

  it("...and the gate reds on a reference that does not answer its own drill", async () => {
    // Counts characters, not lines: right shape, wrong answer - what a transcribed
    // expectation looks like when nobody ran it.
    const r = await gradeShellSource(fixture, "wc -c < in.txt | tr -d ' '\n");
    expect(r.passed).toBeLessThan(r.total);
    expect(r.failures.map((f) => f.error).join()).toContain("case 1:");
  }, 60_000);

  it("the cheese passes case 1 and fails the drill", async () => {
    const r = await gradeShellSource(fixture, echoCheese(fixture.shellCases[0]!));
    expect(r.harnessError).toBeUndefined();
    expect(r.failures.map((f) => f.index)).not.toContain(0);
    expect(r.passed).toBe(1);
    expect(r.passed).toBeLessThan(fixture.shellCases.length);
  }, 60_000);

  it("...and a drill the cheese can pass is one the gate rejects", async () => {
    // Both cases expect the same output, so one hardcoded line answers the drill. The
    // schema refuses this shape at parse time; the gate is the second net, and this is
    // what it catches when an exercise reaches it another way.
    const cheeseable: ShellWriteExercise = {
      ...fixture,
      id: "sr-sh-gate-2",
      shellCases: [
        { files: { "in.txt": "a\nb\nc\n" }, expectedStdout: "ok" },
        { files: { "in.txt": "a\n" }, expectedStdout: "ok", expectedExitCode: 1 },
      ],
    };
    const r = await gradeShellSource(cheeseable, echoCheese(cheeseable.shellCases[0]!));
    // Case 2 differs only in exit status, which is exactly what the cheese reproduces
    // from case 1 - so it takes the exit code into account or it would score 2/2 here.
    expect(r.passed).toBe(1);
  }, 60_000);

  it("a files map that cannot be staged is a harnessError, not a score", async () => {
    const broken: ShellWriteExercise = {
      ...fixture,
      id: "sr-sh-gate-3",
      shellCases: [
        { files: { a: "x", "a/b": "y" }, expectedStdout: "3" },
        { files: { "in.txt": "a\n" }, expectedStdout: "1" },
      ],
    };
    const r = await gradeShellSource(broken, reference.script);
    // This is the failure the reference gate's message points at, and the reason the
    // static pairwise check exists: here it is an errno, there it names the two keys.
    expect(r.harnessError).toBeDefined();
    expect(r.passed).toBe(0);
    expect(stagedKeyConflicts(broken.shellCases[0]!.files).join()).toContain("parent directory");
  }, 60_000);
});

const javaCode = bank.filter(
  (e): e is CodeLikeExercise => JVM_KINDS.some((k) => k === e.kind) && e.language === "java",
);
const javaPredicts = bank.filter(
  (e): e is PredictExercise => e.kind === "predict-output" && e.language === "java",
);

/**
 * The schema's 10s default `testTimeoutMs` is a flake factory once javac + JVM startup
 * are on the clock, so java content whose grading starts a JVM (`spawnsJvm`: the
 * compiled kinds plus predict-output) is held to a floor. Static JSON only - this lint
 * spawns nothing and stays ungated.
 */
describe("java timeout floors", () => {
  const javaJvm = bank.filter((ex) => ex.language === "java" && spawnsJvm(ex.kind));

  it("the built-in bank ships java content of both graded shapes", () => {
    // Every java check in this file - the floors here and the whole JDK-gated describe
    // below - iterates one of these two sets, so losing the shipped java content would
    // turn all of them green by iterating nothing. Per-kind rather than one combined
    // count, because they gate different loops: the compiled kinds gate starter
    // compilation and planted bugs, predict-output gates snippet determinism, and a
    // bank keeping only one of them would leave the other's loop silently vacuous.
    // A pack pointed at by ATROPHY_BANK may legitimately ship no java, so only the
    // built-in bank is held to this. (The third arm of the same guard, sql, lives with
    // the gates it protects: "the built-in bank ships sql write content" above.)
    if (!validatingBuiltInBank) return;
    expect(javaCode.length, "built-in bank ships no java write/fix/harness content").toBeGreaterThan(0);
    expect(javaPredicts.length, "built-in bank ships no java predict-output content").toBeGreaterThan(0);
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
