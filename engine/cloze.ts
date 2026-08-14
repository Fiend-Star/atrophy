import { countBlanks, type ClozeExercise } from "../bank/schema.js";

/**
 * Cloze grading: pure, in-process, no subprocess. A snippet has N >= 1 `____` blanks and
 * every blank is a graded unit, so an attempt scores `blanksCorrect / totalBlanks`.
 *
 * The two `acceptedAnswers` shapes differ in how many answers the user types, never in
 * how many blanks are graded:
 *   - per-blank (`string[][]`, one set per blank, length enforced by the schema): the
 *     session asks once per blank, and partial credit is real;
 *   - flat (`string[]`): one answer fills every blank - the only shape a single-blank
 *     cloze ever needed, and what the shipped multi-blank statics mean ("the same
 *     stdlib module goes in both blanks"), so those grade all-or-nothing from one ask.
 */

/** Re-exported: the schema owns it (its parse rule needs it), this is the engine door. */
export { countBlanks };

/** Trim + collapse inner whitespace; cloze answers stay case-sensitive (API names are). */
export function normalizeClozeAnswer(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** True when the exercise carries one accepted set per blank rather than one for all. */
function isPerBlank(ex: ClozeExercise): boolean {
  return Array.isArray(ex.acceptedAnswers[0]);
}

/**
 * The accepted answers of each blank, in blank order. A flat list is one set shared by
 * every blank, so it expands to the blank count. Collecting both shapes and preferring
 * the nested one is exhaustive because a mixed array cannot parse.
 */
function blankSets(ex: ClozeExercise): string[][] {
  const flat: string[] = [];
  const perBlank: string[][] = [];
  for (const entry of ex.acceptedAnswers) {
    if (typeof entry === "string") flat.push(entry);
    else perBlank.push(entry);
  }
  if (perBlank.length > 0) return perBlank;
  return Array.from({ length: countBlanks(ex.snippet) }, () => flat);
}

/** How many answers the drill asks for: one per blank, or one that fills them all. */
export function promptCount(ex: ClozeExercise): number {
  return isPerBlank(ex) ? countBlanks(ex.snippet) : 1;
}

/** What blank `i` accepts; empty past the last blank. */
export function acceptedForBlank(ex: ClozeExercise, i: number): string[] {
  return blankSets(ex)[i] ?? [];
}

/** Which blanks the answers filled, in blank order - the detail the session prints back. */
export function blankResults(ex: ClozeExercise, answers: readonly string[]): boolean[] {
  const shared = !isPerBlank(ex); // one typed answer stands in for every blank
  return blankSets(ex).map((accepted, i) => {
    const typed = normalizeClozeAnswer(answers[shared ? 0 : i] ?? "");
    // A blank left empty is never a match, whatever an accepted answer normalizes to.
    return typed !== "" && accepted.some((a) => normalizeClozeAnswer(a) === typed);
  });
}

/** Score one attempt. `totalBlanks` is `totalUnits(ex)`: the snippet's blank count. */
export function gradeCloze(
  ex: ClozeExercise,
  answers: readonly string[],
): { blanksCorrect: number; totalBlanks: number } {
  const results = blankResults(ex, answers);
  return { blanksCorrect: results.filter(Boolean).length, totalBlanks: results.length };
}
