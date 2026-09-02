import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../bank/schema.js";
import type { SelectOptions } from "../engine/select.js";
import { Store } from "../store/db.js";

/**
 * The selection seam: every `selectExercise` call the CLI makes, in order. Real
 * selection still runs (this is a spy, not a stub) so the drill path behaves
 * exactly as it does in production - we only read the options it was handed.
 */
const seam = vi.hoisted(() => ({ selectCalls: [] as unknown[] }));

vi.mock("../engine/select.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/select.js")>();
  return {
    ...actual,
    selectExercise: (opts: SelectOptions) => {
      seam.selectCalls.push(opts);
      return actual.selectExercise(opts);
    },
  };
});

let dir: string;
let store: Store;
let envDir: string;
let savedConfig: string | undefined;

beforeAll(() => {
  // no drill here records or syncs (every call is --show), but a leaked write
  // must never be able to reach the real board
  process.env.ATROPHY_NO_SYNC = "1";
  // selection reads the config (languages allowlist, track focus), so point it at
  // a path that does not exist: these tests must not see the developer's own
  // ~/.atrophy/config.json, which could narrow the pool under them
  envDir = mkdtempSync(join(tmpdir(), "atrophy-cli-env-"));
  savedConfig = process.env.ATROPHY_CONFIG;
  process.env.ATROPHY_CONFIG = join(envDir, "config.json");
});
afterAll(() => {
  delete process.env.ATROPHY_NO_SYNC;
  if (savedConfig === undefined) delete process.env.ATROPHY_CONFIG;
  else process.env.ATROPHY_CONFIG = savedConfig;
  rmSync(envDir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atrophy-cli-"));
  store = new Store(join(dir, "t.db"));
  seam.selectCalls.length = 0;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Recorded sessions, oldest first, one minute apart (recency = insertion order). */
function seedSessions(langs: (Language | "any")[]): void {
  const base = Date.now() - langs.length * 60_000;
  langs.forEach((language, i) => {
    store.recordSession({
      ts: new Date(base + i * 60_000).toISOString(),
      exercise_id: `seed-${i}`,
      axis: "syntax-recall",
      language,
      tier: 1,
      mode: "ai-off",
      passed: 1,
      total: 1,
      elapsed_seconds: 60,
      score: 1,
      rating_before: 1200,
      rating_after: 1200,
    });
  });
}

async function importCli(): Promise<typeof import("./index.js")> {
  return await import("./index.js");
}

describe("cli/index.ts is import-safe", () => {
  it("importing parses no argv, exits nothing, and prints nothing", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0}) ran at import time`);
    }) as never);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // ESM caches modules: without this, a test that imported first would make
      // every assertion below pass vacuously (nothing re-executes on re-import).
      vi.resetModules();
      const mod = await importCli();
      expect(exit).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(seam.selectCalls).toHaveLength(0);
      expect(typeof mod.runCli).toBe("function");
      expect(typeof mod.drillOnce).toBe("function");
    } finally {
      exit.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("runCli still dispatches a command when it is called on purpose", async () => {
    const mod = await importCli();
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.ATROPHY_DB = join(dir, "runcli.db"); // the action opens its own Store
    const exitCodeBefore = process.exitCode;
    try {
      await mod.runCli(["node", "atrophy", "drill", "--axis", "syntax-recall", "--show"]);
      expect(process.exitCode ?? 0).toBe(0);
      const opts = seam.selectCalls.at(-1) as SelectOptions;
      expect(opts.axis).toBe("syntax-recall");
    } finally {
      process.exitCode = exitCodeBefore;
      delete process.env.ATROPHY_DB;
    }
  });

  it("exports the command action functions", async () => {
    const mod = await importCli();
    for (const fn of [
      mod.drillAction,
      mod.baselineAction,
      mod.statsAction,
      mod.serveAction,
      mod.publishAction,
      mod.exportAction,
      mod.doctorAction,
      mod.backupAction,
      mod.resetAction,
      mod.reportAction,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});

describe("language-mix wiring", () => {
  beforeEach(() => {
    // --show previews the exercise; keep the drill's own output out of the run
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("a drill with no --lang hands selection the store's recent-language window", async () => {
    const mod = await importCli();
    // seven sessions: the window is the last six, most-recent-first
    seedSessions(["java", "java", "java", "java", "java", "java", "python"]);
    seam.selectCalls.length = 0;

    const ok = await mod.drillOnce(store, { axis: "syntax-recall", show: true });

    expect(ok).toBe(true);
    const opts = seam.selectCalls.at(-1) as SelectOptions;
    expect(opts.language).toBeUndefined();
    expect(opts.recentLanguages).toEqual(["python", "java", "java", "java", "java", "java"]);
  });

  it("an explicit --lang bypasses the policy entirely", async () => {
    const mod = await importCli();
    seedSessions(["java", "java", "java", "java", "java", "java"]);
    seam.selectCalls.length = 0;

    await mod.drillOnce(store, { axis: "syntax-recall", lang: "python", show: true });

    const opts = seam.selectCalls.at(-1) as SelectOptions;
    expect(opts.language).toBe("python");
    expect(opts.recentLanguages).toBeUndefined();
  });

  it("baseline opts out: no window on any of its per-axis draws", async () => {
    const mod = await importCli();
    seedSessions(["java", "java", "java", "java", "java", "java"]);
    seam.selectCalls.length = 0;

    await mod.baseline(store, { show: true });

    expect(seam.selectCalls.length).toBeGreaterThan(1);
    for (const opts of seam.selectCalls as SelectOptions[]) {
      expect(opts.recentLanguages).toBeUndefined();
    }
  });
});
