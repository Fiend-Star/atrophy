import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exercise } from "../bank/schema.js";
import type { SelectOptions } from "../engine/select.js";
import { Store } from "../store/db.js";
import type { AtrophyConfig } from "./config.js";

/**
 * The selection seam (same spy technique as `cli/importable.test.ts`), plus what the
 * pick returned: real selection still runs, so "the allowlist is honoured" is asserted
 * on actual draws rather than on the options object alone.
 */
const seam = vi.hoisted(() => ({ calls: [] as unknown[], picked: [] as unknown[] }));

vi.mock("../engine/select.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/select.js")>();
  return {
    ...actual,
    selectExercise: (opts: SelectOptions) => {
      seam.calls.push(opts);
      const ex = actual.selectExercise(opts);
      seam.picked.push(ex);
      return ex;
    },
  };
});

/** The pack's only drill: recall, so nothing spawns and no toolchain can hide it. */
const PACK_EXERCISE = {
  id: "tp-recall-001",
  kind: "recall",
  axis: "syntax-recall",
  language: "python",
  tier: 1,
  title: "Pack-only drill",
  prompt: "Which track shipped this drill?",
  softTimeLimitSeconds: 60,
  acceptedAnswers: ["tpack"],
};

const ENV_KEYS = ["ATROPHY_CONFIG", "ATROPHY_PACKS", "ATROPHY_NO_SYNC", "ATROPHY_DB", "ATROPHY_BANK"] as const;

let dir: string;
let packDir: string;
let store: Store;
/** stdout, stderr, and both interleaved - the last one is how ordering is asserted. */
let logged: string[];
let errors: string[];
let output: string[];
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

/** picocolors emits escapes when the run has a TTY; assertions read plain text. */
const strip = (s: string): string => s.replace(/\u001B\[[0-9;]*m/g, "");

function writeCfg(config: AtrophyConfig): void {
  writeFileSync(process.env.ATROPHY_CONFIG!, JSON.stringify(config), "utf8");
}

function lastPick(): SelectOptions {
  return seam.calls.at(-1) as SelectOptions;
}

async function importCli(): Promise<typeof import("./index.js")> {
  return await import("./index.js");
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "atrophy-cli-"));
  packDir = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
  writeFileSync(join(packDir, "pack.json"), JSON.stringify({ name: "tpack" }), "utf8");
  writeFileSync(join(packDir, "tp-recall-001.json"), JSON.stringify(PACK_EXERCISE), "utf8");
  process.env.ATROPHY_CONFIG = join(dir, "config.json");
  process.env.ATROPHY_PACKS = packDir;
  process.env.ATROPHY_NO_SYNC = "1"; // every drill here is --show, but a leak must not reach the board
  delete process.env.ATROPHY_BANK; // these tests read the built-in bank; one test sets its own
  store = new Store(join(dir, "t.db"));
  seam.calls.length = 0;
  seam.picked.length = 0;
  logged = [];
  errors = [];
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = strip(args.map(String).join(" "));
    logged.push(line);
    output.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = strip(args.map(String).join(" "));
    errors.push(line);
    output.push(line);
  });
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
});

describe("language allowlist wiring", () => {
  it("narrows the pool to the configured languages and says so", async () => {
    writeCfg({ languages: ["python"] });
    const mod = await importCli();

    const ok = await mod.drillOnce(store, { axis: "syntax-recall", show: true });

    expect(ok).toBe(true);
    expect(lastPick().allowedLanguages).toEqual(["python"]);
    expect(
      logged.some((l) =>
        /^config limits languages to python - \d+ drills hidden on this axis \(atrophy setup to change\)$/.test(l),
      ),
    ).toBe(true);
  });

  it("never serves a language outside the allowlist", async () => {
    writeCfg({ languages: ["python"] });
    const mod = await importCli();

    for (let i = 0; i < 10; i++) {
      await mod.drillOnce(store, { axis: "syntax-recall", show: true });
    }

    expect(seam.picked).toHaveLength(10);
    for (const ex of seam.picked as (Exercise | undefined)[]) {
      expect(ex).toBeDefined();
      expect(["python", "any"]).toContain(ex!.language);
    }
  });

  it("serves an explicit --lang outside the allowlist, with a note", async () => {
    writeCfg({ languages: ["python"] });
    const mod = await importCli();

    await mod.drillOnce(store, { axis: "syntax-recall", lang: "java", show: true });

    const pick = lastPick();
    expect(pick.language).toBe("java");
    expect(pick.allowedLanguages).toBeUndefined();
    // stderr, so a piped `atrophy drill` keeps the note out of the drill content
    expect(errors).toContain(
      "note: --lang java is outside your configured languages (python) - serving it anyway",
    );
  });

  it("explains the narrowing before reporting an axis it emptied", async () => {
    // a bank the allowlist can empty: one java drill on the one axis with no
    // generator families, so nothing else can be offered in its place
    const bankDir = mkdtempSync(join(tmpdir(), "atrophy-bank-"));
    writeFileSync(
      join(bankDir, "dec-java-900.json"),
      JSON.stringify({
        id: "dec-java-900",
        kind: "recall", // no JVM, so the allowlist (not a missing JDK) is what hides it
        axis: "decomposition",
        language: "java",
        tier: 1,
        title: "Java-only drill",
        prompt: "Where does this drill come from?",
        softTimeLimitSeconds: 60,
        acceptedAnswers: ["the temp bank"],
      }),
      "utf8",
    );
    process.env.ATROPHY_BANK = bankDir; // replaces the built-in bank
    delete process.env.ATROPHY_PACKS;
    writeCfg({ languages: ["python"] });
    const mod = await importCli();

    try {
      const ok = await mod.drillOnce(store, { axis: "decomposition", show: true });

      expect(ok).toBe(false);
      const narrowing = output.findIndex((l) => l.startsWith("config limits languages to python - 1 drills"));
      const empty = output.findIndex((l) => l.startsWith('no exercises in the bank for axis "decomposition"'));
      expect(narrowing).toBeGreaterThanOrEqual(0);
      expect(empty).toBeGreaterThan(narrowing);
    } finally {
      delete process.env.ATROPHY_BANK;
      rmSync(bankDir, { recursive: true, force: true });
    }
  });

  it("no config: no allowlist, no narrowing line", async () => {
    const mod = await importCli();

    await mod.drillOnce(store, { axis: "syntax-recall", show: true });

    expect(lastPick().allowedLanguages).toBeUndefined();
    expect(logged.some((l) => l.startsWith("config limits languages"))).toBe(false);
  });
});

describe("track focus wiring", () => {
  it("--track serves that pack alone, with no generators, and announces it", async () => {
    const mod = await importCli();

    const ok = await mod.drillOnce(store, { axis: "syntax-recall", track: "tpack", show: true });

    expect(ok).toBe(true);
    const pick = lastPick();
    expect(pick.statics.map((e) => e.id)).toEqual(["tp-recall-001"]);
    expect(pick.generators).toEqual([]);
    expect((seam.picked.at(-1) as Exercise).id).toBe("tp-recall-001");
    expect(logged).toContain("track: tpack (1 drills)");
  });

  it("a configured track applies with no flag", async () => {
    writeCfg({ track: "tpack" });
    const mod = await importCli();

    await mod.drillOnce(store, { axis: "syntax-recall", show: true });

    expect(lastPick().statics.map((e) => e.id)).toEqual(["tp-recall-001"]);
  });

  it("--track all restores the full pool over a configured track", async () => {
    writeCfg({ track: "tpack" });
    const mod = await importCli();

    await mod.drillOnce(store, { axis: "syntax-recall", track: "all", show: true });

    const pick = lastPick();
    expect(pick.statics.length).toBeGreaterThan(1);
    expect(pick.generators?.length).toBeGreaterThan(0);
    expect(logged.some((l) => l.startsWith("track: "))).toBe(false);
  });

  it("an unknown track names the tracks that do exist", async () => {
    const mod = await importCli();

    await expect(mod.drillOnce(store, { axis: "syntax-recall", track: "nope", show: true })).rejects.toThrow(
      /tpack/,
    );
  });

  it("--exercise replays outside track focus and the allowlist", async () => {
    writeCfg({ track: "tpack", languages: ["python"] });
    const mod = await importCli();

    // a java exercise from the built-in bank: both filters would have hidden it
    const ok = await mod.drillOnce(store, { exercise: "sr-java-001", show: true });

    expect(ok).toBe(true);
    expect(seam.calls).toHaveLength(0);
    expect(logged.some((l) => l.startsWith("track: "))).toBe(false);
  });
});

describe("baseline narrowing", () => {
  it("sweeps only surviving axes and names the ones config skipped", async () => {
    writeCfg({ track: "tpack" });
    const mod = await importCli();

    await mod.baseline(store, { show: true });

    // the pack holds one syntax-recall drill, so that is the whole sweep
    for (const pick of seam.calls as SelectOptions[]) {
      expect(pick.axis).toBe("syntax-recall");
    }
    expect(logged).toContain("skipping debugging: no drills match your config (languages: all; track: tpack)");
    expect(logged.filter((l) => l.startsWith("skipping ")).length).toBe(4);
  });
});
