import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export const AXES = [
  "syntax-recall",
  "debugging",
  "code-reading",
  "api-memory",
  "decomposition",
] as const;

export const LANGUAGES = ["python", "javascript", "java", "sql"] as const;

/**
 * Kinds whose java grading compiles and runs a JVM (javac + java). `predict-output`
 * spawns one too, but through the single-file source launcher, so it shares neither
 * the compile step nor the harness staging these four do.
 */
export const JVM_KINDS = ["write", "fix", "write-harness", "fix-harness"] as const;
export type JvmKind = (typeof JVM_KINDS)[number];

export const testCaseSchema = z.object({
  /** Arguments passed to the exercise function, JSON-encodable. */
  args: z.array(z.unknown()),
  /** Expected return value, compared by canonical JSON equality. */
  expected: z.unknown(),
});
export type TestCase = z.infer<typeof testCaseSchema>;

/** One sql case: a fixture that builds the tables, and the rows the query must return. */
export const sqlCaseSchema = z.object({
  /** DDL + INSERTs applied to a fresh in-memory database before the query runs. */
  fixture: z.string().min(1),
  /** Expected result set; column names are part of the answer. */
  expectedRows: z.array(z.record(z.string(), z.unknown())),
});
export type SqlCase = z.infer<typeof sqlCaseSchema>;

/**
 * Canonical form of a result set: each row stringified with its keys sorted, then the
 * rows themselves sorted so row order cannot change the string. Two result sets are the
 * same answer (order ignored) exactly when their canonical forms are equal.
 */
export function canonicalRows(rows: readonly Record<string, unknown>[]): string {
  const canonicalRow = (row: Record<string, unknown>) => {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) sorted[key] = row[key];
    return JSON.stringify(sorted);
  };
  return JSON.stringify(rows.map(canonicalRow).sort());
}

/**
 * How many blanks a cloze snippet has: `____` runs, counted non-overlapping. It lives
 * here because the parse rule below needs it; `engine/cloze.ts` re-exports it as the
 * engine-side door so there is exactly one definition.
 */
export function countBlanks(snippet: string): number {
  return snippet.match(/____/g)?.length ?? 0;
}

const baseFields = {
  // static: sr-py-001 · generated: sr-py-cond-1a2b3c (family + hex seed)
  id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/, "id must look like sr-py-001 or family-abc123"),
  axis: z.enum(AXES),
  /** Difficulty tier: 1 (easy) to 3 (hard). */
  tier: z.number().int().min(1).max(3),
  title: z.string().min(1),
  /** Shown to the user before the drill starts. */
  prompt: z.string().min(1),
  /** Soft limit in seconds; going over shrinks the score, never blocks. */
  softTimeLimitSeconds: z.number().int().positive(),
  /** Hard timeout for one grading/snippet run. */
  testTimeoutMs: z.number().int().positive().default(10_000),
};

/** "single" = whiteboard mode: exactly one graded submission, no fix-and-resubmit loop. Absent means "loop". */
const submitPolicySchema = z.enum(["loop", "single"]).optional();

/**
 * Kinds where the user edits code that gets run against hidden tests - except sql
 * writes, which have no function to call and are graded by `cases` instead. The
 * either/or is not expressible in the object shape, so the fields are optional here
 * and the refinement below decides which set an exercise must carry.
 */
const codeFields = {
  ...baseFields,
  language: z.enum(LANGUAGES),
  /** Name of the function the harness will call. Required off sql. */
  functionName: z.string().min(1).optional(),
  /** Written into the solution file the user edits (for "fix": the buggy code). */
  starterCode: z.string().min(1),
  /** Hidden tests. Required off sql. */
  tests: z.array(testCaseSchema).min(1).optional(),
  /** sql only: fixtures + the rows the query must return. Two, so a literal cannot pass. */
  cases: z.array(sqlCaseSchema).min(2).optional(),
  /** sql only: when true, row order is part of the answer (ORDER BY drills). */
  ordered: z.boolean().optional(),
  submitPolicy: submitPolicySchema,
};

/** Kinds where the exercise ships its own Java test harness (behavioral drills). */
const harnessFields = {
  ...baseFields,
  language: z.literal("java"),
  /** Written into Solution.java for the user to edit (for "fix-harness": the buggy code). */
  starterCode: z.string().min(1),
  /** A complete `public class Harness` with main(); must print one ATROPHY_RESULT line. */
  testCode: z.string().min(1),
  /** Declared number of checks; the harness's reported total must match at grade time. */
  totalChecks: z.number().int().min(1),
  submitPolicy: submitPolicySchema,
};

const exerciseUnion = z.discriminatedUnion("kind", [
  /** Syntax recall: write a function from spec. */
  z.object({ kind: z.literal("write"), ...codeFields }),
  /** Debugging: starterCode contains a planted bug; make the tests pass. */
  z.object({ kind: z.literal("fix"), ...codeFields }),
  /** Write-from-spec, graded by the exercise's own Java harness (concurrency etc.). */
  z.object({ kind: z.literal("write-harness"), ...harnessFields }),
  /** Planted bug, graded by the exercise's own Java harness. */
  z.object({ kind: z.literal("fix-harness"), ...harnessFields }),
  /** Code reading: predict the snippet's exact stdout (ground truth is computed by running it). */
  z.object({
    kind: z.literal("predict-output"),
    ...baseFields,
    language: z.enum(LANGUAGES),
    snippet: z.string().min(1),
  }),
  /**
   * API/stdlib memory: fill the snippet's ____ blanks. Two answer shapes, and they
   * differ in how many answers the user types, not in how many blanks are graded:
   * one set per blank (`string[][]`, length checked against the snippet below), or a
   * flat set that fills every blank - the single-blank shape, unchanged, and what a
   * multi-blank static means today ("the same stdlib module goes in both blanks").
   */
  z.object({
    kind: z.literal("cloze"),
    ...baseFields,
    language: z.enum(LANGUAGES),
    snippet: z.string().min(1),
    acceptedAnswers: z.union([
      z.array(z.string().min(1)).min(1),
      z.array(z.array(z.string().min(1)).min(1)).min(1),
    ]),
  }),
  /** Decomposition: outline an approach, self-scored against a rubric (LLM-judged in v2). */
  z.object({
    kind: z.literal("outline"),
    ...baseFields,
    language: z.literal("any"),
    rubric: z.array(z.string().min(1)).min(1),
  }),
  /** Concept/puzzle recall: short answer, numeric-tolerant match (1/4 == 0.25 == 25%). */
  z.object({
    kind: z.literal("recall"),
    ...baseFields,
    language: z.literal("any"),
    acceptedAnswers: z.array(z.string().min(1)).min(1),
    /** Derivation shown after grading; never graded. */
    reveal: z.string().min(1).optional(),
  }),
]);

/**
 * Cross-field rules the discriminated union cannot state on its own. Only a sql write
 * carries `cases`; every other write/fix carries `tests` + `functionName`. sql exists
 * as a language for that one kind: there is nothing to "fix" in a query the user never
 * wrote, and a query has no stdout to predict. A cloze's per-blank answers are the
 * other such rule: their count only means something against the snippet.
 */
const refinedUnion = exerciseUnion.superRefine((ex, ctx) => {
  const reject = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const sqlIsWriteOnly = "sql is only supported on write exercises";

  if (ex.kind === "write" && ex.language === "sql") {
    if (ex.tests) reject("tests", "sql exercises have no hidden tests - grade them with cases");
    if (ex.functionName) reject("functionName", "sql exercises have no function to call");
    if (!ex.cases) reject("cases", "sql exercises are graded by cases, which is required");
    // Two cases that expect the same rows are one case: a hardcoded literal passes both,
    // which is exactly the answer the drill exists to rule out.
    else if (new Set(ex.cases.map((c) => canonicalRows(c.expectedRows))).size < 2) {
      reject("cases", "at least two cases must expect different rows, or a hardcoded answer passes");
    }
    return;
  }
  if (ex.kind === "write" || ex.kind === "fix") {
    if (ex.language === "sql") reject("language", sqlIsWriteOnly);
    if (!ex.tests) reject("tests", "tests are required");
    if (!ex.functionName) reject("functionName", "functionName is required");
    if (ex.cases) reject("cases", "cases is sql-only");
    if (ex.ordered !== undefined) reject("ordered", "ordered is sql-only");
    return;
  }
  if (ex.kind === "predict-output" && ex.language === "sql") reject("language", sqlIsWriteOnly);
  if (ex.kind === "cloze") {
    const blanks = countBlanks(ex.snippet);
    // The union has already rejected a mixed array, so the first entry decides the shape.
    const perBlank = Array.isArray(ex.acceptedAnswers[0]);
    if (blanks === 0) reject("snippet", "cloze snippet must contain at least one ____ blank");
    // The flat shape needs no count check: one set fills however many blanks there are.
    else if (perBlank && ex.acceptedAnswers.length !== blanks) {
      reject(
        "acceptedAnswers",
        `per-blank acceptedAnswers needs one set per ____ blank (sets: ${ex.acceptedAnswers.length}, blanks: ${blanks})`,
      );
    }
  }
});

/** What the object shapes alone say: write/fix with every graded field optional. */
type RawExercise = z.infer<typeof refinedUnion>;
/** The sql shape of a write: graded by `cases`, never by hidden tests. */
export type SqlWriteExercise = Extract<RawExercise, { kind: "write" }> & {
  language: "sql";
  cases: SqlCase[];
};
/**
 * Every other write/fix: the `functionName` + `tests` pairing, made definite. The
 * language exclusion is what makes `isSqlWrite` narrow soundly in the *false*
 * direction: without it a hand-built `{ language: "sql", tests: [...] }` literal is
 * assignable here, and the grader's sql check would then hand a `tests`-shaped
 * exercise to the language lanes.
 */
export type TestedExercise = Extract<RawExercise, { kind: "write" | "fix" }> & {
  language: Exclude<Language, "sql">;
  functionName: string;
  tests: TestCase[];
};
/**
 * write/fix, split into the two graded shapes. Keeping the split in `Exercise` itself
 * is what lets `isSqlWrite` narrow in *both* directions, so a consumer reading `tests`
 * needs no assertion - the refinement above is what makes that sound, and
 * `parseExercise` is the only door these types come through.
 */
export type CodeExercise = SqlWriteExercise | TestedExercise;
export type Exercise = Exclude<RawExercise, { kind: "write" | "fix" }> | CodeExercise;

/**
 * Parsing is the only place the split above can be established: the refinement has just
 * proved it, and zod cannot say so in the inferred type. Identity at runtime.
 */
export const exerciseSchema = refinedUnion.transform((ex): Exercise => ex as Exercise);
export type HarnessExercise = Extract<Exercise, { kind: "write-harness" | "fix-harness" }>;
/** Anything the user edits as a solution file, hidden-test or harness graded. */
export type CodeLikeExercise = CodeExercise | HarnessExercise;
export type PredictExercise = Extract<Exercise, { kind: "predict-output" }>;
export type ClozeExercise = Extract<Exercise, { kind: "cloze" }>;
export type OutlineExercise = Extract<Exercise, { kind: "outline" }>;
export type RecallExercise = Extract<Exercise, { kind: "recall" }>;
export type Axis = (typeof AXES)[number];
export type Language = (typeof LANGUAGES)[number];

export function isCode(ex: Exercise): ex is CodeExercise {
  return ex.kind === "write" || ex.kind === "fix";
}

/** The sql write shape: `cases` in, `tests`/`functionName` out. */
export function isSqlWrite(ex: Exercise): ex is SqlWriteExercise {
  return ex.kind === "write" && ex.language === "sql";
}

export function isHarness(ex: Exercise): ex is HarnessExercise {
  return ex.kind === "write-harness" || ex.kind === "fix-harness";
}

/**
 * Kinds whose grading starts a JVM - the compiled `JVM_KINDS` plus `predict-output`,
 * which reaches one through the single-file source launcher instead. Paired with
 * `language === "java"` this is the "needs a JDK" test: a java cloze is string-matched
 * in-process and a java outline/recall never runs anything, so neither belongs here.
 */
export function spawnsJvm(kind: Exercise["kind"]): boolean {
  return kind === "predict-output" || JVM_KINDS.some((k) => k === kind);
}

/** How many gradable units the exercise has (drives passed/total bookkeeping). */
export function totalUnits(ex: Exercise): number {
  switch (ex.kind) {
    case "write":
    case "fix":
      return isSqlWrite(ex) ? ex.cases.length : ex.tests.length;
    case "write-harness":
    case "fix-harness":
      return ex.totalChecks;
    case "predict-output":
      return 1;
    // Every blank is a graded unit, so a multi-blank cloze scores as a fraction.
    case "cloze":
      return countBlanks(ex.snippet);
    case "outline":
      return ex.rubric.length;
    case "recall":
      return 1;
  }
}

export class BankError extends Error {}

/** Parse and validate a single exercise JSON string. */
export function parseExercise(json: string, source = "<inline>"): Exercise {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new BankError(`${source}: invalid JSON: ${(err as Error).message}`);
  }
  const result = exerciseSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BankError(`${source}: invalid exercise: ${issues}`);
  }
  return result.data;
}

/** Recursively load every *.json exercise under one or more bank directories. */
export function loadBank(dirs: string | string[]): Exercise[] {
  const roots = Array.isArray(dirs) ? dirs : [dirs];
  const exercises: Exercise[] = [];
  const seen = new Map<string, string>(); // id -> resolved path of the file that declared it
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const canonical = resolve(full);
        const ex = parseExercise(readFileSync(full, "utf8"), full);
        const first = seen.get(ex.id);
        // Roots may overlap (the same dir twice, or a pack nested under the bank), so the
        // same file can be walked more than once. That is not a duplicate id.
        if (first === canonical) continue;
        if (first) throw new BankError(`duplicate exercise id: ${ex.id} (${first} and ${canonical})`);
        seen.set(ex.id, canonical);
        exercises.push(ex);
      }
    }
  };
  for (const root of roots) walk(root);
  return exercises;
}
