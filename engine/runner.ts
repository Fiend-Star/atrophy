import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra environment variables; a minimal base env is always provided. */
  env?: Record<string, string>;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Run a command in a subprocess with a hard timeout and capped output.
 * Grading runs untrusted-ish user code, so: no shell, no stdin, minimal env.
 * (Network isolation is not enforced in v1 - documented limitation.)
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
      // JVM (and others) resolve their temp dir from TEMP/TMP; without them Windows
      // falls back to C:\Windows, which is not writable for user processes.
      ...(process.platform === "win32" && process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.platform === "win32" && process.env.TMP ? { TMP: process.env.TMP } : {}),
      ...(process.env.PYTHONIOENCODING ? {} : { PYTHONIOENCODING: "utf-8" }),
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
      });
    });
  });
}
