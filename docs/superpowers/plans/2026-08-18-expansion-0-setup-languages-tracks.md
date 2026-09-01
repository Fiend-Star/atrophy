# Expansion-0: setup / language allowlist / track selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent user preferences — a language allowlist and a track (pack) focus — chosen via a new `atrophy setup` command and respected by `drill`/`baseline`/`doctor`, always overridable per run.

**Architecture:** Config (`cli/config.ts`) gains two tolerant fields; `bank/schema.ts` gains a provenance-preserving loader; `engine/select.ts` gains an `allowedLanguages` filter mirroring the toolchain-gating pattern; the CLI threads both preferences and prints narrowing (never silent). Tracks are pack directories identified by `pack.json` name or dir basename.

**Tech Stack:** TypeScript strict + `noUncheckedIndexedAccess`, ESM/NodeNext (`.js` import suffixes), zod, commander, vitest (colocated `*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-18-expansion-0-setup-languages-tracks-design.md`

## Global Constraints

- Windows-safe paths and spawning; CI runs ubuntu + windows, Node 22 + 24.
- ESM: relative imports use `.js` extensions even inside `.ts` files.
- Tests never touch the real `~/.atrophy`: set `ATROPHY_CONFIG` to a scratch file, `ATROPHY_DB` to a scratch db, `ATROPHY_NO_SYNC=1` for anything that records sessions.
- Data flows one direction: bank → engine → store → cli. cli may import bank/engine; bank imports neither.
- A narrowed selection pool is never silent (existing product rule for toolchains; extends to config narrowing).
- Explicit user steering wins: `--lang` bypasses the allowlist; `--exercise <id>` bypasses allowlist AND track.
- No behavior change when config carries neither new field — the whole existing suite must stay green untouched.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Config fields `languages` + `track`

**Files:**
- Modify: `cli/config.ts`
- Test: `cli/config.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `LANGUAGES`, `Language` from `../bank/schema.js`.
- Produces (later tasks rely on these exact names):
  - `AtrophyConfig` gains `languages?: Language[]` and `track?: string`
  - `configLanguages(env?: NodeJS.ProcessEnv): Language[]` — validated allowlist, `[]` when absent/invalid
  - `configTrack(env?: NodeJS.ProcessEnv): string | undefined` — trimmed lowercase, `undefined` when absent/blank

- [ ] **Step 1: Write the failing tests** (append to `cli/config.test.ts`, following its existing scratch-`ATROPHY_CONFIG` technique):

```ts
describe("configLanguages / configTrack", () => {
  it("returns only valid Language members, dropping garbage", () => {
    writeCfg({ languages: ["java", "cobol", 42, "sql"] }); // writeCfg = existing helper or write JSON to the scratch ATROPHY_CONFIG path
    expect(configLanguages(env)).toEqual(["java", "sql"]);
  });
  it("returns [] for absent, non-array, or empty", () => {
    writeCfg({});
    expect(configLanguages(env)).toEqual([]);
    writeCfg({ languages: "java" });
    expect(configLanguages(env)).toEqual([]);
  });
  it("track is trimmed and lowercased; blank means undefined", () => {
    writeCfg({ track: "  Aurora " });
    expect(configTrack(env)).toBe("aurora");
    writeCfg({ track: "   " });
    expect(configTrack(env)).toBeUndefined();
    writeCfg({});
    expect(configTrack(env)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run cli/config.test.ts` → FAIL (`configLanguages` not exported).
- [ ] **Step 3: Implement** in `cli/config.ts`:

```ts
import { LANGUAGES, type Language } from "../bank/schema.js";

export interface AtrophyConfig {
  leaderboard?: { token?: string; handle?: string; url?: string };
  /** Extra exercise-bank directories merged on top of the built-in bank. */
  packs?: string[];
  /** Serve only these languages (plus "any"-tagged drills). Absent/empty = all. */
  languages?: Language[];
  /** Serve only the pack with this track name. Absent = all content. */
  track?: string;
}

/** Validated language allowlist from config; unknown entries are dropped, never fatal. */
export function configLanguages(env: NodeJS.ProcessEnv = process.env): Language[] {
  const raw: unknown = readConfig(env).languages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is Language => typeof l === "string" && (LANGUAGES as readonly string[]).includes(l));
}

/** Configured track name, normalized the way track matching normalizes. */
export function configTrack(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw: unknown = readConfig(env).track;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  return t || undefined;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run cli/config.test.ts` → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add cli/config.ts cli/config.test.ts && git commit -m "feat(config): languages allowlist and track fields ..."`

---

### Task 2: Pack identity — `pack.json`, track names, track resolution

**Files:**
- Create: `cli/tracks.ts`, `cli/tracks.test.ts`
- Modify: `bank/schema.ts` (exclude `pack.json` from the exercise walk)
- Test: extend `bank/schema.test.ts` (or the file holding loadBank tests) for the exclusion

**Interfaces:**
- Consumes: nothing from earlier tasks (config wiring happens in Task 5).
- Produces:
  - `interface Track { name: string; dir: string; isBase: boolean }`
  - `resolveTracks(baseDir: string, packs: string[]): Track[]` — base first (`{name: "base", isBase: true}`), then one Track per pack dir
  - `trackName(packDir: string): string` — `pack.json` name if valid, else lowercased basename
  - `ambiguousTracks(tracks: Track[]): string[]` — names claimed by >1 track
  - `findTrack(tracks: Track[], name: string): Track | undefined` — case-insensitive; **throws** a friendly Error when the name is ambiguous
  - In `bank/schema.ts`: the exercise walk skips files whose lowercased basename is `pack.json`

- [ ] **Step 1: Write failing tests** (`cli/tracks.test.ts`, temp dirs via `mkdtempSync(join(tmpdir(), "atrophy-tracks-"))`):

```ts
it("pack.json name wins; basename (lowercased) is the fallback", () => {
  const withMeta = mkTemp("MyPack");           // helper: make dir, optionally write pack.json
  writeFileSync(join(withMeta, "pack.json"), JSON.stringify({ name: "aurora", description: "x" }));
  const bare = mkTemp("Atrophy-Pack-HRT");
  expect(trackName(withMeta)).toBe("aurora");
  expect(trackName(bare)).toBe("atrophy-pack-hrt");
});
it("invalid pack.json (bad slug, reserved name, malformed JSON) falls back to basename", () => {
  // three dirs: name "Bad Slug!", name "all", and a file containing "{not json"
  // each must yield the lowercased basename, never a throw
});
it("resolveTracks puts base first and flags it", () => {
  const t = resolveTracks("/bank", ["/p1"]);
  expect(t[0]).toEqual({ name: "base", dir: "/bank", isBase: true });
});
it("findTrack matches case-insensitively and throws on ambiguity", () => {
  const tracks = [
    { name: "base", dir: "/b", isBase: true },
    { name: "aurora", dir: "/p1", isBase: false },
    { name: "aurora", dir: "/p2", isBase: false },
  ];
  expect(ambiguousTracks(tracks)).toEqual(["aurora"]);
  expect(() => findTrack(tracks, "AURORA")).toThrow(/ambiguous/);
  expect(findTrack(tracks, "base")!.isBase).toBe(true);
});
```

And in the bank tests: a bank dir containing a `pack.json` (any content, even invalid JSON) loads its exercises without error and without an exercise for that file.

- [ ] **Step 2: Run to verify failure** — `npx vitest run cli/tracks.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `cli/tracks.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

/** Reserved words: "all" clears track focus; "base" is the built-in bank. */
const RESERVED = new Set(["all", "base"]);
const packMetaSchema = z
  .object({ name: z.string().regex(/^[a-z0-9-]{1,32}$/) })
  .passthrough()
  .refine((m) => !RESERVED.has(m.name), { message: "reserved track name" });

export interface Track {
  name: string;
  dir: string;
  isBase: boolean;
}

/** pack.json name if present and valid; else the dir basename, lowercased. Never throws. */
export function trackName(packDir: string): string {
  const metaPath = join(packDir, "pack.json");
  if (existsSync(metaPath)) {
    try {
      const parsed = packMetaSchema.safeParse(
        JSON.parse(readFileSync(metaPath, "utf8").replace(/^\uFEFF/, "")),
      );
      if (parsed.success) return parsed.data.name;
    } catch {
      /* malformed JSON: fall back to basename */
    }
  }
  return basename(packDir).toLowerCase();
}

/** Base dir first, then one track per pack dir, in pack order. */
export function resolveTracks(baseDir: string, packs: string[]): Track[] {
  return [
    { name: "base", dir: baseDir, isBase: true },
    ...packs.map((dir) => ({ name: trackName(dir), dir, isBase: false })),
  ];
}

/** Names claimed by more than one track (doctor warns; findTrack throws on use). */
export function ambiguousTracks(tracks: Track[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tracks) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/** Case-insensitive lookup. Ambiguous names are a hard error only on use. */
export function findTrack(tracks: Track[], name: string): Track | undefined {
  const n = name.trim().toLowerCase();
  const matches = tracks.filter((t) => t.name === n);
  if (matches.length > 1) {
    throw new Error(`track "${n}" is ambiguous: ${matches.map((m) => m.dir).join(", ")} - rename one via pack.json`);
  }
  return matches[0];
}
```

In `bank/schema.ts`'s walk (both here and after Task 3's refactor), change the file predicate to:

```ts
else if (entry.isFile() && entry.name.endsWith(".json") && entry.name.toLowerCase() !== "pack.json") {
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run cli/tracks.test.ts bank/` → PASS; typecheck clean.
- [ ] **Step 5: Commit.**

---

### Task 3: Bank provenance — `loadBankDetailed`

**Files:**
- Modify: `bank/schema.ts`
- Test: extend the loadBank tests

**Interfaces:**
- Produces:
  - `export interface BankEntry { exercise: Exercise; root: string }` — `root` is the `dirs[]` member whose walk found the file
  - `export function loadBankDetailed(dirs: string | string[]): BankEntry[]`
  - `loadBank` keeps its exact signature/behavior and delegates: `loadBankDetailed(dirs).map((e) => e.exercise)`

- [ ] **Step 1: Failing test** — two temp dirs each holding one valid exercise JSON (copy a minimal `recall` fixture from existing tests); `loadBankDetailed([a, b])` returns both entries with `root` === the dir each came from; overlapping roots (`[a, a]`) yield one entry attributed to the first; cross-dir duplicate ids still throw `BankError`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — refactor the existing walk into `loadBankDetailed` (walk carries a `root` parameter; the dedupe `seen` map and duplicate-id error are unchanged), and reduce `loadBank` to the delegation one-liner. Keep the Task 2 `pack.json` exclusion in the single walk.
- [ ] **Step 4: Run the full bank suite** — `npx vitest run bank/` → PASS (integrity suite included; it exercises loadBank heavily).
- [ ] **Step 5: Commit.**

---

### Task 4: Selection — `allowedLanguages` + `hiddenByLanguages`

**Files:**
- Modify: `engine/select.ts`
- Test: `engine/select.test.ts` (extend)

**Interfaces:**
- Consumes: `Language` from the bank schema (already imported there).
- Produces:
  - `SelectOptions` gains `allowedLanguages?: Language[]` — ignored when `language` is set; when set and non-empty, a candidate is offerable only if `c.language === "any"` or the list includes it
  - `availableAxes(bank, language?, generators?, toolchains?, allowedLanguages?)` — new optional 5th positional
  - `export function hiddenByLanguages(opts: Pick<SelectOptions, "statics" | "generators" | "axis" | "toolchains">, allowed: Language[]): number` — candidates offerable without the allowlist but not with it (toolchain gating applied in both arms, mirroring `hiddenByToolchain`'s shape)

- [ ] **Step 1: Failing tests:**

```ts
it("allowlist filters candidates but 'any' always passes", () => {
  // statics: one java, one python, one "any" recall, same axis
  // selectExercise with allowedLanguages: ["java"] over many draws never returns the python one
});
it("explicit language bypasses the allowlist", () => {
  // allowedLanguages: ["java"], language: "python" → the python drill IS served
});
it("availableAxes narrows under the allowlist", () => { /* axis whose only drill is python vanishes under ["java"] */ });
it("hiddenByLanguages counts only allowlist-hidden, not toolchain-hidden", () => {
  // toolchains: { jdk: false } + a java write (jvm-hidden) + a python write:
  // hiddenByLanguages(..., ["java"]) === 1 (the python one; the java write was already un-offerable)
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — add the 4th param to the private `offerable(c, language, toolchains, allowed?)`:

```ts
if (
  language === undefined &&
  allowed !== undefined &&
  allowed.length > 0 &&
  c.language !== "any" &&
  !allowed.includes(c.language)
) {
  return false;
}
```

Thread `opts.allowedLanguages` through `selectExercise`'s `offer` closure and `availableAxes`; implement `hiddenByLanguages` by the two-arm pattern of `hiddenByToolchain` (both arms use the real `toolchains`, arms differ only in the allowlist).

- [ ] **Step 4: Run** — `npx vitest run engine/select.test.ts` → PASS; full `engine/` suite green.
- [ ] **Step 5: Commit.**

---

### Task 5: CLI threading — track + allowlist through `drill` and `baseline`

**Files:**
- Modify: `cli/index.ts`
- Test: `cli/index.test.ts` (or wherever `drillOnce` unit tests live — Task 2 of Plan D exported and tested it; extend those)

**Interfaces:**
- Consumes: Tasks 1–4 (`configLanguages`, `configTrack`, `resolveTracks`, `findTrack`, `loadBankDetailed`, `allowedLanguages`, `hiddenByLanguages`).
- Produces:
  - `bankRoots(): { base: string; packs: string[] }` — refactor of `bankDirs()`; `bankDirs()` becomes `[base, ...packs]` and stays exported/used as-is
  - `DrillFlags` gains `track?: string`
  - `drill` and `baseline` commands gain `--track <name>` ("pack track name; 'all' disables a configured track for this run")
  - `drillOnce` resolution order, exact semantics:
    1. `track = flags.track === "all" ? undefined : (flags.track ?? configTrack())`
    2. resolve via `findTrack(resolveTracks(base, packs), track)` — unknown name: friendly error listing discovered track names; ambiguity error propagates
    3. bank = entries filtered to `root === track.dir`; generators = `[]` unless `track.isBase` or no track
    4. `allowedLanguages = flags.lang ? undefined : configLanguages()` (empty list ⇒ pass `undefined`)
    5. `--exercise <id>` replay path skips 1–4 entirely (explicit id wins)
- Printed lines (exact copy):
  - allowlist narrowing (when `hiddenByLanguages` > 0): `config limits languages to <a, b> - N drills hidden on this axis (atrophy setup to change)`
  - track focus (once per drill, when active): `track: <name> (M drills)`
  - `--lang` outside allowlist: `note: --lang <x> is outside your configured languages (<a, b>) - serving it anyway`
  - baseline axis skipped by narrowing: `skipping <axis>: no drills match your config (languages: <a, b>; track: <name>)`

- [ ] **Step 1: Failing tests** (drive `drillOnce` with `--show`-style non-recording paths and `--solution` for one recorded path; scratch `ATROPHY_CONFIG`/`ATROPHY_DB`/`ATROPHY_NO_SYNC=1`; a temp pack dir with one exercise + `pack.json` `{"name":"tpack"}`):
  - config `{languages:["python"]}` → a java-only axis draw picks nothing java; the hidden-count line is printed
  - config `{languages:["python"]}` + `--lang java` → java served + the note line
  - `--track tpack` → only the temp pack's exercise is served; generators absent; `track:` line printed
  - `--track all` with config `{track:"tpack"}` → full pool restored
  - unknown `--track nope` → error message contains `tpack` in the discovered list
  - no config → byte-identical behavior on the existing `drillOnce` tests (they must pass untouched)
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per the semantics above. `bankRoots()` keeps the existing dual-path/`ATROPHY_BANK` logic for `base` verbatim.
- [ ] **Step 4: Run** — `npx vitest run cli/` → PASS, plus `npm run typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 6: `atrophy setup` command

**Files:**
- Create: `cli/setup.ts`, `cli/setup.test.ts`
- Modify: `cli/index.ts` (register command + export the action for tests)

**Interfaces:**
- Consumes: `readConfig`/`writeConfig`/`configLanguages`/`configTrack`, `resolveTracks`/`findTrack`/`ambiguousTracks`, `bankRoots`, `loadBankDetailed`, `LANGUAGES`.
- Produces:
  - `export interface SetupFlags { languages?: string; allLanguages?: boolean; track?: string; show?: boolean }`
  - `export async function setupAction(flags: SetupFlags, io?: SetupIO): Promise<void>`
  - `export interface SetupIO { question(prompt: string): Promise<string>; close(): void }` — real impl wraps `node:readline/promises`; tests inject a scripted stub
  - Command registration:

```
atrophy setup [--languages <csv>] [--all-languages] [--track <name>] [--show]
```

Semantics: any flag ⇒ non-interactive (apply setters, then print the resulting state); `--languages` validates every entry against `LANGUAGES` (one bad entry ⇒ friendly error, nothing written); `--all-languages` deletes the field; `--track all` deletes the field; `--track <name>` validates against discovered tracks before writing; `--show` prints and never writes. No flags ⇒ interactive: numbered multi-select over `LANGUAGES` (comma-separated numbers, empty answer = all), then numbered track pick (`0 = all`, then `base` and each discovered track with its drill count), then write + print. Config writes always spread the existing config (`{ ...readConfig(), languages }`) so leaderboard/packs survive.

- [ ] **Step 1: Failing tests** — flag matrix (set languages, reject `java,cobol` without writing, clear, set/clear track, unknown track error lists discovered names, `--show` writes nothing), and one interactive script: answers `["1,3", "2"]` → config holds those picks (stub `SetupIO` returning queued answers).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, register in `buildProgram()`:

```ts
program
  .command("setup")
  .description("choose your languages and prep track (saved; every command respects it)")
  .option("--languages <csv>", `comma list of: ${LANGUAGES.join(", ")}`)
  .option("--all-languages", "serve all languages (clear the allowlist)")
  .option("--track <name>", "focus one pack ('all' to clear)")
  .option("--show", "print current setup and discovered tracks, change nothing")
  .action(setupAction);
```

- [ ] **Step 4: Run** — `npx vitest run cli/setup.test.ts` → PASS; full `cli/` green.
- [ ] **Step 5: Commit.**

---

### Task 7: `doctor` — config section

**Files:**
- Modify: `cli/doctor.ts`
- Test: `cli/doctor.test.ts` (extend, following its existing check-function test style)

**Interfaces:**
- Consumes: `configLanguages`/`configTrack` + raw `readConfig` (to detect dropped entries), `resolveTracks`/`ambiguousTracks`, `bankRoots`, `loadBankDetailed`.
- Produces: a `checkSetup` (name it in the file's existing check-naming style) that reports:
  - `languages: all` or `languages: java, sql`; **warn** (never fail) when raw config held entries that validation dropped, naming them
  - `track: all` or `track: aurora (M drills)`; **warn** when the configured track matches no discovered track (name the discovered ones) or is ambiguous
  - the track table: one line per discovered track — `<name>  <M> drills  <dir>`

- [ ] **Step 1: Failing tests** — three cases: clean config (info lines, no warn), config with `languages: ["java","cobol"]` (warn names `cobol`), config with `track: "nope"` (warn lists discovered).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** following the file's existing check pattern (same result shape `checkJava`/`checkSql` use; warn-never-fail like `checkSql`).
- [ ] **Step 4: Run** — doctor suite green.
- [ ] **Step 5: Commit.**

---

### Task 8: Docs + wrap

**Files:**
- Modify: `README.md`
- Verify: `cli/readme-claims.test.ts` untouched and green

**Steps:**

- [ ] **Step 1:** README section "Choose your languages / pick a track" under setup/usage: the three commands (`atrophy setup`, `atrophy setup --languages java,sql`, `atrophy drill --track aurora`), the two rules a user must know (explicit `--lang` wins over the allowlist; a track is a pack, named by `pack.json` or folder name), one line on never-silent narrowing. Do NOT touch the five-skills table or the `--lang` row (drift-guard fixtures pin them).
- [ ] **Step 2:** `npx vitest run cli/readme-claims.test.ts` → PASS untouched (if it fails, the edit strayed into pinned sections — fix the edit, not the fixture).
- [ ] **Step 3:** Full gate: `npm test` + `npm run typecheck` + `npm run build` all green.
- [ ] **Step 4: Commit.**
