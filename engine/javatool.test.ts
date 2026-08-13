import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  MIN_JDK_MAJOR,
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
  it("pins encoding, locale, timezone, and the stdout/stderr streams", () => {
    expect(JAVA_RUNTIME_FLAGS).toEqual([
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Duser.timezone=UTC",
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
    ]);
    expect(JAVA_COMPILE_TIMEOUT_MS).toBe(30_000);
  });
  it("pins the minimum JDK major", () => {
    expect(MIN_JDK_MAJOR).toBe(21);
  });
  it("parses patch, GA, and early-access version output", () => {
    expect(parseJavaMajor("javac 21.0.9")).toBe(21);
    expect(parseJavaMajor('openjdk version "21.0.9" 2025-10-21 LTS')).toBe(21);
    expect(parseJavaMajor("javac 21")).toBe(21);
    expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
    expect(parseJavaMajor("javac 25-ea")).toBe(25);
    expect(parseJavaMajor("gibberish")).toBeNull();
  });
  it("needs a word boundary, and survives a line that opens with a date", () => {
    // Digits inside a word are not a version - "jdk21" must not read as Java 21.
    expect(parseJavaMajor("jdk21")).toBeNull();
    // The 3-digit cap is what stops a leading date parsing as version 2025.
    expect(parseJavaMajor('2025-10-21 openjdk version "21.0.9"')).toBe(21);
  });
  it("resource candidates cover the dev and built layouts", () => {
    const cands = javaResourceCandidates();
    expect(cands).toHaveLength(2);
    const [dev, built] = cands;
    expect(dev).not.toBe(built);
    expect(dev?.endsWith(join("engine", "java"))).toBe(true);
    expect(built?.endsWith(join("engine", "java"))).toBe(true);
  });
  it("hints at the JDK requirement when a tool is missing", () => {
    const hint = missingJdkHint("javac");
    expect(hint).toContain("javac");
    expect(hint).toMatch(/JDK >= 21/);
    expect(hint).toMatch(/ATROPHY_JAVA_HOME/);
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
