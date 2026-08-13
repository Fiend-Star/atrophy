import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  hasJdk,
  javaCommand,
  javacCommand,
  javaResourceCandidates,
  missingJdkHint,
  parseJavaMajor,
} from "./javatool.js";

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
