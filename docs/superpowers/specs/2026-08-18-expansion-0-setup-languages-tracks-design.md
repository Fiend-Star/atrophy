# Expansion-0: `atrophy setup`, language allowlist, and track selection — design

**Date:** 2026-08-18
**Status:** draft, awaiting user review
**Branch:** `feat/setup-languages-tracks` (off `feat/java-language-support` @ ff921c5)
**Motivation (user, verbatim intent):** "adding an option at the start, to choose languages — some people do java + shell and don't wanna test for node or python" and "if I want to prepare for Aurora, I can do so, or HRT or etc."

## Goal

Two persistent preferences, chosen once and respected by every command, both overridable per run:

1. **Language allowlist** — the user names the languages they want to be drilled in; selection serves only those plus language-agnostic (`"any"`) content.
2. **Track focus** — the user names one exercise pack (e.g. the Aurora pack, the HRT pack) as their current prep target; selection serves only that pack's drills.

Plus the front door for both: an `atrophy setup` command (interactive prompts, or flags for scripting).

## Non-goals

- No new exercise kinds, no schema changes to exercises, no `shell` language (that is Expansion-4's engine task).
- No change to rating math, storage schema, sync, or the dashboard payload.
- Tracks are **packs** — no per-exercise `track` tag, no curriculum metadata beyond an optional `pack.json` name. A future many-packs-one-track grouping is YAGNI until a corpus needs it.
- `--exercise <id>` replay ignores both preferences (explicit id beats every filter, same as today's static-id-wins rule).

## Design

### 1. Config (`cli/config.ts`)

`AtrophyConfig` gains two optional fields:

```ts
export interface AtrophyConfig {
  leaderboard?: { token?: string; handle?: string; url?: string };
  packs?: string[];
  /** Serve only these languages (plus "any"-tagged drills). Absent/empty = all. */
  languages?: Language[];
  /** Serve only the pack with this track name. Absent = all content. */
  track?: string;
}
```

Hand-edited configs are tolerated the way `packs` already is: `configLanguages(env)` returns the entries that are valid `Language` members (unknown strings are dropped, non-arrays ignored); `configTrack(env)` returns a trimmed non-empty string or `undefined`. `doctor` warns about dropped entries; nothing throws.

Precedence for every preference: **CLI flag > env (none new) > config > default (off)**. An explicit `--lang X` serves X even if X is outside the allowlist — the allowlist is a default, not a lock, exactly as `--lang` already disables the mix soft-cap. `--track` overrides the config track for one run; `--track all` (reserved word) disables track focus for one run.

### 2. Pack identity: track names (`cli/config.ts` + `bank/schema.ts`)

A **track name** identifies one pack directory:

- If the pack dir contains a `pack.json` with `{ "name": "<slug>" }` (zod: lowercase `[a-z0-9-]{1,32}`; other fields like `description` allowed and ignored), that is the track name.
- Otherwise the directory's basename is the track name (compared case-insensitively — Windows paths).
- The reserved name **`base`** means the built-in bank (or `ATROPHY_BANK` when set) — "only built-in content" is expressible.
- Two packs resolving to the same track name is a `doctor` warning and a hard error only when `--track`/config actually names the ambiguous track.
- A configured track that matches no pack is a friendly error naming the discovered tracks (same spirit as the missing-pack-dir error).

`pack.json` is not an exercise file (loadBank walks only `*.json` — so `pack.json` must be **excluded from the exercise walk by name**; today it would be parsed as an exercise and throw).

### 3. Bank provenance (`bank/schema.ts`)

`loadBank(dirs)` keeps its signature and behavior. A new export shares the same walk (one implementation, `loadBank` delegates):

```ts
export interface BankEntry { exercise: Exercise; root: string /* the dirs[] member it came from */ }
export function loadBankDetailed(dirs: string | string[]): BankEntry[];
```

Cross-dir duplicate-id detection is unchanged (single walk). The CLI uses `loadBankDetailed` and applies the track filter by `root`; everything downstream still receives plain `Exercise[]`.

### 4. Selection (`engine/select.ts`)

`SelectOptions` gains one field, mirrored into `availableAxes`:

```ts
/** Config allowlist. Ignored when `language` is set (explicit --lang wins). A candidate
 *  is offerable when its language is in the list or is "any". Absent/empty = all. */
allowedLanguages?: Language[];
```

`offerable(c, language, toolchains, allowedLanguages?)` adds one clause: `language === undefined && allowedLanguages?.length ? (c.language === "any" || allowedLanguages.includes(c.language)) : true` composed with the existing rules. Toolchain gating is unchanged and composes (both filters apply).

A narrowed pool is never silent (same product rule as toolchains):

```ts
export function hiddenByLanguages(
  opts: Pick<SelectOptions, "statics" | "generators" | "axis" | "toolchains">,
  allowed: Language[],
): number;  // candidates offerable without the allowlist but not with it
```

The CLI prints one line when it is non-zero: `config limits languages to java, sql — N drills hidden on this axis (atrophy setup to change)`.

**Track × generators:** built-in generator families belong to the `base` track. When track focus names a pack, generators are excluded (packs cannot ship code); when track is `base` or off, generators participate as today. The 2× family weighting simply has nothing to weight under a pack track — selection already serves statics-only pools.

**Mix soft-cap interplay:** unchanged. Window rows in languages outside the allowlist still occupy slots (spec E1 semantics untouched); with a one-language allowlist the cap penalizes and renormalizes to the same pick — harmless by construction (soft, never filters).

### 5. CLI (`cli/index.ts` + new `cli/setup.ts`)

New command:

```
atrophy setup                      # interactive: pick languages, pick track, saved to config
atrophy setup --languages java,sql # non-interactive setters (comma list, validated)
atrophy setup --all-languages      # clear the allowlist
atrophy setup --track aurora       # set track focus
atrophy setup --track all          # clear track focus
atrophy setup --show               # print current config + discovered tracks, change nothing
```

Interactive mode (readline, same stdin discipline as the drill loop): numbered multi-select over `LANGUAGES` ("enter for all"), then a numbered pick over discovered tracks — `all`, `base`, plus each pack's track name with its drill count. Flags make it fully scriptable; tests drive flags only (interactive path gets one readline-scripted test, same technique as `session.test.ts`).

`drill` and `baseline` gain `--track <name>`. Both commands (and `drillOnce`) thread `allowedLanguages` + the track filter through selection and `availableAxes`; `baseline` sweeps only axes that survive the filters. `drillOnce` keeps its `opts.languageMix` contract; config reading happens in the actions, passed down as plain values so tests inject rather than mock the filesystem.

`doctor` gains a section: configured languages (or "all"), configured track (or "all"), the discovered track table (name → dir → drill count), plus the two warnings (invalid config entries dropped; ambiguous track names).

### 6. Docs

README: a short "Choose your languages / pick a track" section under setup; the five-skills table and `--lang` row are untouched (readme-claims fixtures unaffected — verify, don't assume). `--help` copy for the new flags. The Field Guide artifact is updated at effort close (session action, not repo code).

## Testing

- `cli/config`: languages/track parse-and-tolerate tests (garbage arrays, unknown strings, BOM configs).
- `bank`: `loadBankDetailed` provenance + `pack.json` exclusion + duplicate-track detection.
- `engine/select`: allowlist offerability (composes with toolchains; `"any"` passes; explicit `language` bypasses), `hiddenByLanguages` counts, `availableAxes` narrowing.
- `cli`: setup flag matrix (set/clear/show), `--track` end-to-end against a temp pack dir (`ATROPHY_DB` throwaway + `ATROPHY_NO_SYNC=1` as always), baseline axis-sweep narrowing, the printed not-silent line.
- Existing suites must stay green untouched: no default-path behavior changes when config carries neither field.

## Global constraints (binding, from the repo's standing rules)

- Windows-safe throughout; ESM `.js` imports; strict TS with `noUncheckedIndexedAccess`.
- Never touch the real `~/.atrophy` in tests: `ATROPHY_CONFIG`, `ATROPHY_DB` to scratch paths, `ATROPHY_NO_SYNC=1` for anything that records.
- `--ai-on` never touches the unaided rating; toolchain/config narrowing is never silent; network failures never interrupt a drill.
- New commits on `feat/setup-languages-tracks` only — the shipped PR branch stays frozen.

## Risks / open questions (resolved here)

- **Ambiguous track names**: warn in doctor, error only on use — matches the pack-collision philosophy (`atrophy doctor` sees merged reality).
- **Allowlist empties an axis**: `availableAxes` shrinks; `baseline` reports skipped axes by name; `drill` on an emptied axis gets the friendly error + the hidden-count line. No silent fallback to disallowed languages.
- **`--lang` outside the allowlist**: served, with a one-line note. Explicit steering wins is an invariant, not a bug.
