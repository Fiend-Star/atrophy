import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtrophyConfig } from "./config.js";
import { readConfig } from "./config.js";
import { setupAction, type SetupDeps, type SetupIO } from "./setup.js";

/** A minimal `recall` exercise: no toolchain, nothing to grade, cheapest way to seed a track. */
function recall(id: string, answer: string) {
  return {
    id,
    kind: "recall",
    axis: "syntax-recall",
    language: "python",
    tier: 1,
    title: id,
    prompt: `prompt for ${id}`,
    softTimeLimitSeconds: 60,
    acceptedAnswers: [answer],
  };
}

const ENV_KEYS = ["ATROPHY_CONFIG", "ATROPHY_BANK", "ATROPHY_PACKS"] as const;

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

let root: string;
let bankDir: string;
let packDir: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let logged: string[];
let errored: string[];
let exitCodeBefore: typeof process.exitCode;

function writeCfg(config: AtrophyConfig): void {
  writeFileSync(process.env.ATROPHY_CONFIG!, JSON.stringify(config), "utf8");
}

/**
 * Scratch roots injected explicitly, the way `cli/index.ts` injects the real
 * `bankRoots` - `setupAction` takes no import of its own to discover them.
 */
function deps(io?: SetupIO): SetupDeps {
  return { roots: () => ({ base: bankDir, packs: [packDir] }), io };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "atrophy-setup-"));
  bankDir = join(root, "bank");
  packDir = join(root, "pack");
  mkdirSync(bankDir, { recursive: true });
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(bankDir, "sr-py-001.json"), JSON.stringify(recall("sr-py-001", "a")), "utf8");
  writeFileSync(join(bankDir, "sr-py-002.json"), JSON.stringify(recall("sr-py-002", "b")), "utf8");
  writeFileSync(join(packDir, "pack.json"), JSON.stringify({ name: "tpack" }), "utf8");
  writeFileSync(join(packDir, "tp-recall-001.json"), JSON.stringify(recall("tp-recall-001", "c")), "utf8");
  process.env.ATROPHY_CONFIG = join(root, "config.json");
  process.env.ATROPHY_BANK = bankDir;
  process.env.ATROPHY_PACKS = packDir;
  logged = [];
  errored = [];
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(strip(args.map(String).join(" ")));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errored.push(strip(args.map(String).join(" ")));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("setupAction: flags (non-interactive)", () => {
  it("sets languages, deduped, in first-seen order", async () => {
    await setupAction({ languages: "python,python,java" }, deps());
    expect(readConfig().languages).toEqual(["python", "java"]);
  });

  it("rejects an unknown language entry and writes nothing", async () => {
    writeCfg({ languages: ["python"] });
    await setupAction({ languages: "java,cobol" }, deps());

    expect(errored.some((l) => l.includes('unknown language "cobol"'))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(readConfig().languages).toEqual(["python"]);
  });

  it("--all-languages clears a previously set allowlist", async () => {
    writeCfg({ languages: ["python", "java"] });
    await setupAction({ allLanguages: true }, deps());
    expect(readConfig().languages).toBeUndefined();
    expect("languages" in readConfig()).toBe(false);
  });

  it("--track <name> sets it; --track all clears it", async () => {
    await setupAction({ track: "tpack" }, deps());
    expect(readConfig().track).toBe("tpack");

    await setupAction({ track: "all" }, deps());
    expect(readConfig().track).toBeUndefined();
    expect("track" in readConfig()).toBe(false);
  });

  it("an unknown track name is a friendly error listing discovered names; nothing written", async () => {
    writeCfg({ track: "tpack" });
    await setupAction({ track: "nope" }, deps());

    const msg = errored.find((l) => l.includes('unknown track "nope"'));
    expect(msg).toBeDefined();
    expect(msg).toContain("base");
    expect(msg).toContain("tpack");
    expect(process.exitCode).toBe(1);
    expect(readConfig().track).toBe("tpack");
  });

  it("--show prints current config and the discovered track table, and writes nothing", async () => {
    writeCfg({ languages: ["sql"], track: "tpack" });
    const before = readConfig();

    await setupAction({ show: true }, deps());

    expect(readConfig()).toEqual(before);
    expect(logged.some((l) => l.includes("sql"))).toBe(true);
    expect(logged.some((l) => l.includes("tpack"))).toBe(true);
    expect(logged.some((l) => l.includes("base"))).toBe(true);
  });

  it("preserves unrelated config keys (leaderboard) on write", async () => {
    writeCfg({ leaderboard: { handle: "gurm" } });
    await setupAction({ languages: "python" }, deps());

    const cfg = readConfig();
    expect(cfg.leaderboard).toEqual({ handle: "gurm" });
    expect(cfg.languages).toEqual(["python"]);
  });
});

describe("setupAction: interactive (no flags)", () => {
  function stub(answers: string[]): SetupIO {
    const queue = [...answers];
    return {
      question: async () => queue.shift() ?? "",
      close: () => {},
    };
  }

  it("scripted answers pick languages by number, then the track by number", async () => {
    // LANGUAGES = python, javascript, java, sql -> "1,3" = python, java.
    // tracks = [base, tpack] -> "2" = tpack.
    const io = stub(["1,3", "2"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toEqual(["python", "java"]);
    expect(cfg.track).toBe("tpack");
  });

  it("empty language answer and 0 track answer both clear (mean 'all')", async () => {
    writeCfg({ languages: ["python"], track: "tpack" });
    const io = stub(["", "0"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toBeUndefined();
    expect(cfg.track).toBeUndefined();
  });

  it("closes the injected io", async () => {
    let closed = false;
    const io: SetupIO = {
      question: async () => "",
      close: () => {
        closed = true;
      },
    };
    await setupAction({}, deps(io));
    expect(closed).toBe(true);
  });

  it("is only entered when no flags are given at all", async () => {
    // Any single flag must short-circuit interactive mode even with io injected.
    const io = stub(["1,3", "2"]);
    await setupAction({ track: "all" }, deps(io));
    // the scripted answers were never consumed
    expect(readConfig().languages).toBeUndefined();
  });

  it("re-prompts on an out-of-range language pick instead of silently writing 'all'", async () => {
    // LANGUAGES has 4 entries; "5" is out of range and must not be treated as "all".
    const io = stub(["5", "1,3", "2"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toEqual(["python", "java"]);
    expect(cfg.track).toBe("tpack");
    expect(logged.some((l) => l.toLowerCase().includes("invalid"))).toBe(true);
  });

  it("re-prompts on an out-of-range track pick instead of silently writing 'all'", async () => {
    // tracks = [base, tpack]; "5" is past the list and must not be treated as "all".
    const io = stub(["", "5", "2"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toBeUndefined();
    expect(cfg.track).toBe("tpack");
    expect(logged.some((l) => l.toLowerCase().includes("invalid"))).toBe(true);
  });

  it("re-prompts (does not crash) on a zero-valued track pick that isn't the literal '0'", async () => {
    // "00" parses to n=0 but must NOT take the "0"-literal fast path to "all" - tracks[-1] is
    // undefined, and treating it as a valid index would throw reading .name off undefined.
    const io = stub(["", "00", "2"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toBeUndefined();
    expect(cfg.track).toBe("tpack");
    expect(logged.some((l) => l.toLowerCase().includes("invalid"))).toBe(true);
  });

  it("also re-prompts on other zero-valued, non-literal-'0' track answers", async () => {
    const io = stub(["", "-0", "0.0", "0"]);
    await setupAction({}, deps(io));

    const cfg = readConfig();
    expect(cfg.languages).toBeUndefined();
    expect(cfg.track).toBeUndefined();
  });

  it("refuses to persist an ambiguous track pick and re-prompts", async () => {
    const packDir2 = join(root, "pack2");
    mkdirSync(packDir2, { recursive: true });
    writeFileSync(join(packDir2, "pack.json"), JSON.stringify({ name: "tpack" }), "utf8");
    writeFileSync(join(packDir2, "tp2-recall-001.json"), JSON.stringify(recall("tp2-recall-001", "d")), "utf8");
    const twoPackDeps = (io: SetupIO): SetupDeps => ({
      roots: () => ({ base: bankDir, packs: [packDir, packDir2] }),
      io,
    });

    // tracks = [base, tpack(packDir), tpack(packDir2)]; "2" names an ambiguous "tpack".
    const io = stub(["", "2", "0"]);
    await setupAction({}, twoPackDeps(io));

    const cfg = readConfig();
    expect(cfg.track).toBeUndefined();
    expect(logged.some((l) => l.toLowerCase().includes("ambiguous"))).toBe(true);
  });
});

describe("setupAction: --show combined with setter flags", () => {
  it("prints an ignoring-warning per setter flag and writes nothing", async () => {
    writeCfg({ languages: ["python"], track: "tpack" });
    const before = readConfig();

    await setupAction({ show: true, languages: "java", track: "nope" }, deps());

    expect(readConfig()).toEqual(before);
    expect(logged.some((l) => l.includes("ignoring --languages (--show never writes)"))).toBe(true);
    expect(logged.some((l) => l.includes("ignoring --track (--show never writes)"))).toBe(true);
  });

  it("also warns for --all-languages", async () => {
    writeCfg({ languages: ["python"] });
    const before = readConfig();

    await setupAction({ show: true, allLanguages: true }, deps());

    expect(readConfig()).toEqual(before);
    expect(logged.some((l) => l.includes("ignoring --all-languages (--show never writes)"))).toBe(true);
  });
});
