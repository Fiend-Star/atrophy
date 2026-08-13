import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export interface AtrophyConfig {
  leaderboard?: { token?: string; handle?: string; url?: string };
  /** Extra exercise-bank directories merged on top of the built-in bank. */
  packs?: string[];
}

export function configPath(): string {
  return process.env.ATROPHY_CONFIG ?? join(homedir(), ".atrophy", "config.json");
}

export function readConfig(): AtrophyConfig {
  try {
    // tolerate a UTF-8 BOM (hand-edited or PowerShell-written configs)
    return JSON.parse(readFileSync(configPath(), "utf8").replace(/^\uFEFF/, "")) as AtrophyConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: AtrophyConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

/**
 * Canonical form of a pack path, used both as the returned value and as the
 * de-dupe key. realpath collapses Windows casing and resolves junctions so two
 * spellings of one directory can't be walked twice; a path that doesn't exist
 * yet is merely resolved - the caller reports missing packs with a friendly
 * error, so this must not throw.
 */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Additive pack directories: ATROPHY_PACKS (path-delimiter separated) then config packs. */
export function packDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env.ATROPHY_PACKS ?? "").split(delimiter);
  // a hand-edited config can hold anything; a bare string here would otherwise
  // spread one character per pack dir
  const configured: unknown = readConfig().packs;
  const fromConfig: unknown[] = Array.isArray(configured) ? configured : [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of [...fromEnv, ...fromConfig]) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    // a blank entry would resolve to the cwd and hand the whole repo to loadBank
    if (!trimmed) continue;
    const dir = canonical(trimmed);
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}
