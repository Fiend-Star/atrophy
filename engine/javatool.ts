import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Pinned JVM runtime flags: formatted output must not drift with the host's
 * locale or timezone, and file I/O is always UTF-8 (JEP 400 default is 18+,
 * but explicit beats implicit).
 */
export const JAVA_RUNTIME_FLAGS = [
  "-Dfile.encoding=UTF-8",
  "-Duser.language=en",
  "-Duser.country=US",
  "-Duser.timezone=UTC",
] as const;

/** Compile gets its own generous budget - compile time is not the user's fault. */
export const JAVA_COMPILE_TIMEOUT_MS = 30_000;

export const MIN_JDK_MAJOR = 21;

function jdkTool(tool: "java" | "javac", env: NodeJS.ProcessEnv): string {
  const home = env.ATROPHY_JAVA_HOME;
  if (!home) return tool;
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(home, "bin", `${tool}${suffix}`);
}

export function javaCommand(env: NodeJS.ProcessEnv = process.env): string {
  return jdkTool("java", env);
}

export function javacCommand(env: NodeJS.ProcessEnv = process.env): string {
  return jdkTool("javac", env);
}

export function missingJdkHint(cmd: string): string {
  return `${cmd} not found - Java drills need a JDK >= ${MIN_JDK_MAJOR} (Temurin recommended). Install one or set ATROPHY_JAVA_HOME.`;
}

/** "javac 21.0.9" or 'openjdk version "21.0.9" ...' -> 21 */
export function parseJavaMajor(versionOutput: string): number | null {
  const m = /(?:^|\s|")(\d+)\.\d+\.\d+/.exec(versionOutput);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** Dev layout: engine/java next to this file. Built: dist/engine -> ../../engine/java. */
export function javaResourceCandidates(): string[] {
  return [join(__dirname, "java"), join(__dirname, "..", "..", "engine", "java")];
}

export function javaResourceDir(): string {
  const found = javaResourceCandidates().find((c) => existsSync(c));
  if (!found) throw new Error("engine/java resources not found - broken install? (npm files must include engine/java)");
  return found;
}

let jdkProbe: boolean | undefined;

/** One cached probe per process: is a runnable javac available? */
export function hasJdk(): boolean {
  if (jdkProbe === undefined) {
    try {
      jdkProbe = spawnSync(javacCommand(), ["-version"], { timeout: 10_000, windowsHide: true }).status === 0;
    } catch {
      jdkProbe = false;
    }
  }
  return jdkProbe;
}
