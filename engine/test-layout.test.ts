import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Directories vitest must never crawl: its own defaults plus this repo's agent-worktree
 * homes. An agent worktree is a full copy of the repo, tests included, so a crawl into
 * one runs every test twice (observed as an exactly-doubled count) and can fail the main
 * checkout's suite on a sibling's in-progress tree. vitest.config.ts excludes the homes
 * we know about; this guard catches the next one before it doubles the suite.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".claude", ".worktrees"]);

/** The only top-level directories that hold this project's tests (tsconfig's `include`). */
const TEST_ROOTS = new Set(["bank", "cli", "engine", "store"]);

function testFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFilesUnder(full, out);
    else if (name.endsWith(".test.ts")) out.push(relative(repoRoot, full));
  }
  return out;
}

describe("test layout - nothing outside the known roots can be crawled", () => {
  it("finds every *.test.ts under bank/, cli/, engine/ or store/ - a new worktree home needs a vitest exclude", () => {
    const strays = testFilesUnder(repoRoot).filter((f) => !TEST_ROOTS.has(f.split(sep)[0]!));
    expect(strays, "stray test files: add their directory to vitest.config.ts's exclude and to SKIP_DIRS here").toEqual([]);
  });

  it("skips exactly the worktree homes vitest.config.ts excludes, so the two cannot drift", () => {
    const exclude = (vitestConfig as { test?: { exclude?: string[] } }).test?.exclude ?? [];
    for (const dir of [".claude", ".worktrees"]) {
      expect(exclude, `vitest.config.ts must exclude **/${dir}/**`).toContain(`**/${dir}/**`);
    }
  });
});
