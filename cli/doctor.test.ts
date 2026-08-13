import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBank,
  checkDb,
  checkEditor,
  checkGrading,
  checkJava,
  checkNode,
  checkPacks,
  javaCheckResult,
} from "./doctor.js";

describe("checkNode", () => {
  it("passes on supported versions", () => {
    expect(checkNode("v22.18.0").status).toBe("pass");
    expect(checkNode("v24.0.0").status).toBe("pass");
  });
  it("fails below the minimum", () => {
    expect(checkNode("v18.20.0").status).toBe("fail");
  });
  it("warns on an unparseable version", () => {
    expect(checkNode("weird").status).toBe("warn");
  });
});

describe("checkEditor", () => {
  it("passes when an editor env var is set", () => {
    expect(checkEditor({ EDITOR: "vim" }, false).status).toBe("pass");
    expect(checkEditor({ ATROPHY_EDITOR: "code" }, false).detail).toContain("code");
  });
  it("prefers ATROPHY_EDITOR over the standard vars", () => {
    expect(checkEditor({ ATROPHY_EDITOR: "code", EDITOR: "vim" }, false).detail).toBe("code");
  });
  it("passes when VS Code is detected", () => {
    expect(checkEditor({}, true).status).toBe("pass");
  });
  it("warns when nothing is available", () => {
    expect(checkEditor({}, false).status).toBe("warn");
  });
});

describe("checkBank", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atrophy-doc-bank-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the directory is null", () => {
    expect(checkBank(null).status).toBe("fail");
  });
  it("reports why the bank could not be resolved when the caller knows", () => {
    const r = checkBank(null, 'pack directory not found: C:\\packs\\gone (check ATROPHY_PACKS / "packs" in cfg)');
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("pack directory not found");
    expect(r.detail).not.toContain("ATROPHY_BANK");
  });
  it("falls back to the generic hint when no error is supplied", () => {
    expect(checkBank(null, null).detail).toContain("ATROPHY_BANK");
  });
  it("fails when the directory is empty", () => {
    expect(checkBank(dir).status).toBe("fail");
  });
  it("passes when the bank has exercises", () => {
    writeFileSync(
      join(dir, "sr-py-001.json"),
      JSON.stringify({
        kind: "write",
        id: "sr-py-001",
        axis: "syntax-recall",
        tier: 1,
        title: "t",
        prompt: "p",
        softTimeLimitSeconds: 60,
        language: "python",
        functionName: "f",
        starterCode: "def f():\n    pass\n",
        tests: [{ args: [], expected: null }],
      }),
    );
    const r = checkBank(dir);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("1 exercises");
  });
});

describe("checkDb", () => {
  it("opens a fresh database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-doc-db-"));
    try {
      expect(checkDb(join(dir, "t.db")).status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkGrading", () => {
  it("passes the sandbox smoke test", async () => {
    expect((await checkGrading()).status).toBe("pass");
  });
});

describe("javaCheckResult", () => {
  it("passes a modern JDK and shows what it reported", () => {
    const r = javaCheckResult("javac", "javac 21.0.9");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("21.0.9");
  });
  it("warns below the minimum without failing the run", () => {
    const r = javaCheckResult("javac", "javac 17.0.10");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Java 17");
    expect(r.detail).toMatch(/>= 21/);
  });
  it("names a legacy 1.8 JDK the way humans do", () => {
    const r = javaCheckResult("javac", "javac 1.8.0_452");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Java 8");
    expect(r.detail).not.toMatch(/Java 1\b/);
  });
  it("passes an unparseable version rather than crying wolf", () => {
    expect(javaCheckResult("javac", "javac").status).toBe("pass");
  });
});

describe("checkJava", () => {
  it("returns a CheckResult and never throws", () => {
    const r = checkJava();
    expect(r.name).toBe("Java (JDK)");
    expect(["pass", "warn"]).toContain(r.status);
    if (r.status === "warn") expect(r.detail).toMatch(/JDK|ATROPHY_JAVA_HOME/);
  });
});

describe("checkPacks", () => {
  it("passes quietly with no packs", () => {
    expect(checkPacks([])).toEqual({ name: "Packs", status: "pass", detail: "no packs configured" });
  });
  it("counts exercises per pack and fails on a broken one", () => {
    const good = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
    writeFileSync(
      join(good, "ok.json"),
      JSON.stringify({
        id: "rec-any-101",
        kind: "recall",
        axis: "decomposition",
        language: "any",
        tier: 1,
        title: "t",
        prompt: "p",
        softTimeLimitSeconds: 60,
        acceptedAnswers: ["x"],
      }),
      "utf8",
    );
    const broken = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
    writeFileSync(join(broken, "bad.json"), "{nope", "utf8");
    try {
      expect(checkPacks([good]).status).toBe("pass");
      expect(checkPacks([good]).detail).toMatch(/1 exercise\b/);
      expect(checkPacks([good, broken]).status).toBe("fail");
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
  it("says a pack directory is missing instead of leaking ENOENT", () => {
    const gone = join(tmpdir(), "atrophy-pack-does-not-exist-9f3a1c");
    const r = checkPacks([gone]);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not found");
    expect(r.detail).not.toContain("ENOENT");
  });
});
