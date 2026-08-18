#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pc from "picocolors";
import { allGenerators } from "../bank/generators/index.js";
import type { ExerciseGenerator } from "../bank/generators/types.js";
import { AXES, LANGUAGES, loadBank, loadBankDetailed, type Axis, type Exercise, type Language } from "../bank/schema.js";
import { buildPayload, startServer } from "./serve.js";
import { autoSync, isRegistered, maybePrintPublishHint, publishCommand } from "./publish.js";
import { configLanguages, configPath, configTrack, packDirs } from "./config.js";
import { findTrack, resolveTracks, type Track } from "./tracks.js";
import { detectAssistants } from "../engine/guard.js";
import { javacCommand, missingJdkHint } from "../engine/javatool.js";
import {
  availableAxes,
  hiddenByLanguages,
  hiddenByToolchain,
  resolveExercise,
  selectExercise,
  type SelectOptions,
} from "../engine/select.js";
import { previewExercise, runDrill } from "../engine/session.js";
import { computeStreak } from "../engine/streak.js";
import { detectRegression, detectRegressions, type Regression } from "../engine/regression.js";
import {
  freshness,
  nextTier,
  updateRating,
  type Freshness,
  type RatingState,
} from "../engine/scoring.js";
import { Store, defaultDbPath } from "../store/db.js";
import { hiddenJavaNotice, runDoctor } from "./doctor.js";
import { reportCommand } from "./report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The built-in bank and the configured packs, kept apart: a track names exactly one
 * of these roots, so anything resolving tracks needs the split rather than the
 * flattened list `loadBank` wants.
 */
export function bankRoots(): { base: string; packs: string[] } {
  const base = (() => {
    if (process.env.ATROPHY_BANK) return process.env.ATROPHY_BANK;
    const candidates = [
      join(__dirname, "..", "bank", "exercises"), // tsx dev: cli/../bank
      join(__dirname, "..", "..", "bank", "exercises"), // built: dist/cli/../../bank
    ];
    const found = candidates.find((c) => existsSync(c));
    if (!found) throw new Error("exercise bank not found - set ATROPHY_BANK");
    return found;
  })();
  // a pack pointing at the built-in bank is already covered by base; loadBank
  // tolerates the overlap, but pack counts read cleaner without it
  const packs = packDirs().filter((p) => resolve(p) !== resolve(base));
  for (const p of packs) {
    if (!existsSync(p)) {
      throw new Error(`pack directory not found: ${p} (check ATROPHY_PACKS / "packs" in ${configPath()})`);
    }
  }
  return { base, packs };
}

/** The built-in bank first, then any configured packs merged on top of it. */
function bankDirs(): string[] {
  const { base, packs } = bankRoots();
  return [base, ...packs];
}

interface DrillFlags {
  axis?: string;
  lang?: string;
  solution?: string;
  aiOn?: boolean;
  exercise?: string;
  tier?: string;
  show?: boolean;
  track?: string;
}

function parseAxis(value: string): Axis {
  if (!(AXES as readonly string[]).includes(value)) {
    console.error(pc.red(`unknown axis "${value}" - one of: ${AXES.join(", ")}`));
    process.exit(1);
  }
  return value as Axis;
}

function parseLang(value: string): Language {
  if (!(LANGUAGES as readonly string[]).includes(value)) {
    console.error(pc.red(`unknown language "${value}" - one of: ${LANGUAGES.join(", ")}`));
    process.exit(1);
  }
  return value as Language;
}

/**
 * What one drill may draw from, after the two config preferences apply. Both are
 * defaults, not locks: an explicit `--lang` disables the allowlist and `--track all`
 * disables track focus, exactly as `--lang` already disables the mix soft-cap.
 */
interface DrillPool {
  /** Statics after track focus. */
  bank: Exercise[];
  /** Every static across base + packs; baseline reports what the narrowing cost. */
  unfiltered: Exercise[];
  /** Empty under a pack track: packs ship JSON, and the built-in families are base content. */
  generators: ExerciseGenerator[];
  track?: Track;
  /** Allowlist handed to selection: absent when `--lang` steers or config lists nothing. */
  allowed?: Language[];
  /** The configured allowlist as written, for the `--lang` note (which outlives `allowed`). */
  configured: Language[];
}

/** Track focus for this run: the flag, else config; "all" is the reserved escape hatch. */
function focusedTrack(flags: DrillFlags, base: string, packs: string[]): Track | undefined {
  const requested = flags.track?.trim().toLowerCase();
  // `??`, not `||`: an explicit but empty --track is a name that matches nothing, and
  // falling back to the configured track there would silently serve something else.
  const wanted = requested === "all" ? undefined : (requested ?? configTrack());
  if (wanted === undefined) return undefined;
  const tracks = resolveTracks(base, packs);
  const track = findTrack(tracks, wanted); // an ambiguous name throws from here
  if (!track) {
    throw new Error(
      `unknown track "${wanted}" - discovered: ${tracks.map((t) => t.name).join(", ")}` +
        ` (check --track / "track" in ${configPath()})`,
    );
  }
  return track;
}

function resolvePool(flags: DrillFlags): DrillPool {
  const { base, packs } = bankRoots();
  const track = focusedTrack(flags, base, packs);
  // one walk for both views: `root` is the dirs[] member each exercise was found under
  const entries = loadBankDetailed([base, ...packs]);
  const unfiltered = entries.map((e) => e.exercise);
  const bank = track ? entries.filter((e) => e.root === track.dir).map((e) => e.exercise) : unfiltered;
  const configured = configLanguages();
  return {
    bank,
    unfiltered,
    generators: !track || track.isBase ? allGenerators : [],
    track,
    allowed: flags.lang || configured.length === 0 ? undefined : configured,
    configured,
  };
}

/** Narrowing is never silent: whatever shrank the pool says so before the drill starts. */
function announcePool(pool: DrillPool, language: Language | undefined): void {
  if (pool.track) console.log(pc.dim(`track: ${pool.track.name} (${pool.bank.length} drills)`));
  if (language && pool.configured.length > 0 && !pool.configured.includes(language)) {
    // stderr, like the neighbouring missing-JDK warning: piped stdout stays drill content
    console.error(
      pc.yellow(
        `note: --lang ${language} is outside your configured languages (${pool.configured.join(", ")})` +
          " - serving it anyway",
      ),
    );
  }
}

/**
 * The axis most in need of a rep: never-tested first, then stalest. Scoped to
 * `language` when one was asked for, so `--lang java` picks the stalest axis
 * that actually has Java content instead of one that cannot be drilled.
 */
function dueAxis(store: Store, pool: DrillPool, language?: Language): Axis {
  const available = availableAxes(pool.bank, language, pool.generators, undefined, pool.allowed);
  let best: Axis = available[0] ?? "syntax-recall";
  let bestTime = Infinity;
  for (const a of available) {
    const r = store.getRating(a);
    const t = r.updatedAt ? Date.parse(r.updatedAt) : -1;
    if (t < bestTime) {
      bestTime = t;
      best = a;
    }
  }
  return best;
}

export async function drillOnce(
  store: Store,
  flags: DrillFlags,
  opts: { languageMix?: boolean } = {},
): Promise<boolean> {
  const language = flags.lang ? parseLang(flags.lang) : undefined;
  const mode = flags.aiOn ? "ai-on" : "ai-off";

  let ex: Exercise | undefined;
  if (flags.exercise) {
    // Replay a specific exercise: an explicit id is not a request for a pool, so
    // neither track focus nor the language allowlist applies to it.
    const bank = loadBank(bankDirs());
    // Tier is not in the id, so take it from --tier, else from this exercise's
    // own history, else the family's first tier.
    let tierHint: number | undefined;
    if (flags.tier !== undefined) {
      const t = Number.parseInt(flags.tier, 10);
      if (!Number.isInteger(t) || t < 1 || t > 3) {
        console.error(pc.red("--tier must be 1, 2 or 3"));
        return false;
      }
      tierHint = t;
    } else {
      tierHint = store.tierForExercise(flags.exercise) ?? undefined;
    }
    ex = resolveExercise(flags.exercise, { statics: bank, generators: allGenerators, tier: tierHint });
    if (!ex) {
      console.error(
        pc.red(`unknown exercise "${flags.exercise}"`) +
          pc.dim(" - use a bank id (e.g. sr-py-001) or a generated family-seed id"),
      );
      return false;
    }
  } else {
    const pool = resolvePool(flags);
    // after parseAxis: a rejected --axis exits, and narrowing notes about a drill that
    // never happens are noise in front of the error
    const axis = flags.axis ? parseAxis(flags.axis) : dueAxis(store, pool, language);
    announcePool(pool, language);
    const recent = store.recentSessions(axis, 6).map((s) => s.exercise_id);
    const pick: SelectOptions = {
      statics: pool.bank,
      generators: pool.generators,
      axis,
      rating: store.getRating(axis).rating,
      recentIds: recent,
      language,
      allowedLanguages: pool.allowed,
    };
    // Language mix soft-cap (spec E1): only when the user is not steering with
    // --lang. Baseline opts out too - it forces per-axis coverage, and its own
    // first drills would otherwise skew the languages of its later ones.
    if (opts.languageMix !== false && language === undefined) {
      pick.recentLanguages = store.recentSessionLanguages(6);
    }
    // The allowlist is the user's own choice, so it shrinks the pool quietly - but
    // never silently: say how much of this axis it costs before the drill starts.
    if (pool.allowed) {
      const hiddenLang = hiddenByLanguages(pick, pool.allowed);
      if (hiddenLang > 0) {
        console.log(
          pc.dim(
            `config limits languages to ${pool.allowed.join(", ")}` +
              ` - ${hiddenLang} drills hidden on this axis (atrophy setup to change)`,
          ),
        );
      }
    }
    // Selection hides java drills a JVM would have to grade when there is no JDK. For
    // the user who asked for java that must never be silent: it shrinks the pool they
    // are measured on, and when it empties the pool entirely "no exercises in the bank"
    // would be a flat lie. (`hiddenJavaNotice` owns who hears which of the two.)
    const hidden = hiddenByToolchain(pick);
    ex = selectExercise(pick);
    if (!ex) {
      if (hidden > 0) {
        console.error(
          pc.yellow(missingJdkHint(javacCommand())) +
            pc.dim(`\n  (${hidden} java drill(s) for "${axis}" need it - run \`atrophy doctor\` for the full check)`),
        );
        return false;
      }
      console.error(pc.red(`no exercises in the bank for axis "${axis}"${flags.lang ? ` (${flags.lang})` : ""} yet`));
      return false;
    }
    const notice = hiddenJavaNotice(hidden, axis, language);
    if (notice) console.log(pc.yellow(notice));
  }

  // Preview only: print the exercise and stop, nothing recorded.
  if (flags.show) {
    previewExercise(ex);
    return true;
  }

  const axis = ex.axis;
  const current = store.getRating(axis);

  if (mode === "ai-off" && !flags.solution) {
    const running = await detectAssistants();
    if (running.length > 0) {
      console.log(
        pc.yellow(`\nHeads up: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running.`) +
          pc.dim(" AI off is the deal - close them, or own the asterisk on your number. (Warned, never blocked.)"),
      );
    }
  }

  const outcome = await runDrill(ex, flags.solution);
  if (outcome.abandoned) {
    console.log(pc.dim("\nAbandoned - nothing recorded. The rep only counts if you take it."));
    return true;
  }

  // AI-on sessions are recorded for the divergence chart but never touch the
  // unaided rating (PLAN §3.1 - the killer chart is the gap).
  let after: RatingState = current;
  if (mode === "ai-off") {
    after = updateRating(current, ex.tier, outcome.score);
    const lastScores = [outcome.score, ...store.recentSessions(axis, 1).map((s) => s.score)];
    const tier = nextTier(current.tier, lastScores);
    store.saveRating(axis, after, tier);
    if (tier > current.tier) console.log(pc.magenta(`\n▲ promoted to tier ${tier}`));
    if (tier < current.tier) console.log(pc.dim(`\n▼ dropped back to tier ${tier}`));
  }

  store.recordSession({
    ts: new Date().toISOString(),
    exercise_id: ex.id,
    axis,
    language: ex.language,
    tier: ex.tier,
    mode,
    passed: outcome.passed,
    total: outcome.total,
    elapsed_seconds: outcome.elapsedSeconds,
    score: outcome.score,
    rating_before: current.rating,
    rating_after: after.rating,
  });

  const delta = after.rating - current.rating;
  const deltaStr = delta >= 0 ? pc.green(`+${delta.toFixed(0)}`) : pc.red(delta.toFixed(0));
  console.log(
    `\nScore ${pc.bold(outcome.score.toFixed(2))}` +
      ` · ${axis} rating ${current.rating.toFixed(0)} → ${pc.bold(after.rating.toFixed(0))} (${deltaStr})` +
      (mode === "ai-on" ? pc.dim("  [ai-on: recorded, rating untouched]") : ""),
  );

  // Proactive decline signal: did this axis just fall well below its recent peak?
  if (mode === "ai-off") {
    const reg = detectRegression(store.allSessions(), axis);
    if (reg) console.log(pc.red(`\n▼ ${formatRegression(reg)}`));
  }

  // registered users sync to the leaderboard automatically after every rep
  if (mode === "ai-off") {
    if (isRegistered()) await autoSync(store);
    else maybePrintPublishHint(store);
  }
  return true;
}

/** One honest line describing a decline, shared by the drill summary and stats. */
function formatRegression(reg: Regression): string {
  const days = Math.max(1, Math.round((Date.parse(reg.toTs) - Date.parse(reg.fromTs)) / 86_400_000));
  return (
    `${reg.axis} is down ${reg.drop.toFixed(0)} pts from its recent peak ` +
    `(${reg.fromRating.toFixed(0)} → ${reg.toRating.toFixed(0)}, over ~${days}d). ` +
    `A couple of unaided reps turns it around.`
  );
}

const FRESHNESS_BADGE: Record<Freshness, string> = {
  fresh: pc.green("● fresh"),
  aging: pc.yellow("◐ aging"),
  cracking: pc.magenta("◍ cracking"),
  stale: pc.red("○ stale"),
};

function daysAgo(iso: string | null): string {
  if (!iso) return "never";
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  return `${Math.floor(days)}d ago`;
}

function stats(store: Store): void {
  const rows = AXES.map((axis) => ({ axis, ...store.getRating(axis) }));
  const anyReps = rows.some((r) => r.reps > 0);
  console.log(pc.bold("\n  Atrophy - unaided skill baseline\n"));
  const header = ["axis".padEnd(16), "rating".padStart(7), "±RD".padStart(5), "reps".padStart(5), "tier".padStart(5), "last rep".padStart(10), "  state"];
  console.log(pc.dim("  " + header.join("  ")));
  for (const r of rows) {
    const untested = r.reps === 0;
    // Wide RD in the first few reps means "still calibrating", not "decayed".
    const state = untested
      ? pc.dim("untested")
      : r.reps < 5 && freshness(r.rd) !== "fresh"
        ? pc.cyan("◌ calibrating")
        : FRESHNESS_BADGE[freshness(r.rd)];
    const line = [
      r.axis.padEnd(16),
      (untested ? "-" : r.rating.toFixed(0)).padStart(7),
      (untested ? "-" : r.rd.toFixed(0)).padStart(5),
      String(r.reps).padStart(5),
      String(r.tier).padStart(5),
      daysAgo(r.updatedAt).padStart(10),
      "  " + state,
    ].join("  ");
    console.log("  " + (untested ? pc.dim(line) : line));
  }
  if (!anyReps) {
    console.log(pc.dim("\n  No reps yet. Run ") + pc.cyan("atrophy baseline") + pc.dim(" to set your unaided baseline."));
  } else {
    const streak = computeStreak(store.allSessions());
    const streakText = `streak ${streak.weeks} week${streak.weeks === 1 ? "" : "s"} · this week ${streak.thisWeekReps}/${streak.target} reps`;
    console.log("\n  " + (streak.thisWeekReps >= streak.target ? pc.green(streakText) : pc.yellow(streakText)));
    console.log(pc.dim("  RD widens while you coast - that's confidence decaying, not the score."));
    const last = store.lastDrillTs();
    const idleDays = last ? (Date.now() - Date.parse(last)) / 86_400_000 : Infinity;
    if (idleDays > 3) {
      console.log(
        pc.yellow(`  ⚠ ${Math.floor(idleDays)} days since your last unaided rep.`) +
          pc.dim(" 2-3x/week keeps the baseline honest - run ") + pc.cyan("atrophy drill") + pc.dim("."),
      );
    }
    for (const reg of detectRegressions(store.allSessions())) {
      console.log(pc.red(`  ▼ ${formatRegression(reg)}`));
    }
  }
  console.log();
}

/** Timestamped backup path next to the database (filename-safe on Windows). */
function defaultBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dirname(defaultDbPath()), "backups", `atrophy-${stamp}.db`);
}

function dashboardHtmlPath(): string {
  const candidates = [
    join(__dirname, "..", "dashboard", "index.html"), // tsx dev: cli/../dashboard
    join(__dirname, "..", "..", "dashboard", "index.html"), // built: dist/cli/../../dashboard
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("dashboard/index.html not found");
  return found;
}

function exportJson(store: Store, out?: string): void {
  const json = JSON.stringify(buildPayload(store), null, 2);
  if (out) {
    writeFileSync(out, json, "utf8");
    console.log(`wrote ${out}`);
  } else {
    console.log(json);
  }
}

export async function baseline(store: Store, flags: DrillFlags): Promise<void> {
  const pool = resolvePool(flags);
  const language = flags.lang ? parseLang(flags.lang) : undefined;
  const axesWithExercises = availableAxes(pool.bank, language, pool.generators, undefined, pool.allowed);
  // Both sides run on this host's real toolchains, so an axis a missing JDK hid is
  // never blamed on the config (that one has its own notice inside the drill).
  const skipped = availableAxes(pool.unfiltered, language, allGenerators).filter(
    (a) => !axesWithExercises.includes(a),
  );
  console.log(
    pc.bold("Baseline session") +
      ` - one unaided drill per axis (${axesWithExercises.length} available today).`,
  );
  for (const axis of skipped) {
    console.log(
      pc.dim(
        `skipping ${axis}: no drills match your config` +
          ` (languages: ${pool.allowed ? pool.allowed.join(", ") : "all"}; track: ${pool.track?.name ?? "all"})`,
      ),
    );
  }
  for (const axis of axesWithExercises) {
    const ok = await drillOnce(store, { ...flags, axis }, { languageMix: false });
    if (!ok) break;
  }
  stats(store);
}

function cliVersion(): string {
  // package.json sits one level up in dev (cli/) and two up when built (dist/cli/)
  for (const p of [join(__dirname, "..", "package.json"), join(__dirname, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "atrophy" && pkg.version) return pkg.version;
    } catch {
      /* try next candidate */
    }
  }
  return "unknown";
}

// --- command actions -------------------------------------------------------
// One exported function per command, so tests can drive a command's real body
// without spawning a process (spec E2).

export async function drillAction(flags: DrillFlags): Promise<void> {
  const store = new Store();
  try {
    const ok = await drillOnce(store, flags);
    if (!ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function baselineAction(flags: DrillFlags): Promise<void> {
  const store = new Store();
  try {
    await baseline(store, flags);
  } finally {
    store.close();
  }
}

export function statsAction(): void {
  const store = new Store();
  try {
    stats(store);
  } finally {
    store.close();
  }
}

export async function serveAction(flags: { port: string }): Promise<void> {
  const store = new Store();
  const port = Number.parseInt(flags.port, 10);
  await startServer(store, dashboardHtmlPath(), port);
  console.log(pc.bold("\n  Atrophy dashboard: ") + pc.cyan(`http://127.0.0.1:${port}`));
  console.log(pc.dim("  Ctrl+C to stop. Data refreshes from SQLite on every reload.\n"));
}

export async function publishAction(flags: { handle?: string; url?: string; stop?: boolean }): Promise<void> {
  const store = new Store();
  try {
    await publishCommand(store, flags);
  } finally {
    store.close();
  }
}

export function exportAction(flags: { out?: string }): void {
  const store = new Store();
  try {
    exportJson(store, flags.out);
  } finally {
    store.close();
  }
}

export async function doctorAction(): Promise<void> {
  // Everything the doctor reports on can itself be broken, including the
  // config it reads - resolve each input defensively so the report prints.
  let bankDir: string[] | null = null;
  let bankError: string | null = null;
  try {
    bankDir = bankDirs();
  } catch (err) {
    bankError = (err as Error).message;
  }
  let packs: string[] = [];
  try {
    packs = packDirs();
  } catch {
    /* whatever broke here already surfaced as bankError */
  }
  process.exitCode = await runDoctor({ bankDir, bankError, packDirs: packs, dbPath: defaultDbPath() });
}

export async function backupAction(flags: { out?: string }): Promise<void> {
  const store = new Store();
  try {
    const dest = flags.out ?? defaultBackupPath();
    mkdirSync(dirname(dest), { recursive: true });
    await store.backupTo(dest);
    console.log(pc.green(`backed up to ${dest}`));
  } catch (err) {
    console.error(pc.red(`backup failed: ${(err as Error).message}`));
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function resetAction(flags: { yes?: boolean }): Promise<void> {
  const store = new Store();
  try {
    if (!flags.yes) {
      console.log(
        pc.yellow("This erases every rating and session.") +
          pc.dim(" A backup is saved first. Re-run with ") +
          pc.cyan("--yes") +
          pc.dim(" to proceed."),
      );
      return;
    }
    const dest = defaultBackupPath();
    mkdirSync(dirname(dest), { recursive: true });
    await store.backupTo(dest);
    store.clear();
    console.log(pc.green("all drill data erased.") + pc.dim(` backup saved to ${dest}`));
  } catch (err) {
    console.error(pc.red(`reset failed: ${(err as Error).message}`));
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

export function reportAction(flags: { out?: string }): void {
  const store = new Store();
  try {
    reportCommand(store, flags);
  } finally {
    store.close();
  }
}

// --- entry point -----------------------------------------------------------

/** The whole command surface. Building it is free of side effects; parsing is not. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("atrophy")
    .description("Measure what your brain is losing while AI does your work.")
    .version(cliVersion());

  program
    .command("drill")
    .description("run one unaided micro-drill (5-10 min)")
    .option("-a, --axis <axis>", `skill axis: ${AXES.join(", ")}`)
    .option("-l, --lang <language>", `one of: ${LANGUAGES.join(", ")}`)
    .option("--ai-on", "monthly comparison rep WITH your AI tools (plots the gap, never touches your unaided rating)")
    .option("--solution <file>", "non-interactive: grade this file as the submission (scripting/tests)")
    .option("--exercise <id>", "replay a specific exercise (bank id or generated family-seed id)")
    .option("--tier <n>", "tier 1-3 for a generated --exercise not in your history")
    .option("--show", "print the exercise without grading (preview)")
    .option("--track <name>", "pack track name; 'all' disables a configured track for this run")
    .action(drillAction);

  program
    .command("baseline")
    .description("initial ~25 min session: one drill per axis, AI off")
    .option("-l, --lang <language>", `one of: ${LANGUAGES.join(", ")}`)
    .option("--track <name>", "pack track name; 'all' disables a configured track for this run")
    .action(baselineAction);

  program
    .command("stats")
    .description("per-axis ratings, confidence decay, and recency")
    .action(statsAction);

  program
    .command("serve")
    .description("serve the decay dashboard locally (reads live data on refresh)")
    .option("-p, --port <port>", "port on 127.0.0.1", "4646")
    .action(serveAction);

  program
    .command("publish")
    .description("opt in to the public leaderboard; afterwards every drill auto-syncs")
    .option("--handle <name>", "public handle (3-20 chars; saved after first publish)")
    .option("--url <url>", "leaderboard API override")
    .option("--stop", "stop auto-syncing (your entry stays until you ask for deletion)")
    .action(publishAction);

  program
    .command("export")
    .description("dump ratings + sessions as JSON (feeds the dashboard)")
    .option("-o, --out <file>", "write to file instead of stdout")
    .action(exportAction);

  program
    .command("doctor")
    .description("diagnose your setup: runtime, editor, sandbox, exercise bank, database")
    .action(doctorAction);

  program
    .command("backup")
    .description("copy your SQLite database to a backup file you own")
    .option("-o, --out <file>", "destination path (default: ~/.atrophy/backups/)")
    .action(backupAction);

  program
    .command("reset")
    .description("erase all your drill data (a backup is written first)")
    .option("--yes", "confirm the erase (nothing happens without this)")
    .action(resetAction);

  program
    .command("report")
    .description("a shareable summary of your baseline (Markdown, or an SVG card with --out *.svg)")
    .option("-o, --out <file>", "write to a file (.svg renders a card, otherwise Markdown)")
    .action(reportAction);

  return program;
}

/** Parse argv and run the matching command (defaults to `process.argv`). */
export async function runCli(argv?: readonly string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

/**
 * True only when this module is what node was told to run - `atrophy …`,
 * `node dist/cli/index.js …` or `tsx cli/index.ts …`. Importing the module
 * (tests, other tooling) must never parse argv. Both sides become a `file://`
 * URL so Windows separators cannot differ; `argv[1]` is compared resolved
 * (node reports the realpath of a symlinked bin - npm's shim, a linked
 * checkout - as `import.meta.url`) and raw (under `--preserve-symlinks-main`
 * it reports the link itself). Failing this check means the CLI does nothing
 * at all, so it errs toward matching.
 */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    if (import.meta.url === pathToFileURL(entry).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false; // entry gone or unreadable: treat as "not us"
  }
}

if (isProcessEntry()) {
  runCli().catch((err) => {
    console.error(pc.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  });
}
