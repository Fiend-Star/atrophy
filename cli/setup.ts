import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { LANGUAGES, loadBankDetailed, type Language } from "../bank/schema.js";
import { configPath, configLanguages, configTrack, readConfig, writeConfig } from "./config.js";
import { bankRoots } from "./index.js";
import { ambiguousTracks, findTrack, resolveTracks, type Track } from "./tracks.js";

export interface SetupFlags {
  languages?: string;
  allLanguages?: boolean;
  track?: string;
  show?: boolean;
}

/**
 * The prompt/close surface `setupAction` needs from a terminal. The real
 * implementation wraps `node:readline/promises` (see `defaultIo`); tests inject a
 * scripted stub so nothing here ever touches real stdin.
 */
export interface SetupIO {
  question(prompt: string): Promise<string>;
  close(): void;
}

function defaultIo(): SetupIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: (prompt) => rl.question(prompt),
    close: () => rl.close(),
  };
}

interface Discovered {
  tracks: Track[];
  /** Drill count per track, keyed by `Track.dir` (names may collide; dirs cannot). */
  counts: Map<string, number>;
}

/** Base + every configured pack, and how many drills `loadBankDetailed` found under each. */
function discoverTracks(): Discovered {
  const { base, packs } = bankRoots();
  const tracks = resolveTracks(base, packs);
  const entries = loadBankDetailed([base, ...packs]);
  const counts = new Map<string, number>(tracks.map((t) => [t.dir, 0]));
  for (const e of entries) counts.set(e.root, (counts.get(e.root) ?? 0) + 1);
  return { tracks, counts };
}

/** Current config plus the discovered track table. Never writes. */
function printState({ tracks, counts }: Discovered): void {
  const languages = configLanguages();
  const track = configTrack();
  console.log(pc.bold("\n  atrophy setup\n"));
  console.log(`  languages: ${languages.length > 0 ? languages.join(", ") : pc.dim("all")}`);
  console.log(`  track:     ${track ?? pc.dim("all")}`);

  console.log(pc.bold("\n  discovered tracks\n"));
  const header = ["name".padEnd(12), "drills".padStart(6), "  dir"];
  console.log(pc.dim("  " + header.join("  ")));
  for (const t of tracks) {
    const n = counts.get(t.dir) ?? 0;
    console.log(`  ${t.name.padEnd(12)}${String(n).padStart(6)}  ${pc.dim(t.dir)}`);
  }
  const ambiguous = ambiguousTracks(tracks);
  if (ambiguous.length > 0) {
    console.log(
      pc.yellow(`\n  note: ambiguous track name(s): ${ambiguous.join(", ")}`) +
        pc.dim(" - matching one throws; rename via pack.json"),
    );
  }
  console.log();
}

/** Every entry validates against LANGUAGES, deduped; a bad one is the whole answer's error. */
function parseLanguagesCsv(csv: string): Language[] | { error: string } {
  const entries = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const e of entries) {
    if (!(LANGUAGES as readonly string[]).includes(e)) {
      return { error: `unknown language "${e}" - one of: ${LANGUAGES.join(", ")}` };
    }
  }
  return [...new Set(entries)] as Language[];
}

/** Applies validated, already-checked updates and writes once; `undefined` clears the key. */
function applyConfig(languages: { set: boolean; value?: Language[] }, track: { set: boolean; value?: string }): void {
  const config = readConfig();
  if (languages.set) {
    if (languages.value === undefined || languages.value.length === 0) delete config.languages;
    else config.languages = languages.value;
  }
  if (track.set) {
    if (track.value === undefined) delete config.track;
    else config.track = track.value;
  }
  writeConfig(config);
}

/** Flag-driven path: validates everything first so a bad entry writes nothing at all. */
function runFlags(flags: SetupFlags, discovered: Discovered): void {
  let languages: { set: boolean; value?: Language[] } = { set: false };
  if (flags.allLanguages) {
    languages = { set: true, value: undefined };
  } else if (flags.languages !== undefined) {
    const parsed = parseLanguagesCsv(flags.languages);
    if (!Array.isArray(parsed)) {
      console.error(pc.red(parsed.error));
      process.exitCode = 1;
      return;
    }
    languages = { set: true, value: parsed };
  }

  let track: { set: boolean; value?: string } = { set: false };
  if (flags.track !== undefined) {
    const wanted = flags.track.trim().toLowerCase();
    if (wanted === "all") {
      track = { set: true, value: undefined };
    } else {
      const found = findTrack(discovered.tracks, wanted); // throws only on an ambiguous name
      if (!found) {
        console.error(
          pc.red(`unknown track "${wanted}" - discovered: ${discovered.tracks.map((t) => t.name).join(", ")}`) +
            pc.dim(` (check --track / "track" in ${configPath()})`),
        );
        process.exitCode = 1;
        return;
      }
      track = { set: true, value: found.name };
    }
  }

  applyConfig(languages, track);
  printState(discovered);
}

/** Comma-separated 1-based picks into LANGUAGES; blank/garbage-only answer means "all". */
function parseLanguagePicks(answer: string): Language[] | undefined {
  const picks = answer
    .trim()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (picks.length === 0) return undefined;
  const langs: Language[] = [];
  for (const p of picks) {
    const n = Number.parseInt(p, 10);
    const lang = Number.isInteger(n) ? LANGUAGES[n - 1] : undefined;
    if (lang) langs.push(lang);
  }
  const deduped = [...new Set(langs)];
  return deduped.length > 0 ? deduped : undefined;
}

/** `0` (or blank/garbage) means "all"; otherwise a 1-based index into `tracks`. */
function parseTrackPick(answer: string, tracks: Track[]): string | undefined {
  const n = Number.parseInt(answer.trim(), 10);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return tracks[n - 1]?.name;
}

async function runInteractive(io: SetupIO, discovered: Discovered): Promise<void> {
  console.log(pc.bold("\n  atrophy setup\n"));
  console.log("  Languages:");
  LANGUAGES.forEach((l, i) => console.log(`    ${i + 1}. ${l}`));
  const langAnswer = await io.question("  Pick languages (comma-separated numbers, empty = all) > ");
  const languages = parseLanguagePicks(langAnswer);

  console.log("\n  Track:");
  console.log("    0. all");
  discovered.tracks.forEach((t, i) => {
    const n = discovered.counts.get(t.dir) ?? 0;
    console.log(`    ${i + 1}. ${t.name} (${n} drill${n === 1 ? "" : "s"})`);
  });
  const trackAnswer = await io.question("  Pick a track (number, 0 = all) > ");
  const track = parseTrackPick(trackAnswer, discovered.tracks);

  applyConfig({ set: true, value: languages }, { set: true, value: track });
  printState(discovered);
}

export async function setupAction(flags: SetupFlags, io?: SetupIO): Promise<void> {
  const discovered = discoverTracks();

  if (flags.show) {
    printState(discovered);
    return;
  }

  const interactive = flags.languages === undefined && !flags.allLanguages && flags.track === undefined;
  if (!interactive) {
    runFlags(flags, discovered);
    return;
  }

  const activeIo = io ?? defaultIo();
  try {
    await runInteractive(activeIo, discovered);
  } finally {
    activeIo.close();
  }
}
