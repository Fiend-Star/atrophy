import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees are created under .claude/worktrees/ inside the repo root;
// without this exclude, vitest crawls their duplicated *.test.ts copies and
// the main checkout's suite runs (and can fail on) sibling in-progress trees.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
