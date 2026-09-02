import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ambiguousTracks, findTrack, resolveTracks, trackName, type Track } from "./tracks.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** A throwaway pack directory named `basename`, under a fresh temp root. */
function mkTemp(basename: string): string {
  const root = mkdtempSync(join(tmpdir(), "atrophy-tracks-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, basename);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("trackName", () => {
  it("pack.json name wins; basename (lowercased) is the fallback", () => {
    const withMeta = mkTemp("MyPack");
    writeFileSync(join(withMeta, "pack.json"), JSON.stringify({ name: "alpha", description: "x" }));
    const bare = mkTemp("Atrophy-Pack-BETA");
    expect(trackName(withMeta)).toBe("alpha");
    expect(trackName(bare)).toBe("atrophy-pack-beta");
  });

  it("invalid pack.json (bad slug, reserved name, malformed JSON) falls back to basename", () => {
    const badSlug = mkTemp("Bad Slug!");
    writeFileSync(join(badSlug, "pack.json"), JSON.stringify({ name: "Bad Slug!" }));
    expect(trackName(badSlug)).toBe("bad slug!");

    const reserved = mkTemp("all");
    writeFileSync(join(reserved, "pack.json"), JSON.stringify({ name: "all" }));
    expect(trackName(reserved)).toBe("all");

    const malformed = mkTemp("Malformed-Pack");
    writeFileSync(join(malformed, "pack.json"), "{not json");
    expect(trackName(malformed)).toBe("malformed-pack");
  });

  it("no pack.json at all falls back to basename", () => {
    const noMeta = mkTemp("NoMeta-Pack");
    expect(trackName(noMeta)).toBe("nometa-pack");
  });

  it("never throws", () => {
    const badSlug = mkTemp("Bad Slug!");
    writeFileSync(join(badSlug, "pack.json"), JSON.stringify({ name: "Bad Slug!" }));
    expect(() => trackName(badSlug)).not.toThrow();
  });
});

describe("resolveTracks", () => {
  it("puts base first and flags it", () => {
    const t = resolveTracks("/bank", ["/p1"]);
    expect(t[0]).toEqual({ name: "base", dir: "/bank", isBase: true });
  });

  it("adds one track per pack dir, in order, after base", () => {
    const p1 = mkTemp("Pack-One");
    const p2 = mkTemp("Pack-Two");
    writeFileSync(join(p2, "pack.json"), JSON.stringify({ name: "alpha" }));
    const t = resolveTracks("/bank", [p1, p2]);
    expect(t).toEqual([
      { name: "base", dir: "/bank", isBase: true },
      { name: "pack-one", dir: p1, isBase: false },
      { name: "alpha", dir: p2, isBase: false },
    ]);
  });

  it("with no packs, returns only base", () => {
    expect(resolveTracks("/bank", [])).toEqual([{ name: "base", dir: "/bank", isBase: true }]);
  });
});

describe("ambiguousTracks / findTrack", () => {
  const tracks: Track[] = [
    { name: "base", dir: "/b", isBase: true },
    { name: "alpha", dir: "/p1", isBase: false },
    { name: "alpha", dir: "/p2", isBase: false },
  ];

  it("findTrack matches case-insensitively and throws on ambiguity", () => {
    expect(ambiguousTracks(tracks)).toEqual(["alpha"]);
    expect(() => findTrack(tracks, "ALPHA")).toThrow(/ambiguous/);
    expect(findTrack(tracks, "base")!.isBase).toBe(true);
  });

  it("ambiguousTracks is empty when every name is unique", () => {
    expect(ambiguousTracks(resolveTracks("/bank", []))).toEqual([]);
  });

  it("findTrack returns undefined for an unknown name", () => {
    expect(findTrack(tracks, "nope")).toBeUndefined();
  });

  it("findTrack trims and lowercases the query", () => {
    expect(findTrack(tracks, "  Base  ")!.isBase).toBe(true);
  });
});
