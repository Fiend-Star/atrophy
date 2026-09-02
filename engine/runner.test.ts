import { describe, expect, it } from "vitest";
import { run } from "./runner.js";

interface ProbeEnv {
  TEMP: string | null;
  TMP: string | null;
  PYTHONIOENCODING: string | null;
  MARKER: string | null;
}

/**
 * Report a few env vars from inside a child spawned through `run`.
 * Note: on win32 libuv force-inherits a fixed set of variables (PATH, TEMP,
 * USERPROFILE, WINDIR, ...) regardless of the env we pass, so minimality is
 * asserted with a marker variable outside that set.
 */
async function probeChildEnv(): Promise<ProbeEnv> {
  const r = await run(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({ TEMP: process.env.TEMP ?? null, TMP: process.env.TMP ?? null, PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? null, MARKER: process.env.ATROPHY_RUNNER_ENV_MARKER ?? null }))",
    ],
    { cwd: process.cwd(), timeoutMs: 15_000 },
  );
  return JSON.parse(r.stdout.trim()) as ProbeEnv;
}

/** `run` reads process.env directly, so exercising it means mutating and restoring ours. */
async function withParentEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

describe("run env", () => {
  it("keeps the env minimal - the parent environment does not leak in", async () => {
    const env = await withParentEnv("ATROPHY_RUNNER_ENV_MARKER", "leaked", probeChildEnv);
    expect(env.MARKER).toBeNull();
  });

  it("passes TEMP/TMP through on Windows so the JVM can resolve java.io.tmpdir", async () => {
    const env = await probeChildEnv();
    if (process.platform === "win32") {
      expect(env.TEMP).toBe(process.env.TEMP ?? null);
      expect(env.TMP).toBe(process.env.TMP ?? null);
    } else {
      expect(env.TEMP).toBeNull();
      expect(env.TMP).toBeNull();
    }
  });

  it("defaults PYTHONIOENCODING to utf-8 when the parent has none", async () => {
    const env = await withParentEnv("PYTHONIOENCODING", undefined, probeChildEnv);
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("forwards the parent's PYTHONIOENCODING rather than dropping it", async () => {
    const env = await withParentEnv("PYTHONIOENCODING", "utf-8:backslashreplace", probeChildEnv);
    expect(env.PYTHONIOENCODING).toBe("utf-8:backslashreplace");
  });
});

describe("run - output cap truncation flag", () => {
  it("flags stdout the cap actually cut off", async () => {
    // Comfortably past the 256KB cap, so the flag can only be true if data was really lost.
    const r = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(1_000_000))"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(r.stdout.length).toBeLessThan(1_000_000);
    expect(r.truncated).toBe(true);
  });

  it("does not flag ordinary output that never approaches the cap", async () => {
    const r = await run(process.execPath, ["-e", "console.log('hi')"], { cwd: process.cwd(), timeoutMs: 15_000 });
    expect(r.truncated).toBe(false);
  });
});

describe("run - output cap boundary", () => {
  it("keeps output of exactly the cap intact, and still flags it: truncated means reached, not necessarily lost", async () => {
    const cap = 256 * 1024;
    const r = await run(process.execPath, ["-e", `process.stdout.write('x'.repeat(${cap}))`], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    // Nothing was dropped - the runner appends whole chunks while below the cap and only
    // drops what arrives after it - yet the flag is set: `truncated` means "reached the
    // cap", which is exactly why grader.ts's message says "reached" rather than "exceeded".
    expect(r.stdout.length).toBe(cap);
    expect(r.truncated).toBe(true);
  });
});
