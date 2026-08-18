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
