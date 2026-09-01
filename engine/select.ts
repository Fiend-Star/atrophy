import type { ExerciseGenerator } from "../bank/generators/types.js";
import { AXES, spawnsJvm, spawnsShell, type Axis, type Exercise, type Language } from "../bank/schema.js";
import { hasBash } from "./bashtool.js";
import { hasJdk } from "./javatool.js";
import { hexSeed, type Rng } from "./rng.js";
import { expectedScore } from "./scoring.js";

/**
 * Information-optimal difficulty: prefer the tier where the predicted success
 * chance is nearest ~65% - hard enough to move the rating, kind enough to be
 * winnable. (A comfortable 90%-win drill teaches the Elo almost nothing.)
 */
export const TARGET_SUCCESS = 0.65;

export function targetTier(rating: number): number {
  let best = 1;
  let bestD = Infinity;
  for (const t of [1, 2, 3]) {
    const d = Math.abs(expectedScore(rating, t) - TARGET_SUCCESS);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Generated ids end in "-<6 hex>": strip the seed to get the family. */
export function familyOf(exerciseId: string): string {
  const m = GENERATED_ID.exec(exerciseId);
  return m ? m[1]! : exerciseId;
}

/** Generated exercise id shape: "<family>-<6 hex seed>". */
const GENERATED_ID = /^(.+)-([0-9a-f]{6})$/;

/**
 * Resolve a specific exercise by id (for replay / preview / scripting).
 * A static bank id loads directly; a generated "family-seed" id is rebuilt from
 * its family generator. Tier is not encoded in the id, so pass the tier the
 * exercise was played at (from the session row) for an exact reproduction;
 * otherwise the family's first tier is used.
 */
export function resolveExercise(
  id: string,
  opts: { statics: Exercise[]; generators?: ExerciseGenerator[]; tier?: number },
): Exercise | undefined {
  const stat = opts.statics.find((e) => e.id === id);
  if (stat) return stat; // static ids win, even if they look generated
  const m = GENERATED_ID.exec(id);
  if (!m) return undefined;
  const [, family, seed] = m;
  const gen = (opts.generators ?? []).find((g) => g.family === family);
  if (!gen) return undefined;
  const tier = opts.tier ?? gen.tiers[0]!;
  return gen.generate(seed!, tier);
}

/** A generator family offers many variants, so it outweighs one static file. */
const GENERATOR_WEIGHT = 2;

/**
 * Language mix soft-cap (spec E1): with no --lang, nothing else stops one concrete
 * language from dominating a stretch of draws (a pack can skew the pool hard). A
 * language holding at least LANGUAGE_CAP_THRESHOLD of the caller's last
 * LANGUAGE_CAP_WINDOW sessions has its candidates' weight multiplied by
 * LANGUAGE_CAP_MULTIPLIER. Soft only: weights renormalize inside the pick, so an
 * all-dominant pool still serves - the pool is never filtered.
 */
const LANGUAGE_CAP_MULTIPLIER = 0.25;
const LANGUAGE_CAP_WINDOW = 6;
const LANGUAGE_CAP_THRESHOLD = 3;

/**
 * Concrete languages dominant in the recent window. "any" sessions occupy window
 * slots but are language-agnostic evidence: they never count toward dominance
 * (and "any" candidates never pay the penalty).
 */
function cappedLanguages(recentLanguages: readonly (Language | "any")[]): Set<Language> {
  const counts = new Map<Language, number>();
  const capped = new Set<Language>();
  for (const lang of recentLanguages.slice(0, LANGUAGE_CAP_WINDOW)) {
    if (lang === "any") continue;
    const n = (counts.get(lang) ?? 0) + 1;
    counts.set(lang, n);
    if (n >= LANGUAGE_CAP_THRESHOLD) capped.add(lang);
  }
  return capped;
}

/** Which graders this host can actually run. Injected so tests never probe. */
export interface Toolchains {
  jdk: boolean;
  bash: boolean;
}

/** The real probe; `hasJdk`/`hasBash` each cache their one spawn per process. */
function hostToolchains(): Toolchains {
  return { jdk: hasJdk(), bash: hasBash() };
}

/**
 * A host with everything installed - the "what could ever be offered" arm below.
 *
 * Exported because the CLI's *reporting* needs the same arm, and cannot honestly build it
 * itself: `hiddenByLanguages` and `availableAxes` run on the real toolchains, which is the
 * right answer to "what did this host lose" and the wrong one to "would that fix help".
 * (A shell write excluded by both the allowlist and a missing bash is billed to bash, so
 * the allowlist reads 0 and "install bash" becomes the only advice - for a drill installing
 * bash would still not serve.) Frozen, and a literal here rather than in the CLI so a third
 * toolchain reaches every arm through the same type error.
 */
export const EVERY_TOOLCHAIN: Readonly<Toolchains> = Object.freeze({ jdk: true, bash: true });

/**
 * What selection needs to know about a candidate before it exists: an exercise carries
 * both fields, and a family declares them for every variant it renders.
 */
interface Candidate {
  language: Language | "any";
  kind: Exercise["kind"];
}

/**
 * Every toolchain gate, in the order a hidden drill is attributed to one (see
 * `hiddenByToolchain`). One table drives both the gate and the accounting, so a third
 * toolchain lands in both at once rather than in the gate alone.
 *
 * Only java drills whose grading starts a JVM need the JDK - write/fix/harness compile
 * and run, predict-output goes through the source launcher. Only a shell `write` needs
 * bash: it is shell's one graded-code kind, and grading it means running the script.
 * Without the toolchain those drills grade as a harnessError, which records nothing, so
 * offering them only wastes the user's time. A java or shell cloze is string-matched
 * in-process and stays on offer, as does everything python, JS and sql (sql rides the
 * bundled better-sqlite3).
 */
const TOOLCHAIN_GATES = [
  { tool: "jdk", needs: (c: Candidate) => c.language === "java" && spawnsJvm(c.kind) },
  { tool: "bash", needs: (c: Candidate) => c.language === "shell" && spawnsShell(c.kind) },
] as const satisfies readonly { tool: keyof Toolchains; needs: (c: Candidate) => boolean }[];

/** Can this host grade the candidate at all? Every gate it trips has to be satisfied. */
function gradable(c: Candidate, toolchains: Toolchains): boolean {
  return TOOLCHAIN_GATES.every((g) => toolchains[g.tool] || !g.needs(c));
}

/**
 * The toolchain to blame for hiding a candidate: the FIRST missing gate it trips, so a
 * drill needing two absent toolchains is billed to one bucket rather than to both.
 * `undefined` means this host can grade it.
 */
function blockedBy(c: Candidate, toolchains: Toolchains): keyof Toolchains | undefined {
  return TOOLCHAIN_GATES.find((g) => !toolchains[g.tool] && g.needs(c))?.tool;
}

/**
 * One offer rule for both entry points: the requested language must match ("any"
 * content matches every request), this host must be able to grade it, and (absent
 * an explicit language) it must be on the allowlist.
 *
 * The allowlist only applies when `language` is undefined: an explicit --lang is the
 * user steering, same rule as the mix soft-cap, and it bypasses the allowlist outright.
 * "any" content always passes; an empty or absent list means no filtering.
 */
function offerable(
  c: Candidate,
  language: Language | undefined,
  toolchains: Toolchains,
  allowed?: Language[],
): boolean {
  const matchesLang = language === undefined || c.language === language || c.language === "any";
  if (
    language === undefined &&
    allowed !== undefined &&
    allowed.length > 0 &&
    c.language !== "any" &&
    !allowed.includes(c.language)
  ) {
    return false;
  }
  return matchesLang && gradable(c, toolchains);
}

export interface SelectOptions {
  statics: Exercise[];
  generators?: ExerciseGenerator[];
  axis: Axis;
  /** Current axis rating - drives tier targeting. */
  rating: number;
  /** Recently attempted exercise ids; their families are avoided when possible. */
  recentIds?: string[];
  language?: Language;
  /**
   * Languages of the caller's most recent recorded sessions, most-recent-first
   * (the CLI passes the store's last six). Feeds the mix soft-cap; absent means
   * no policy. Ignored entirely when `language` is set - an explicit --lang is
   * the user steering, and selection never fights it.
   */
  recentLanguages?: (Language | "any")[];
  /**
   * Restrict candidates to this set (plus "any" content, which always passes).
   * Ignored entirely when `language` is set - an explicit --lang is the user
   * steering, same rule as the mix soft-cap. Empty or absent means no filtering.
   */
  allowedLanguages?: Language[];
  random?: Rng;
  /** Defaults to this host's real toolchains; tests pass a fake instead. */
  toolchains?: Toolchains;
}

/**
 * Pick the next exercise: target the most informative tier, mix generator
 * variants with the static bank, and avoid recently-seen families so drills
 * rotate instead of repeating.
 */
export function selectExercise(opts: SelectOptions): Exercise | undefined {
  const {
    statics,
    generators = [],
    axis,
    rating,
    recentIds = [],
    language,
    recentLanguages,
    allowedLanguages,
    random = Math.random,
    toolchains = hostToolchains(),
  } = opts;
  const recentFamilies = new Set(recentIds.map(familyOf));
  const offer = (c: Candidate) => offerable(c, language, toolchains, allowedLanguages);
  const capped =
    language === undefined && recentLanguages ? cappedLanguages(recentLanguages) : new Set<Language>();
  const langWeight = (l: Language | "any") => (l !== "any" && capped.has(l) ? LANGUAGE_CAP_MULTIPLIER : 1);

  const target = targetTier(rating);
  const tierOrder = [1, 2, 3].sort(
    (a, b) => Math.abs(a - target) - Math.abs(b - target) || b - a,
  );

  for (const tier of tierOrder) {
    const staticPool = statics.filter(
      (e) => e.axis === axis && e.tier === tier && offer(e),
    );
    const genPool = generators.filter(
      (g) => g.axis === axis && g.tiers.includes(tier) && offer(g),
    );
    const freshStatics = staticPool.filter((e) => !recentFamilies.has(familyOf(e.id)));
    const freshGens = genPool.filter((g) => !recentFamilies.has(g.family));
    const anyFresh = freshStatics.length > 0 || freshGens.length > 0;
    const useStatics = anyFresh ? freshStatics : staticPool;
    const useGens = anyFresh ? freshGens : genPool;

    // Language multipliers compose with the generator weight and renormalize via
    // `total`, so a capped-language-only pool still serves (weights never hit 0).
    const staticWeights = useStatics.map((e) => langWeight(e.language));
    const genWeights = useGens.map((g) => GENERATOR_WEIGHT * langWeight(g.language));
    let total = 0;
    for (const w of staticWeights) total += w;
    for (const w of genWeights) total += w;
    if (total === 0) continue;

    let roll = random() * total;
    for (let i = 0; i < useStatics.length; i++) {
      roll -= staticWeights[i]!;
      if (roll < 0) return useStatics[i];
    }
    for (let i = 0; i < useGens.length; i++) {
      roll -= genWeights[i]!;
      if (roll < 0) return useGens[i]!.generate(hexSeed(random), tier);
    }
    // floating-point edge: fall through to the last candidate
    if (useGens.length > 0) return useGens[useGens.length - 1]!.generate(hexSeed(random), tier);
    return useStatics[useStatics.length - 1];
  }
  return undefined;
}

/**
 * Axes that actually have drillable content for the given language ("any" counts for
 * every language). Same offer rule as `selectExercise`, so an axis is never announced
 * as available and then found empty when the drill asks for one.
 */
export function availableAxes(
  bank: Exercise[],
  language?: Language,
  generators: ExerciseGenerator[] = [],
  toolchains: Toolchains = hostToolchains(),
  allowedLanguages?: Language[],
): Axis[] {
  const offer = (c: Candidate) => offerable(c, language, toolchains, allowedLanguages);
  return AXES.filter(
    (axis) => bank.some((e) => e.axis === axis && offer(e)) || generators.some((g) => g.axis === axis && offer(g)),
  );
}

/** How many candidates each missing toolchain hid, one bucket per toolchain. */
export type HiddenByToolchain = Record<keyof Toolchains, number>;

/**
 * How many candidates for this axis the host's missing toolchains hid: drills that
 * exist and match the request but cannot be graded here, split by which toolchain is
 * to blame. The CLI prints this so a missing toolchain never silently shrinks the pool
 * a user is being measured on - and so it can name the right one, since telling a host
 * that only lacks bash to install a JDK is its own kind of lie.
 *
 * Every hidden drill lands in exactly one bucket: the first gate in `TOOLCHAIN_GATES`
 * it trips that this host cannot satisfy. No candidate needs two toolchains today
 * (java content never runs a script, shell content never starts a JVM), so the order is
 * not yet a judgement call - but one that did would be counted once, by that rule,
 * rather than inflating both buckets and the total with it.
 */
export function hiddenByToolchain(
  opts: Pick<SelectOptions, "statics" | "generators" | "axis" | "language" | "toolchains">,
): HiddenByToolchain {
  const { statics, generators = [], axis, language, toolchains = hostToolchains() } = opts;
  const hidden: HiddenByToolchain = { jdk: 0, bash: 0 };
  const tally = (c: Candidate) => {
    // The two-arm shape: what a fully equipped host would offer, minus what this one can.
    if (!offerable(c, language, EVERY_TOOLCHAIN)) return;
    const tool = blockedBy(c, toolchains);
    if (tool) hidden[tool]++;
  };
  for (const e of statics) if (e.axis === axis) tally(e);
  for (const g of generators) if (g.axis === axis) tally(g);
  return hidden;
}

/**
 * How many candidates for this axis the language allowlist hid: drills that would be
 * offerable without it but are excluded once it applies. Mirrors `hiddenByToolchain`'s
 * two-arm shape - both arms use the real toolchains, so a JDK-hidden java write or a
 * bash-hidden shell write is never counted here too (neither was offerable to begin
 * with). Each narrowing is reported once, by whichever of the two actually caused it.
 */
export function hiddenByLanguages(
  opts: Pick<SelectOptions, "statics" | "generators" | "axis" | "toolchains">,
  allowed: Language[],
): number {
  const { statics, generators = [], axis, toolchains = hostToolchains() } = opts;
  const hidden = (c: Candidate) =>
    offerable(c, undefined, toolchains) && !offerable(c, undefined, toolchains, allowed);
  return (
    statics.filter((e) => e.axis === axis && hidden(e)).length +
    generators.filter((g) => g.axis === axis && hidden(g)).length
  );
}
