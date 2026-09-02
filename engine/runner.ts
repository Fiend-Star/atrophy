import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** stdout hit MAX_OUTPUT_BYTES and further output was dropped - a mismatch downstream
   *  may be the cap, not the answer. */
  truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra environment variables; a minimal base env is always provided. */
  env?: Record<string, string>;
}

/** Output cap per stream; grader.ts imports this so its cap message and shell cap-stamp cannot drift. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Run a command in a subprocess with a hard timeout and capped output.
 * Grading runs untrusted-ish user code, so: no shell, no stdin, minimal env.
 * (Network isolation is not enforced in v1 - documented limitation.)
 * (On win32 the minimal env is hygiene, not a security boundary: libuv
 * force-inherits a fixed set of parent vars - USERPROFILE, USERNAME,
 * LOGONSERVER, HOMEPATH, ... - into every child whatever we pass as env.)
 */
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // PATH is needed to resolve interpreters; SystemRoot keeps Python happy on Windows.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      // The JVM resolves java.io.tmpdir from TMP, then TEMP (then USERPROFILE, then
      // the unwritable Windows dir). libuv's force-inherit above happens to cover
      // TEMP but not TMP; pass both explicitly rather than lean on that list.
      ...(process.platform === "win32" && process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.platform === "win32" && process.env.TMP ? { TMP: process.env.TMP } : {}),
      // Graded output must decode the same way everywhere, so the child always gets
      // an explicit encoding - it inherits nothing from us. The parent's choice wins.
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
      ...opts.env,
    };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        truncated: stdout.length >= MAX_OUTPUT_BYTES,
      });
    });
  });
}
