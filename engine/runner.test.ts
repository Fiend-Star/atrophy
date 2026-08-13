import { describe, expect, it } from "vitest";
import { run } from "./runner.js";

interface ProbeEnv {
  TEMP: string | null;
  TMP: string | null;
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
      "console.log(JSON.stringify({ TEMP: process.env.TEMP ?? null, TMP: process.env.TMP ?? null, MARKER: process.env.ATROPHY_RUNNER_ENV_MARKER ?? null }))",
    ],
    { cwd: process.cwd(), timeoutMs: 15_000 },
  );
  return JSON.parse(r.stdout.trim()) as ProbeEnv;
}

describe("run env", () => {
  it("keeps the env minimal - the parent environment does not leak in", async () => {
    process.env.ATROPHY_RUNNER_ENV_MARKER = "leaked";
    try {
      const env = await probeChildEnv();
      expect(env.MARKER).toBeNull();
    } finally {
      delete process.env.ATROPHY_RUNNER_ENV_MARKER;
    }
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
});
