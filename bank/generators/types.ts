import type { Axis, Exercise, Language } from "../schema.js";
import { mulberry32, seedFromString, type Rng } from "../../engine/rng.js";

/**
 * A generator is a hand-designed exercise *family* that renders endless
 * concrete variants. Determinism contract: generate(seed, tier) must return
 * an identical exercise for identical inputs - the seed is embedded in the
 * exercise id, so any recorded session is reproducible.
 */
export interface ExerciseGenerator {
  /** Id prefix for generated exercises, e.g. "sr-py-cond". */
  family: string;
  axis: Axis;
  /** "any" for families whose drills are language-agnostic (outline, recall): they are
   *  offered whatever `--lang` asks for, exactly as an "any" exercise is. */
  language: Language | "any";
  tiers: readonly number[];
  generate(seed: string, tier: number): Exercise;
}

/** One PRNG per (family, tier, seed) so families can't bleed into each other. */
export function rngFor(family: string, seed: string, tier: number): Rng {
  return mulberry32(seedFromString(`${family}:${tier}:${seed}`));
}

export const SOFT_LIMIT_BY_TIER: Record<number, number> = { 1: 180, 2: 300, 3: 420 };
export const CLOZE_LIMIT_BY_TIER: Record<number, number> = { 1: 60, 2: 90, 3: 120 };
export const PREDICT_LIMIT_BY_TIER: Record<number, number> = { 1: 120, 2: 180, 3: 240 };
