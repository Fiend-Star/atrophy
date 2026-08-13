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

export const LANGUAGES = ["python", "javascript", "java"] as const;

export const testCaseSchema = z.object({
  /** Arguments passed to the exercise function, JSON-encodable. */
  args: z.array(z.unknown()),
  /** Expected return value, compared by canonical JSON equality. */
  expected: z.unknown(),
});

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

/** Kinds where the user edits code that gets run against hidden tests. */
const codeFields = {
  ...baseFields,
  language: z.enum(LANGUAGES),
  /** Name of the function the harness will call. */
  functionName: z.string().min(1),
  /** Written into the solution file the user edits (for "fix": the buggy code). */
  starterCode: z.string().min(1),
  tests: z.array(testCaseSchema).min(1),
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

export const exerciseSchema = z.discriminatedUnion("kind", [
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
  /** API/stdlib memory: fill the ____ blank in the snippet. */
  z.object({
    kind: z.literal("cloze"),
    ...baseFields,
    language: z.enum(LANGUAGES),
    snippet: z.string().min(1),
    acceptedAnswers: z.array(z.string().min(1)).min(1),
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

export type Exercise = z.infer<typeof exerciseSchema>;
export type CodeExercise = Extract<Exercise, { kind: "write" | "fix" }>;
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

export function isHarness(ex: Exercise): ex is HarnessExercise {
  return ex.kind === "write-harness" || ex.kind === "fix-harness";
}

/** How many gradable units the exercise has (drives passed/total bookkeeping). */
export function totalUnits(ex: Exercise): number {
  switch (ex.kind) {
    case "write":
    case "fix":
      return ex.tests.length;
    case "write-harness":
    case "fix-harness":
      return ex.totalChecks;
    case "predict-output":
    case "cloze":
      return 1;
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
