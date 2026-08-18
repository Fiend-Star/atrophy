import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBank,
  checkConfig,
  checkDb,
  checkEditor,
  checkGrading,
  checkJava,
  checkNode,
  checkPacks,
  checkSql,
  hiddenJavaNotice,
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

describe("checkSql", () => {
  it("passes and reports the engine's own SQLite version", () => {
    const r = checkSql();
    expect(r.name).toBe("SQL (SQLite)");
    expect(r.status).toBe("pass");
    // SQLite's version, not the npm package's, is what explains a grading difference
    // between two machines - and reading it from a real query is what proves the
    // native module loaded rather than merely resolved.
    expect(r.detail).toMatch(/SQLite \d+\.\d+\.\d+/);
  });
  it("warns rather than failing when the probe throws", () => {
    // sql needs no toolchain, so there is nothing here for a user to go install: a
    // doctor that exits 1 over its own probe sends them hunting for a phantom.
    const r = checkSql(() => {
      throw new Error("addon not loadable");
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("addon not loadable");
  });
  it("warns when the probe answers nothing", () => {
    expect(checkSql(() => "").status).toBe("warn");
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

describe("hiddenJavaNotice", () => {
  it("tells a --lang java user how much of the pool the missing JDK took", () => {
    const notice = hiddenJavaNotice(4, "syntax-recall", "java");
    expect(notice).toContain("4 java drill(s)");
    expect(notice).toContain("syntax-recall");
    expect(notice).toContain("doctor");
  });

  it("says nothing to a user who never asked for java", () => {
    // The drill still runs (python/js content is unaffected); mentioning hidden java
    // would be noise about drills this user never requested. An *empty* pool is a
    // different message, and drillOnce prints that one whatever the language.
    expect(hiddenJavaNotice(4, "syntax-recall", undefined)).toBeNull();
    expect(hiddenJavaNotice(4, "syntax-recall", "python")).toBeNull();
  });

  it("says nothing when the toolchain hid nothing", () => {
    expect(hiddenJavaNotice(0, "syntax-recall", "java")).toBeNull();
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
  it("says so when a pack path is a file, instead of leaking ENOTDIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
    const file = join(dir, "pack.json");
    writeFileSync(file, "{}", "utf8");
    try {
      const r = checkPacks([file]);
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("not a directory");
      expect(r.detail).not.toMatch(/ENOTDIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

describe("checkConfig", () => {
  // Config lives at $ATROPHY_CONFIG, resolved through an injected env - never the
  // real ~/.atrophy/config.json - and every temp dir is scratch, cleaned up after.
  let base: string;
  let configDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atrophy-doc-cfg-base-"));
    writeExercise(base, "sr-py-001");
    configDir = mkdtempSync(join(tmpdir(), "atrophy-doc-cfg-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  /** Writes a throwaway config file under the scratch config dir and returns an injectable env. */
  function envWithConfig(json: string): NodeJS.ProcessEnv {
    const file = join(configDir, "config.json");
    writeFileSync(file, json, "utf8");
    return { ATROPHY_CONFIG: file };
  }

  /** One valid, minimal python `write` exercise, same shape as the `base` fixture above. */
  function writeExercise(dir: string, id: string): void {
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        kind: "write",
        id,
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
  }

  it("reports 'all' for a clean config with no warning", () => {
    const r = checkConfig(base, [], envWithConfig("{}"));
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("languages: all");
    expect(r.detail).toContain("track: all");
    // the track table lists what was discovered, even with nothing configured
    expect(r.detail).toContain("base");
  });

  it("warns and names the language(s) validation dropped", () => {
    const r = checkConfig(base, [], envWithConfig(JSON.stringify({ languages: ["java", "cobol"] })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("cobol");
    // the valid entry still shows up in the normal languages line
    expect(r.detail).toContain("java");
  });

  it("warns and lists the discovered tracks when the configured track matches none", () => {
    const r = checkConfig(base, [], envWithConfig(JSON.stringify({ track: "nope" })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("nope");
    expect(r.detail).toContain("base");
  });

  it("reports the exact drill count for a track that matches a discovered pack", () => {
    const pack = mkdtempSync(join(tmpdir(), "atrophy-doc-cfg-pack-"));
    writeFileSync(join(pack, "pack.json"), JSON.stringify({ name: "aurora" }));
    writeExercise(pack, "sr-py-101"); // exactly one drill - pins the count in the assertion below
    try {
      const r = checkConfig(base, [pack], envWithConfig(JSON.stringify({ track: "aurora" })));
      expect(r.status).toBe("pass");
      expect(r.detail).toContain("track: aurora (1 drills)");
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  });

  it("warns and names every dir when the configured track name is claimed by more than one pack", () => {
    const packA = mkdtempSync(join(tmpdir(), "atrophy-doc-cfg-packA-"));
    const packB = mkdtempSync(join(tmpdir(), "atrophy-doc-cfg-packB-"));
    writeFileSync(join(packA, "pack.json"), JSON.stringify({ name: "aurora" }));
    writeFileSync(join(packB, "pack.json"), JSON.stringify({ name: "aurora" }));
    try {
      const r = checkConfig(base, [packA, packB], envWithConfig(JSON.stringify({ track: "aurora" })));
      expect(r.status).toBe("warn");
      expect(r.detail).toContain(packA);
      expect(r.detail).toContain(packB);
    } finally {
      rmSync(packA, { recursive: true, force: true });
      rmSync(packB, { recursive: true, force: true });
    }
  });
});
