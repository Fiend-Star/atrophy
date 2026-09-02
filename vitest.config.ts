import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees are created under .claude/worktrees/ or .worktrees/ inside the
// repo root; without these excludes, vitest crawls their duplicated *.test.ts
// copies and the main checkout's suite runs (and can fail on) sibling
// in-progress trees - observed as an exactly-doubled test count.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.worktrees/**"],
    /**
     * Vitest's own default is 5000 ms, which is too tight for this suite: most of it
     * spawns real python/node/java/bash subprocesses, and CI runs four legs in parallel.
     * Three CI failures have been the same signature - a test crossing 5000 ms under
     * worker starvation rather than doing slow work:
     *
     *   32206668792  ubuntu 22 + 24  engine/select.test.ts   (spawns nothing at all)
     *   32260374956  windows 22      engine/select.test.ts
     *   32315583650  windows 22      engine/grader.test.ts   (7052 ms for a 378 ms test)
     *
     * The first two predate any shell code, so this is a standing property of the suite
     * and not any one change's regression. Raised rather than tuned per test: the tests that
     * really are slow already declare their own budgets (the java and shell gates pass
     * 60_000-300_000), and those are unaffected - a per-test timeout still wins over this.
     */
    testTimeout: 15_000,
  },
});
