import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packDirs, readConfig } from "./config.js";

const cleanups: (() => void)[] = [];
const original = { ...process.env };
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const key of ["ATROPHY_CONFIG", "ATROPHY_PACKS"] as const) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Writes a throwaway config file and returns its path. */
function configFile(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, json, "utf8");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

/** Same, but pointed at via the ambient process.env - the zero-arg default path. */
function withConfig(json: string): void {
  process.env.ATROPHY_CONFIG = configFile(json);
}

/** A real directory (so realpath can canonicalise it), cleaned up after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Whether THIS filesystem folds case, probed rather than guessed from the
 * platform: APFS is case-insensitive but not win32, ext4 is case-sensitive but
 * a Windows box can host one. A case-sensitive fs has no upper-cased twin, so
 * realpath throws ENOENT.
 */
function foldsCase(dir: string): boolean {
  try {
    return realpathSync.native(dir.toUpperCase()) === realpathSync.native(dir);
  } catch {
    return false;
  }
}

describe("readConfig", () => {
  it("reads packs and tolerates a UTF-8 BOM", () => {
    withConfig("\uFEFF" + JSON.stringify({ packs: ["C:/packs/deshaw"] }));
    expect(readConfig().packs).toEqual(["C:/packs/deshaw"]);
  });
  it("returns {} for missing or broken config", () => {
    process.env.ATROPHY_CONFIG = join(tmpdir(), "nope", "config.json");
    expect(readConfig()).toEqual({});
  });
  it("returns {} for malformed JSON", () => {
    withConfig("{not json");
    expect(readConfig()).toEqual({});
  });
  it("reads the injected env instead of process.env when given one", () => {
    withConfig(JSON.stringify({ packs: ["/from/ambient"] }));
    const env = { ATROPHY_CONFIG: configFile(JSON.stringify({ packs: ["/from/injected"] })) };
    expect(readConfig(env).packs).toEqual(["/from/injected"]);
    expect(readConfig().packs).toEqual(["/from/ambient"]);
  });
});

describe("packDirs", () => {
  it("combines ATROPHY_PACKS (delimiter-separated) with config packs, env first", () => {
    const env = {
      ATROPHY_CONFIG: configFile(JSON.stringify({ packs: ["/from/config"] })),
      ATROPHY_PACKS: ["/pack/a", "", "/pack/b"].join(delimiter),
    };
    expect(packDirs(env)).toEqual([
      resolve("/pack/a"),
      resolve("/pack/b"),
      resolve("/from/config"),
    ]);
  });
  it("is empty with no env and no config entry", () => {
    expect(packDirs({ ATROPHY_CONFIG: configFile("{}") })).toEqual([]);
  });

  it("falls back to process.env when called with no argument", () => {
    withConfig(JSON.stringify({ packs: ["/from/ambient"] }));
    // a developer running with real packs configured must not fail this test
    delete process.env.ATROPHY_PACKS;
    expect(packDirs()).toEqual([resolve("/from/ambient")]);
  });

  it("lists a directory named in both ATROPHY_PACKS and config only once", () => {
    const dir = tempDir();
    const env = {
      ATROPHY_CONFIG: configFile(JSON.stringify({ packs: [dir] })),
      ATROPHY_PACKS: dir,
    };
    // realpath, not resolve: tmpdir() may itself be a symlink or an 8.3 short path
    expect(packDirs(env)).toEqual([realpathSync.native(dir)]);
  });

  it("collapses case-variant spellings of the same real directory on a case-folding fs", () => {
    const dir = tempDir();
    const env = {
      ATROPHY_CONFIG: configFile(JSON.stringify({ packs: [dir.toUpperCase()] })),
      ATROPHY_PACKS: dir,
    };
    // Where the fs is case-SENSITIVE the upper-cased spelling is a genuinely
    // different (and non-existent) path, so it must survive as its own entry.
    const expected = foldsCase(dir)
      ? [realpathSync.native(dir)]
      : [realpathSync.native(dir), resolve(dir.toUpperCase())];
    expect(packDirs(env)).toEqual(expected);
  });

  it("ignores a malformed config packs value instead of spreading it per character", () => {
    // hand-edited config: a bare string where an array belongs
    const env = { ATROPHY_CONFIG: configFile(JSON.stringify({ packs: "C:/packs/deshaw" })) };
    expect(packDirs(env)).toEqual([]);
  });

  it("skips non-string entries in config packs", () => {
    const env = { ATROPHY_CONFIG: configFile(JSON.stringify({ packs: [42, null, "/from/config"] })) };
    expect(packDirs(env)).toEqual([resolve("/from/config")]);
  });

  it("passes a not-yet-existing directory through resolved instead of throwing", () => {
    const missing = join(tmpdir(), "atrophy-pack-does-not-exist", "sub");
    const env = { ATROPHY_CONFIG: configFile("{}"), ATROPHY_PACKS: missing };
    expect(packDirs(env)).toEqual([resolve(missing)]);
  });
});
