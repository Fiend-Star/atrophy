import { exerciseSchema, type Exercise } from "../schema.js";
import { pick, sample, type Rng } from "../../engine/rng.js";
import { CLOZE_LIMIT_BY_TIER, rngFor, type ExerciseGenerator } from "./types.js";

/**
 * API-memory cloze generator: a curated fact table (call + accepted answers)
 * rendered with randomized identifiers/data so repeats look fresh while the
 * tested fact stays hand-verified.
 */

interface ClozeFact {
  tier: 1 | 2 | 3;
  title: string;
  prompt: string;
  accepted: string[];
  /** Render the snippet; must contain ____ where the answer goes. */
  render(rng: Rng): string;
}

const WORD_POOLS = [
  ["banana", "fig", "apple", "kiwi"],
  ["delta", "io", "gamma", "mu"],
  ["stapler", "pen", "notebook"],
  ["turmeric", "salt", "cardamom"],
] as const;

const NAME_POOLS = ["items", "values", "entries", "records", "nums"] as const;

/** Java collection identifiers - plural, and never a java keyword. */
const JAVA_NAME_POOLS = ["names", "words", "tags", "labels"] as const;

/** Sampled when a java snippet needs small, distinct numbers. */
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function numList(rng: Rng, n: number, min = -9, max = 99): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(min + Math.floor(rng() * (max - min + 1)));
  return out;
}

/** `"a", "b", "c"` - the element list of a java String literal sequence. */
function javaStrings(words: readonly string[]): string {
  // The word pools are plain ASCII, where JSON and java string escaping agree.
  return words.map((w) => JSON.stringify(w)).join(", ");
}

const PY_FACTS: ClozeFact[] = [
  {
    tier: 1,
    title: "Sort by length",
    prompt: "Fill the blank so the words sort shortest-to-longest.",
    accepted: ["len"],
    render: (rng) => {
      const words = sample(rng, pick(rng, WORD_POOLS), 3);
      return `words = ${JSON.stringify(words)}\nresult = sorted(words, key=____)`;
    },
  },
  {
    tier: 1,
    title: "Glue the parts",
    prompt: "Fill the blank: one str method concatenates a list with a separator.",
    accepted: ["join"],
    render: (rng) => {
      const words = sample(rng, pick(rng, WORD_POOLS), 3);
      const sep = pick(rng, ["-", ", ", "/"]);
      return `parts = ${JSON.stringify(words)}\nslug = ${JSON.stringify(sep)}.____(parts)`;
    },
  },
  {
    tier: 1,
    title: "Index while you loop",
    prompt: "Fill the blank: the builtin that yields (index, item) pairs.",
    accepted: ["enumerate"],
    render: (rng) => {
      const name = pick(rng, NAME_POOLS);
      return `for i, item in ____(${name}):\n    print(i, item)`;
    },
  },
  {
    tier: 1,
    title: "Add them all",
    prompt: "Fill the blank: one builtin totals a list of numbers.",
    accepted: ["sum"],
    render: (rng) => {
      const name = pick(rng, NAME_POOLS);
      return `${name} = ${JSON.stringify(numList(rng, 4, 1, 30))}\ntotal = ____(${name})`;
    },
  },
  {
    tier: 2,
    title: "Count without KeyError",
    prompt: "Fill the blank: the dict method that makes this safe for unseen keys.",
    accepted: ["get"],
    render: (rng) => {
      const key = pick(rng, ["word", "tag", "label"]);
      return `counts = {}\nfor ${key} in ${key}s:\n    counts[${key}] = counts.____(${key}, 0) + 1`;
    },
  },
  {
    tier: 2,
    title: "Count everything at once",
    prompt: "Fill the blank - the same collections class goes in both blanks.",
    accepted: ["Counter"],
    render: (rng) => {
      const name = pick(rng, ["words", "tags", "events"]);
      return `from collections import ____\n\ncounts = ____(${name})\nprint(counts.most_common(2))`;
    },
  },
  {
    tier: 2,
    title: "Dedupe (order doesn't matter)",
    prompt: "Fill the blank: the builtin that removes duplicates (order not required).",
    accepted: ["set"],
    render: (rng) => {
      const words = pick(rng, WORD_POOLS);
      const dup = [...sample(rng, words, 3), words[0]];
      return `names = ${JSON.stringify(dup)}\nunique = list(____(names))`;
    },
  },
  {
    tier: 2,
    title: "Pair them up",
    prompt: "Fill the blank: the builtin that pairs two lists element-by-element.",
    accepted: ["zip"],
    render: (rng) => {
      const words = sample(rng, pick(rng, WORD_POOLS), 3);
      return `keys = ${JSON.stringify(words)}\nvals = ${JSON.stringify(numList(rng, 3, 1, 9))}\npairs = list(____(keys, vals))`;
    },
  },
  {
    tier: 3,
    title: "Memoize the classic",
    prompt: "Fill the blank - the same functools decorator (the one that accepts maxsize) goes in both blanks.",
    accepted: ["lru_cache"],
    render: () =>
      `from functools import ____\n\n@____(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)`,
  },
  {
    tier: 3,
    title: "All the digits",
    prompt: "Fill the blank - the same stdlib module goes in both blanks.",
    accepted: ["re"],
    render: (rng) => {
      const v = pick(rng, ["text", "line", "raw"]);
      return `import ____\n\nnumbers = ____.findall(r"\\d+", ${v})`;
    },
  },
  {
    tier: 3,
    title: "Whole file, one call",
    prompt: "Fill the blank: the pathlib method that returns a file's entire contents as str.",
    accepted: ["read_text"],
    render: (rng) => {
      const f = pick(rng, ["config", "notes", "data"]);
      return `from pathlib import Path\n\ncontent = Path("${f}.txt").____(encoding="utf-8")`;
    },
  },
];

const JS_FACTS: ClozeFact[] = [
  {
    tier: 1,
    title: "First match wins",
    prompt: "Fill the blank: the array method returning the first matching element (not its index).",
    accepted: ["find"],
    render: (rng) => {
      const nums = numList(rng, 4, -9, 9);
      return `const nums = ${JSON.stringify(nums)};\nconst firstNegative = nums.____((n) => n < 0);`;
    },
  },
  {
    tier: 1,
    title: "Transform each",
    prompt: "Fill the blank: the array method that transforms every element into a new array.",
    accepted: ["map"],
    render: (rng) => {
      const k = pick(rng, [2, 3, 10]);
      return `const nums = ${JSON.stringify(numList(rng, 4, 1, 9))};\nconst scaled = nums.____((n) => n * ${k});`;
    },
  },
  {
    tier: 1,
    title: "Keep the good ones",
    prompt: "Fill the blank: the array method that keeps only elements passing the test.",
    accepted: ["filter"],
    render: (rng) => {
      return `const nums = ${JSON.stringify(numList(rng, 5, -9, 9))};\nconst positives = nums.____((n) => n > 0);`;
    },
  },
  {
    tier: 2,
    title: "Fold to one value",
    prompt: "Fill the blank: the array method that folds everything into a single value.",
    accepted: ["reduce"],
    render: (rng) => {
      return `const nums = ${JSON.stringify(numList(rng, 4, 1, 20))};\nconst total = nums.____((acc, n) => acc + n, 0);`;
    },
  },
  {
    tier: 2,
    title: "Walk an object's pairs",
    prompt: "Fill the blank: the Object static method that yields [key, value] pairs.",
    accepted: ["entries"],
    render: (rng) => {
      const role = pick(rng, ["dev", "ops", "qa"]);
      return `const user = { name: "Asha", role: "${role}" };\nfor (const [key, value] of Object.____(user)) {\n  console.log(key, value);\n}`;
    },
  },
  {
    tier: 2,
    title: "Dedupe an array",
    prompt: "Fill the blank: the collection type that removes duplicates when spread.",
    accepted: ["Set"],
    render: (rng) => {
      const words = pick(rng, WORD_POOLS);
      const dup = [...sample(rng, words, 3), words[1]];
      return `const names = ${JSON.stringify(dup)};\nconst unique = [...new ____(names)];`;
    },
  },
  {
    tier: 2,
    title: "Any of them?",
    prompt: "Fill the blank: the array method answering \"does at least one element pass?\".",
    accepted: ["some"],
    render: (rng) => {
      const d = pick(rng, [2, 3, 5]);
      return `const nums = ${JSON.stringify(numList(rng, 4, 1, 30))};\nconst hasMultiple = nums.____((n) => n % ${d} === 0);`;
    },
  },
  {
    tier: 3,
    title: "Object from pairs",
    prompt: "Fill the blank: the Object static method that builds an object from [key, value] pairs.",
    accepted: ["fromEntries"],
    render: () => `const pairs = [["a", 1], ["b", 2]];\nconst obj = Object.____(pairs);`,
  },
  {
    tier: 3,
    title: "Wait for all of them",
    prompt: "Fill the blank: the Promise combinator that resolves when every promise resolves.",
    accepted: ["all"],
    render: (rng) => {
      const a = pick(rng, ["fetchUser", "loadConfig"]);
      return `const [user, posts] = await Promise.____([${a}(), fetchPosts()]);`;
    },
  },
  {
    tier: 3,
    title: "Pretty-print JSON",
    prompt: "Fill the blank: the JSON method that serializes with 2-space indentation.",
    accepted: ["stringify"],
    render: () => `const text = JSON.____(config, null, 2);`,
  },
];

/**
 * Java facts. Nothing here is compiled or run - cloze grading is exact-match on the
 * typed answer - so each prompt has to pin the intent tightly enough that only the
 * accepted forms fit, and `accepted` has to list every form the prompt admits
 * (a false "wrong" costs the user rating). The line drawn across this table: a
 * documented equivalence is accepted (Deque.push is specified as "equivalent to
 * addFirst"), a different method that merely coincides in effect is not
 * (offerFirst is the capacity-restricted insertion contract; Arrays.parallelSort
 * is a different execution contract) - those the prompt wording excludes.
 */
const JAVA_FACTS: ClozeFact[] = [
  {
    tier: 1,
    // Deliberately not the getOrDefault fact: static api-java-001 already teaches that
    // one at this tier with this identifier scheme, and selection treats a static and a
    // family as different families, so the pair could serve back-to-back. This is the
    // other side of api-java-001's own prompt ("unlike computeIfAbsent, stores nothing").
    title: "One list per key",
    prompt:
      "Fill the blank: the Map method that computes and stores the mapping on a key's first access and returns the existing one thereafter, so the .add() below always lands in a list the map is holding.",
    accepted: ["computeIfAbsent"],
    render: (rng) => {
      const item = pick(rng, ["tag", "label", "user"]);
      const map = `by${item[0]!.toUpperCase()}${item.slice(1)}`;
      return `Map<String, List<Integer>> ${map} = new HashMap<>();\nfor (int i = 0; i < ${item}s.length; i++) {\n    ${map}.____(${item}s[i], k -> new ArrayList<>()).add(scores[i]);\n}`;
    },
  },
  {
    tier: 1,
    title: "Sort ascending, in place",
    prompt: "Fill the blank: the Collections method that reorders the list in place into ascending natural order.",
    accepted: ["sort"],
    render: (rng) => {
      const name = pick(rng, JAVA_NAME_POOLS);
      const words = sample(rng, pick(rng, WORD_POOLS), 3);
      return `List<String> ${name} = new ArrayList<>(List.of(${javaStrings(words)}));\nCollections.____(${name});`;
    },
  },
  {
    tier: 1,
    title: "Glue the parts",
    prompt:
      "Fill the blank: the String static method that concatenates the parts into one string with a separator between them.",
    accepted: ["join"],
    render: (rng) => {
      const words = sample(rng, pick(rng, WORD_POOLS), 3);
      const sep = pick(rng, [", ", "-", " | "]);
      return `List<String> parts = List.of(${javaStrings(words)});\nString line = String.____(${JSON.stringify(sep)}, parts);`;
    },
  },
  {
    tier: 1,
    title: "Deque as a stack",
    prompt:
      "Fill the blank: this Deque is used as a stack - put n on the top with the void insert (not the boolean offer form), so the pop() below takes the value pushed last.",
    accepted: ["push", "addFirst"],
    render: (rng) => {
      // Distinct values: the `// top` comment is the hint that pop() returns the value
      // pushed last, and a repeat would let it read as "the largest" instead.
      const nums = sample(rng, DIGITS, 4);
      const last = nums[nums.length - 1]!;
      return `Deque<Integer> stack = new ArrayDeque<>();\nfor (int n : new int[] {${nums.join(", ")}}) {\n    stack.____(n);\n}\nint top = stack.pop();  // ${last}`;
    },
  },
  {
    tier: 2,
    title: "Transform every element",
    prompt: "Fill the blank: the Stream method that turns each element into a new value, one out for every one in.",
    accepted: ["map"],
    render: (rng) => {
      const name = pick(rng, ["nums", "values", "amounts"]);
      return `List<Integer> ${name} = List.of(${numList(rng, 4, 1, 20).join(", ")});\nList<Integer> doubled = ${name}.stream().____(n -> n * 2).toList();`;
    },
  },
  {
    tier: 2,
    title: "Count the evens",
    prompt:
      "Fill the blank: the Stream method that keeps only the elements passing the test, so count() sees every even value in the list.",
    accepted: ["filter"],
    render: (rng) => {
      const name = pick(rng, ["nums", "values", "readings"]);
      return `List<Integer> ${name} = List.of(${numList(rng, 5, 1, 40).join(", ")});\nlong evens = ${name}.stream().____(n -> n % 2 == 0).count();`;
    },
  },
  {
    tier: 2,
    title: "Tally in one call",
    prompt:
      "Fill the blank: the Map method that stores 1 on a key's first sighting and otherwise combines the stored value with 1 through Integer::sum - one call, no get and no null check.",
    accepted: ["merge"],
    render: (rng) => {
      const item = pick(rng, ["tag", "event", "word"]);
      return `Map<String, Integer> freq = new HashMap<>();\nfor (String ${item} : ${item}s) {\n    freq.____(${item}, 1, Integer::sum);\n}`;
    },
  },
  {
    tier: 2,
    title: "Sort rows by first column",
    prompt:
      "Fill the blank: the Arrays method that reorders rows in place, sequentially, using the comparator it is handed.",
    accepted: ["sort"],
    render: (rng) => {
      // Distinct keys, never already ascending: the sort has to visibly do something.
      const keys = sample(rng, DIGITS, 3);
      const rest = numList(rng, 3, 1, 9);
      if (keys[0]! < keys[1]! && keys[1]! < keys[2]!) keys.reverse();
      const rows = keys.map((k, i) => `{${k}, ${rest[i]}}`).join(", ");
      // Integer.compare, never `a[0] - b[0]`: the subtraction form overflows on wide
      // ints, and static api-java-004 teaches the correct ordering for these same
      // int[] rows. Ambient code in a drill is still code the user reads as approved.
      return `int[][] rows = {${rows}};\nArrays.____(rows, (a, b) -> Integer.compare(a[0], b[0]));`;
    },
  },
];

function makeClozeGenerator(
  family: string,
  language: "python" | "javascript" | "java",
  facts: ClozeFact[],
): ExerciseGenerator {
  const tiers = [...new Set(facts.map((f) => f.tier))].sort();
  return {
    family,
    axis: "api-memory",
    language,
    tiers,
    generate(seed, tier) {
      const rng = rngFor(family, seed, tier);
      const pool = facts.filter((f) => f.tier === tier);
      const fact = pick(rng, pool);
      const raw: unknown = {
        id: `${family}-${seed}`,
        kind: "cloze",
        axis: "api-memory",
        language,
        tier,
        title: fact.title,
        prompt: fact.prompt,
        softTimeLimitSeconds: CLOZE_LIMIT_BY_TIER[tier] ?? 90,
        snippet: fact.render(rng),
        acceptedAnswers: fact.accepted,
      };
      return exerciseSchema.parse(raw) as Exercise;
    },
  };
}

export const apiMemoryGenerators: ExerciseGenerator[] = [
  makeClozeGenerator("api-py-gen", "python", PY_FACTS),
  makeClozeGenerator("api-js-gen", "javascript", JS_FACTS),
  makeClozeGenerator("api-java-blank", "java", JAVA_FACTS),
];
