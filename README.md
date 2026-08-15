# Atrophy

**Are you getting worse at coding without AI? Atrophy tells you - with a number.**

[![CI](https://github.com/ashutosh-rath02/atrophy/actions/workflows/ci.yml/badge.svg)](https://github.com/ashutosh-rath02/atrophy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/atrophy.svg)](https://www.npmjs.com/package/atrophy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Atrophy is a command-line app that regularly hands you a small coding exercise
to solve **without any AI help** - no Copilot, no chat, just you and your
editor. It grades your solution automatically, keeps a skill rating for you
(like a chess Elo), and charts how that rating moves over the weeks. If AI
assistance is quietly eroding your ability to code unaided, the chart shows
you - before an interview, an outage, or a day without wifi does.

## How it works

1. **`atrophy baseline`** - once, ~25 minutes. Solve one exercise for each of
   five skills, AI off. This sets your starting ratings.
2. **`atrophy drill`** - 5-10 minutes, two or three times a week. One
   exercise, automatically picked from the skill you've neglected longest.
   Pass and your rating rises; fail and it falls.
3. **`atrophy serve`** - your dashboard. One curve per skill, plus the chart
   this tool exists for (more below).
4. **Once a month: `atrophy drill --ai-on`** - take one drill *with* your AI
   tools. Those scores are tracked separately, so the dashboard can show the
   gap between you-with-AI and you-alone.

## What a drill looks like

```text
$ atrophy drill

Binary search misses the edges  [debugging · python · tier 2]
────────────────────────────────────────────────────────────
binary_search(items, target) should return the index of target in the
sorted list items, or -1 if absent. It mysteriously fails for some
values that are clearly in the list. Find and fix the bug.
────────────────────────────────────────────────────────────
Edit: /tmp/atrophy-k3XoP1/solution.py

AI off. Soft limit 7 min - timer started.

[Enter] submit · [q] abandon >

✓ 6/6 tests passed in 214s

Score 1.00 · debugging rating 1222 → 1241 (+19)
```

The exercise opens in your own editor (`$EDITOR`). Grading runs your code
against hidden tests in a sandboxed subprocess. There's a soft time limit  - 
going over shrinks your score gradually, nothing explodes. If tests fail you
can keep fixing and resubmit; the clock just keeps running.

Not every skill is "write code against tests" - see the table below.

## The five skills

| Skill | The drill | Graded by |
|---|---|---|
| **Syntax recall** | Write a small function from a spec, one SQL `SELECT` against a fixture schema, or a concurrency primitive against its own harness | Hidden tests - for SQL, the rows the query returns; harness checks for the harness drills |
| **Debugging** | Working-looking code has one planted bug - find and fix it | Hidden tests |
| **Code reading** | Read a snippet, type exactly what it prints | Compared to the snippet's real output |
| **API memory** | Fill in the blanked-out stdlib call, implement the API against a shipped harness, or answer a short recall question testing a general fact. Packs can add a multi-blank snippet scored one point per blank | Answer match, or harness checks |
| **Decomposition** | Outline a design (rate limiter, folder sync…) in bullets - or build it: an algorithm against tests, a data structure against its own harness | Self-scored against a revealed rubric; the build drills by tests or harness checks |

The built-in bank spans Python, JavaScript, Java and SQL across three tiers -
a hand-written static bank plus **generator families that render endless fresh
variants** (randomized data, names, and twists; same seed always reproduces
the same exercise). Difficulty targets *you*: each drill picks the tier where
your predicted success is closest to ~65%, the point where a rep carries the
most information. Comfortable wins teach the rating nothing.

Java drills are graded too (`--lang java`, needs a JDK - see Install), and
they add one more kind: a **behavioral** drill where the exercise ships its
own Java test harness, so it can grade concurrency - races, deadlocks,
visibility - instead of a return value. Java ships on every skill - 22 static
exercises plus four generator families - and you can add more of your own as
a pack (see Packs).

SQL drills (`--lang sql`) need no toolchain at all. The syntax-recall ones
have you submit a single `SELECT`, which runs against the exercise's own
fixture schema inside the bundled SQLite that already stores your ratings:
each exercise carries several cases with different fixtures, and grading
compares the rows your query returns to the expected rows case by case - so a
query that hardcodes one case's answer scores exactly that one case. `--lang
sql` also reaches a recall question on the API memory axis, graded the same
numeric-tolerant answer match as any other recall drill.

## The dashboard

```sh
atrophy serve   # http://127.0.0.1:4646
```

**[Try the live demo →](https://ashutosh-rath02.github.io/atrophy/)** (synthetic data)

![Atrophy dashboard: five skill curves with confidence bands, and the unaided-vs-AI-assisted score chart](docs/assets/atrophy-dashboard.gif)

How to read it:

- **The line** is your skill rating. It only moves when you actually take a
  drill - no evidence, no movement.
- **The shaded band** around the line is confidence. Skip practicing for a
  few weeks and the band visibly widens: the tool isn't claiming you got
  worse, it's admitting it no longer knows you're still good. One drill
  snaps it tight again.
- **"Unaided vs AI-assisted"** plots every drill score in two colors: your
  solo reps in blue, your monthly with-AI reps in green. If the blue line
  sinks while the green line stays perfect, that growing gap is your
  dependence, measured. This chart is the reason the tool exists.

## Why take this seriously

The pattern is documented across professions, and it comes with no internal
warning signal - people consistently feel fine while measurably declining:

- Doctors' unaided polyp-detection rates fell **28% → 22%** within months of
  routine AI assistance ([*The Lancet* G&H, 2025](https://www.thelancet.com/journals/langas/article/PIIS2468-1253(25)00133-5/abstract))
- Students with GPT-4 scored **17% worse** than peers once it was taken away
  ([*PNAS*, 2025](https://www.pnas.org/doi/10.1073/pnas.2422633122))
- Experienced developers using AI were **19% slower** - while believing they
  were 20% faster ([METR RCT, 2025](https://arxiv.org/abs/2507.09089))
- Engineers who used AI to write code scored **17% lower** on understanding
  that same code - debugging suffered most ([Anthropic, 2026](https://www.anthropic.com/research/AI-assistance-coding-skills))

Full citations and an honest discussion of what this tool can and can't
measure: [docs/research.md](docs/research.md).

## Install

Requires Node.js ≥ 22. Python 3 on `PATH` grades the Python exercises; a JDK
≥ 21 (Temurin recommended) grades the Java ones. A drill can only be graded
if its language's toolchain is installed, so install whichever you plan to
practise - `atrophy doctor` reports what it found. SQL is the exception and
needs nothing installed: it grades on the SQLite the package already bundles.
On Windows, if the `javac` on your `PATH` is a `.cmd`/`.bat` shim (some
version managers install one), point `ATROPHY_JAVA_HOME` at the JDK directory
instead: grading runs the toolchain without a shell, which cannot execute
shims.

```sh
npm install -g atrophy
atrophy baseline
```

## Command reference

| Command | What it does |
|---|---|
| `atrophy baseline` | First session: one drill per skill (~25 min) |
| `atrophy drill` | One drill on your most-neglected skill |
| `atrophy drill --axis debugging` | Drill a specific skill (`syntax-recall`, `debugging`, `code-reading`, `api-memory`, `decomposition`) |
| `atrophy drill --lang python` | Restrict to Python (or `javascript`, `java`, `sql`) - language-agnostic drills still qualify, so a rep may come back in no language at all; packs may add drills that declare no language, and those qualify too |
| `atrophy drill --ai-on` | Monthly comparison rep with AI allowed |
| `atrophy publish --handle you` | Opt in to the [public leaderboard](https://ashutosh-rath02.github.io/atrophy/leaderboard.html); afterwards every drill syncs automatically (`--stop` opts out) |
| `atrophy stats` | Ratings table and week streak in the terminal |
| `atrophy doctor` | Check your setup: runtimes, editor, sandbox, bank, packs |
| `atrophy serve` | Dashboard at `127.0.0.1:4646` |
| `atrophy export -o out.json` | Dump all your data as JSON |

## Your data

One SQLite file at `~/.atrophy/atrophy.db`, owned by you. No account, no
sync, no telemetry, nothing leaves your machine. `ATROPHY_DB` overrides the
location if you want it in a dotfiles repo or synced folder.

### Packs

A pack is a directory of exercise JSON files that merges with the built-in
bank - your team's interview questions, the Java drills you wrote, whatever
you want in the rotation. Point at one either way:

```sh
export ATROPHY_PACKS=/path/to/pack   # several: ':'-separated (';' on Windows)
# or, in ~/.atrophy/config.json:
# { "packs": ["C:/path/to/pack"] }
```

Both sources are additive and de-duplicated; a directory that doesn't exist,
or an exercise id that collides with one already loaded, is an error you see
immediately rather than a drill that silently disappears. `atrophy doctor`
lists every pack it resolved and how many exercises each one loaded.

Packs are code that runs on your machine during grading - only add
directories you trust.

## Honest limitations

- Ten-minute drills are a **proxy** for real-world skill, not a clinical
  measurement - treat trends, not absolute numbers, as the signal.
- Drilling makes you better at drills. That's fine - the drill *is* the
  maintenance - but it's another reason the interesting number is the
  unaided-vs-AI gap, not your raw rating.
- "AI off" is an honor system, actively assisted: starting an unaided drill
  while a known AI assistant is running (Copilot, Cursor, Claude, Windsurf,
  Codeium, Tabnine, Ollama, LM Studio, ChatGPT, Aider) prints a warning that
  names it. Warned, never blocked - you'd only be cheating your own chart.

## Contributing & development

```sh
git clone https://github.com/ashutosh-rath02/atrophy.git
cd atrophy && npm install
npm run dev -- drill    # CLI from source
npm test                # 330+ tests, incl. real grading subprocesses
```

New exercises are the most welcome contribution: one JSON file under
`bank/exercises/<skill>/`, validated by `bank/schema.ts`. CI proves every
planted bug actually fails a test and every code-reading snippet runs
deterministically, so a broken exercise can't merge.

Java exercises are the same one-file flow (`"language": "java"`, with
`starterCode` a `public class Solution` and no `package` line). Behavioral
drills use `"kind": "write-harness"` or `"fix-harness"` and ship their own
`testCode` - a `public class Harness` with a `main` that prints the result
line - plus `totalChecks`, the number of checks that harness must report.
CI compiles every Java starter and holds the harness to that count.

SQL write exercises (`"language": "sql"`, `"kind": "write"`) carry `cases`
instead of `tests`: each case is a `fixture` of `CREATE`/`INSERT` statements
plus the `expectedRows` the answer must return. CI applies every fixture
twice to prove it builds the same database both times, and for each such
exercise it synthesizes the hardcoded-literal answer and requires that it
fail at least one case - a question one literal could answer cannot merge.

Roadmap: LLM-judged decomposition drills, more languages, spaced-repetition
scheduling (FSRS), per-axis leaderboards. More to be added soon.

## License

[MIT](LICENSE) © 2026 Ashutosh Rath
