import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allGenerators } from "../bank/generators/index.js";
import { AXES, LANGUAGES, loadBank, type Axis, type Language } from "../bank/schema.js";
import { availableAxes } from "../engine/select.js";

/**
 * README's "The five skills" table (and the paragraphs around it) claims things about
 * what the built-in bank offers per axis and per --lang. It drifted out from under the
 * real selection behavior twice as languages were added (when Java landed, then SQL) because
 * nothing checked the table against the content it describes. This computes the same
 * facts from the built-in bank + generator registry on every run, so a third drift fails
 * loudly here instead of shipping silently.
 *
 * No README parsing (brittle) - the fixtures below are the contract. When a measured
 * fact changes, update BOTH the fixture and the README section named in the failure
 * message, together, in the same commit.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const bank = loadBank(join(here, "..", "bank", "exercises"));

// README describes what the bank can offer, not one reader's toolchain - a JDK-less
// reader still gets told Java content exists (`atrophy doctor` is what reports what a
// missing toolchain hides locally). Every fact below assumes every toolchain present.
const FULL_TOOLCHAIN = { jdk: true, bash: true };

/**
 * mirrors README's five-skills table — update BOTH together. One entry per axis: the
 * sorted set of exercise `kind`s a reader can be offered on that axis (the table's "The
 * drill" column), from the built-in bank across every language.
 */
const EXPECTED_AXIS_KINDS: Record<Axis, string[]> = {
  "syntax-recall": ["write", "write-harness"],
  debugging: ["fix"],
  "code-reading": ["predict-output"],
  "api-memory": ["cloze", "recall", "write-harness"],
  decomposition: ["outline", "write", "write-harness"],
};

/**
 * mirrors README's SQL paragraph (the "SQL drills (`--lang sql`)" paragraph, just below
 * the table) — update BOTH together. Axes where a `language: "sql"` exercise actually
 * exists in the built-in bank. Narrower than EXPECTED_AXES_BY_LANG.sql below, which also
 * counts language-agnostic content riding along under --lang sql.
 */
const EXPECTED_SQL_LANGUAGE_AXES: Axis[] = ["syntax-recall", "api-memory"];

/**
 * mirrors README's `--lang` row in the Command reference table — update BOTH together.
 * Axes reachable under each concrete --lang (full toolchain), via the real selection
 * engine. Proves the row's "language-agnostic drills still qualify" claim: decomposition
 * has no sql-tagged content at all (see EXPECTED_SQL_LANGUAGE_AXES above) but still shows
 * up under sql here, because its "any"-tagged outline drills qualify under every
 * language. shell is the pure case of that claim - the built-in bank ships no shell
 * content at all, so the only axes it reaches are the ones carrying "any" drills, and
 * the README row says so.
 */
const EXPECTED_AXES_BY_LANG: Record<Language, Axis[]> = {
  python: [...AXES],
  javascript: [...AXES],
  java: [...AXES],
  sql: ["syntax-recall", "api-memory", "decomposition"],
  shell: ["api-memory", "decomposition"],
};

/**
 * mirrors README's "Java ships on every skill - N static exercises plus M generator
 * families" sentence, just after the table — update BOTH together. "Every skill" is
 * pinned separately below (the counts alone don't prove per-axis coverage).
 */
const EXPECTED_JAVA_STATIC_COUNT = 22;
const EXPECTED_JAVA_GENERATOR_FAMILY_COUNT = 4;

describe("README claims vs. measured selection behavior", () => {
  it("§'The five skills' table: per-axis offerable kinds", () => {
    const measured: Record<Axis, Set<string>> = Object.fromEntries(
      AXES.map((axis) => [axis, new Set<string>()]),
    ) as Record<Axis, Set<string>>;
    for (const e of bank) measured[e.axis].add(e.kind);
    for (const g of allGenerators) measured[g.axis].add(g.kind);

    for (const axis of AXES) {
      expect(
        [...measured[axis]].sort(),
        `README.md §'The five skills' table, "${axis}" row is out of date`,
      ).toEqual(EXPECTED_AXIS_KINDS[axis]);
    }
  });

  it("§'The five skills' SQL paragraph: axes carrying language:\"sql\" content", () => {
    const measured = AXES.filter(
      (axis) =>
        bank.some((e) => e.axis === axis && e.language === "sql") ||
        allGenerators.some((g) => g.axis === axis && g.language === "sql"),
    );
    expect(
      measured,
      "README.md §'The five skills' SQL paragraph is out of date (a language:\"sql\" exercise landed on a new axis)",
    ).toEqual(EXPECTED_SQL_LANGUAGE_AXES);
  });

  it("§'Command reference' --lang row: axes reachable per language", () => {
    for (const lang of LANGUAGES) {
      expect(
        availableAxes(bank, lang, allGenerators, FULL_TOOLCHAIN),
        `README.md §'Command reference' --lang row is out of date for --lang ${lang}`,
      ).toEqual(EXPECTED_AXES_BY_LANG[lang]);
    }
  });

  it("§'The five skills' Java paragraph: static exercise and generator family counts", () => {
    const javaStatics = bank.filter((e) => e.language === "java").length;
    const javaGenFamilies = allGenerators.filter((g) => g.language === "java").length;
    expect(
      javaStatics,
      "README.md §'The five skills' Java paragraph static exercise count is out of date",
    ).toBe(EXPECTED_JAVA_STATIC_COUNT);
    expect(
      javaGenFamilies,
      "README.md §'The five skills' Java paragraph generator family count is out of date",
    ).toBe(EXPECTED_JAVA_GENERATOR_FAMILY_COUNT);
  });

  it("§'The five skills' Java paragraph: \"ships on every skill\" covers every axis", () => {
    // The counts above can hold steady while java content quietly drains off one axis -
    // this is the assertion that actually pins "every skill", which EXPECTED_AXES_BY_LANG.java
    // cannot: any-tagged content (dec-any-*, api-any-*) makes every axis reachable under
    // --lang java regardless of whether a java-tagged exercise exists there at all.
    const javaAxes = AXES.filter((axis) => bank.some((e) => e.axis === axis && e.language === "java"));
    expect(
      javaAxes,
      "README.md §'The five skills' Java paragraph: \"ships on every skill\" is out of date",
    ).toEqual([...AXES]);
  });
});
