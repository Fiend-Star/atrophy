import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packDirs, readConfig } from "./config.js";

const cleanups: (() => void)[] = [];
const originalConfig = process.env.ATROPHY_CONFIG;
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  if (originalConfig === undefined) delete process.env.ATROPHY_CONFIG;
  else process.env.ATROPHY_CONFIG = originalConfig;
});

function withConfig(json: string): void {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, json, "utf8");
  process.env.ATROPHY_CONFIG = file;
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
}

/** A real directory (so realpath can canonicalise it), cleaned up after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
});

describe("packDirs", () => {
  it("combines ATROPHY_PACKS (delimiter-separated) with config packs, env first", () => {
    withConfig(JSON.stringify({ packs: ["/from/config"] }));
    const env = { ...process.env, ATROPHY_PACKS: ["/pack/a", "", "/pack/b"].join(delimiter) };
    expect(packDirs(env)).toEqual([
      resolve("/pack/a"),
      resolve("/pack/b"),
      resolve("/from/config"),
    ]);
  });
  it("is empty with no env and no config entry", () => {
    withConfig("{}");
    const env = { ...process.env };
    delete env.ATROPHY_PACKS;
    expect(packDirs(env)).toEqual([]);
  });

  it("lists a directory named in both ATROPHY_PACKS and config only once", () => {
    const dir = tempDir();
    withConfig(JSON.stringify({ packs: [dir] }));
    const env = { ...process.env, ATROPHY_PACKS: dir };
    // realpath, not resolve: tmpdir() may itself be a symlink or an 8.3 short path
    expect(packDirs(env)).toEqual([realpathSync.native(dir)]);
  });

  it("collapses case-variant spellings of the same real directory on win32", () => {
    const dir = tempDir();
    withConfig(JSON.stringify({ packs: [dir.toUpperCase()] }));
    const env = { ...process.env, ATROPHY_PACKS: dir };
    // On case-sensitive filesystems the upper-cased spelling is a genuinely
    // different (and non-existent) path, so it must survive as its own entry.
    const expected =
      process.platform === "win32"
        ? [realpathSync.native(dir)]
        : [realpathSync.native(dir), resolve(dir.toUpperCase())];
    expect(packDirs(env)).toEqual(expected);
  });

  it("passes a not-yet-existing directory through resolved instead of throwing", () => {
    withConfig("{}");
    const missing = join(tmpdir(), "atrophy-pack-does-not-exist", "sub");
    const env = { ...process.env, ATROPHY_PACKS: missing };
    expect(packDirs(env)).toEqual([resolve(missing)]);
  });
});
