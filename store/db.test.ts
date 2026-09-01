import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_RATING, INITIAL_RD, MAX_RD } from "../engine/scoring.js";
import { Store } from "./db.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atrophy-db-"));
  store = new Store(join(dir, "test.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  it("returns pristine defaults for an unseen axis", () => {
    const r = store.getRating("debugging");
    expect(r).toMatchObject({ rating: INITIAL_RATING, rd: INITIAL_RD, reps: 0, tier: 1, updatedAt: null });
  });

  it("round-trips a rating", () => {
    store.saveRating("syntax-recall", { rating: 1234, rd: 200, reps: 3 }, 2);
    const r = store.getRating("syntax-recall");
    expect(r.rating).toBe(1234);
    expect(r.reps).toBe(3);
    expect(r.tier).toBe(2);
  });

  it("widens RD with idle time on read, never touching the rating", () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    store.saveRating("syntax-recall", { rating: 1300, rd: 60, reps: 5 }, 1, past);
    const r = store.getRating("syntax-recall");
    expect(r.rating).toBe(1300);
    expect(r.rd).toBeGreaterThan(60);
    expect(r.rd).toBeLessThanOrEqual(MAX_RD);
  });

  it("records and orders sessions, newest first", () => {
    const base = {
      exercise_id: "sr-py-001",
      axis: "syntax-recall",
      language: "python",
      tier: 1,
      mode: "ai-off" as const,
      passed: 5,
      total: 5,
      elapsed_seconds: 120,
      score: 1,
      rating_before: 1200,
      rating_after: 1216,
    };
    store.recordSession({ ...base, ts: "2026-07-01T10:00:00Z" });
    store.recordSession({ ...base, ts: "2026-07-03T10:00:00Z", exercise_id: "sr-py-002" });
    const recent = store.recentSessions("syntax-recall", 5);
    expect(recent.map((s) => s.exercise_id)).toEqual(["sr-py-002", "sr-py-001"]);
    expect(store.allSessions()).toHaveLength(2);
  });

  it("lists recent session languages most-recent-first, across axes, capped at n", () => {
    expect(store.recentSessionLanguages(6)).toEqual([]);

    const base = {
      exercise_id: "x",
      axis: "syntax-recall",
      tier: 1,
      mode: "ai-off" as const,
      passed: 1,
      total: 1,
      elapsed_seconds: 10,
      score: 1,
      rating_before: 1200,
      rating_after: 1216,
    };
    const days: [string, string][] = [
      ["2026-07-01T10:00:00Z", "python"],
      ["2026-07-02T10:00:00Z", "javascript"],
      ["2026-07-03T10:00:00Z", "java"],
      ["2026-07-04T10:00:00Z", "sql"],
      ["2026-07-05T10:00:00Z", "any"],
      ["2026-07-06T10:00:00Z", "java"],
      // the last two share a timestamp: insertion order (id) breaks the tie
      ["2026-07-07T10:00:00Z", "python"],
      ["2026-07-07T10:00:00Z", "java"],
    ];
    for (const [ts, language] of days) {
      store.recordSession({ ...base, ts, language, axis: language === "any" ? "decomposition" : "syntax-recall" });
    }

    expect(store.recentSessionLanguages(6)).toEqual(["java", "python", "java", "any", "sql", "java"]);
  });

  it("backs up to a re-openable copy, and clear empties the store", async () => {
    store.saveRating("debugging", { rating: 1300, rd: 100, reps: 4 }, 2);
    store.recordSession({
      ts: "2026-07-01T10:00:00Z",
      exercise_id: "x",
      axis: "debugging",
      language: "python",
      tier: 1,
      mode: "ai-off",
      passed: 1,
      total: 1,
      elapsed_seconds: 10,
      score: 1,
      rating_before: 1284,
      rating_after: 1300,
    });

    const dest = join(dir, "backup.db");
    await store.backupTo(dest);

    const copy = new Store(dest);
    expect(copy.allSessions()).toHaveLength(1);
    expect(copy.getRating("debugging").rating).toBe(1300);
    copy.close();

    store.clear();
    expect(store.allSessions()).toHaveLength(0);
    expect(store.getRating("debugging").reps).toBe(0);
  });
});
