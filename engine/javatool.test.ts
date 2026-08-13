import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  hasJdk,
  javaCommand,
  javacCommand,
  javaResourceCandidates,
  javaResourceDir,
  missingJdkHint,
  parseJavaMajor,
} from "./javatool.js";
import { run } from "./runner.js";

describe("jdk discovery", () => {
  it("uses bare tool names without ATROPHY_JAVA_HOME", () => {
    expect(javaCommand({})).toBe("java");
    expect(javacCommand({})).toBe("javac");
  });
  it("resolves bin/<tool> under ATROPHY_JAVA_HOME (with .exe on win32)", () => {
    const home = join("C:", "jdk-21");
    const suffix = process.platform === "win32" ? ".exe" : "";
    expect(javaCommand({ ATROPHY_JAVA_HOME: home })).toBe(join(home, "bin", `java${suffix}`));
    expect(javacCommand({ ATROPHY_JAVA_HOME: home })).toBe(join(home, "bin", `javac${suffix}`));
  });
  it("probes for a JDK once and caches the answer", () => {
    const first = hasJdk();
    expect(typeof first).toBe("boolean");
    expect(hasJdk()).toBe(first);
  });
});

describe("constants and helpers", () => {
  it("pins encoding, locale, and timezone", () => {
    expect(JAVA_RUNTIME_FLAGS).toEqual([
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Duser.timezone=UTC",
    ]);
    expect(JAVA_COMPILE_TIMEOUT_MS).toBe(30_000);
  });
  it("parses javac/java version output", () => {
    expect(parseJavaMajor("javac 21.0.9")).toBe(21);
    expect(parseJavaMajor('openjdk version "21.0.9" 2025-10-21 LTS')).toBe(21);
    expect(parseJavaMajor("gibberish")).toBeNull();
  });
  it("resource candidates cover the dev and built layouts", () => {
    const cands = javaResourceCandidates();
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands.every((c) => c.endsWith(join("engine", "java")))).toBe(true);
  });
  it("hints at the JDK requirement when a tool is missing", () => {
    expect(missingJdkHint("javac")).toMatch(/JDK.*21|ATROPHY_JAVA_HOME/);
  });
});

if (!hasJdk()) console.warn("⚠ JDK not found - Java resource compile test SKIPPED. Install JDK 21 to validate.");
describe.skipIf(!hasJdk())("java resources", () => {
  it("Harness.java and Atrophy.java compile cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-javares-"));
    try {
      cpSync(javaResourceDir(), dir, { recursive: true });
      const r = await run(javacCommand(), ["-encoding", "UTF-8", "Harness.java", "Atrophy.java"], {
        cwd: dir,
        timeoutMs: JAVA_COMPILE_TIMEOUT_MS,
      });
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
