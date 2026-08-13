import type { ExerciseGenerator } from "../bank/generators/types.js";
import { AXES, type Axis, type Exercise, type Language } from "../bank/schema.js";
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

export interface SelectOptions {
  statics: Exercise[];
  generators?: ExerciseGenerator[];
  axis: Axis;
  /** Current axis rating - drives tier targeting. */
  rating: number;
  /** Recently attempted exercise ids; their families are avoided when possible. */
  recentIds?: string[];
  language?: Language;
  random?: Rng;
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
    random = Math.random,
  } = opts;
  const recentFamilies = new Set(recentIds.map(familyOf));
  const matchesLang = (l: Language | "any") =>
    language === undefined || l === language || l === "any";

  const target = targetTier(rating);
  const tierOrder = [1, 2, 3].sort(
    (a, b) => Math.abs(a - target) - Math.abs(b - target) || b - a,
  );

  for (const tier of tierOrder) {
    const staticPool = statics.filter(
      (e) => e.axis === axis && e.tier === tier && matchesLang(e.language),
    );
    const genPool = generators.filter(
      (g) => g.axis === axis && g.tiers.includes(tier) && matchesLang(g.language),
    );
    const freshStatics = staticPool.filter((e) => !recentFamilies.has(familyOf(e.id)));
    const freshGens = genPool.filter((g) => !recentFamilies.has(g.family));
    const anyFresh = freshStatics.length > 0 || freshGens.length > 0;
    const useStatics = anyFresh ? freshStatics : staticPool;
    const useGens = anyFresh ? freshGens : genPool;

    const total = useStatics.length + useGens.length * GENERATOR_WEIGHT;
    if (total === 0) continue;

    let roll = random() * total;
    for (const ex of useStatics) {
      roll -= 1;
      if (roll < 0) return ex;
    }
    for (const g of useGens) {
      roll -= GENERATOR_WEIGHT;
      if (roll < 0) return g.generate(hexSeed(random), tier);
    }
    // floating-point edge: fall through to the last candidate
    if (useGens.length > 0) return useGens[useGens.length - 1]!.generate(hexSeed(random), tier);
    return useStatics[useStatics.length - 1];
  }
  return undefined;
}

/** Axes that actually have content for the given language ("any" counts for every language). */
export function availableAxes(
  bank: Exercise[],
  language?: Language,
  generators: ExerciseGenerator[] = [],
): Axis[] {
  const matchesLang = (l: Language | "any") =>
    language === undefined || l === language || l === "any";
  return AXES.filter(
    (axis) =>
      bank.some((e) => e.axis === axis && matchesLang(e.language)) ||
      generators.some((g) => g.axis === axis && matchesLang(g.language)),
  );
}
