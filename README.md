# ccskillstats

Which of your Claude Code skills actually fire?

```
$ ccskillstats
skill           runs  interactive  scheduled                 last
──────────────  ────  ───────────  ─────────  ────────────  ─────
triage-inbox      47            0         47  ████████████  today
research          18           18          0  █████·······    20d
daily-digest      14            4         10  ████········  today
release-notes     11            1         10  ███·········    30d
…
  most of your installed skills have never fired (ccskillstats --unused)
```

`interactive` / `scheduled` splits by *who* was in the loop when the skill
ran — a skill fired while you were watching vs. one fired from `sdk-cli`
(cron, launchd, CI). Mixing those up misreads a routine background job as
something you personally invoked.

## Install

```sh
npm install -g ccskillstats
```

Or run it once without installing: `npx ccskillstats`. To build from source:
`git clone https://github.com/sue738/ccskillstats.git && cd ccskillstats && npm link`.

Output is English by default; set `CCSKILLSTATS_LANG=ja` (or
`LANG=ja_JP.UTF-8`) for Japanese.

## How an invocation counts

Three unrelated shapes land in the transcript, all counted toward `runs`:

| shape | looks like | means |
|---|---|---|
| `tool` | the model calls the Skill tool | your **description** matched what the user wrote |
| `typed` | the user types `/name` | the user already **knew the name** |
| `auto` | an `attributionSkill` tag on the entry | fired by automation, not a live turn |

`--json` and the `--daily`/`--monthly` views break out `tool` and `typed`
individually; `auto` folds into the total (their sum can be less than
`runs` — the gap is `auto` invocations).

## What is not counted

The skill's name appearing in a transcript. Mentions are dominated by the agent
talking about the skill, grepping for it, or reading its `SKILL.md`. One skill
here appeared 1703 times in prose and tool arguments and had actually run
**once** — a naive `grep` inflates by three orders of magnitude.

## Usage

```
ccskillstats                 ranked table
ccskillstats --daily         per day
ccskillstats --monthly       per month
ccskillstats --unused        installed but never invoked
ccskillstats --xbar          one status line plus a dropdown of everything
ccskillstats --json          machine-readable

  --days N       only the last N days
  --top N        rows to show (default 15; --all for everything)
  --no-archive   skip ~/.cclogsall, read only live transcripts
  --commands     include built-in slash commands (/model, /login, …)
```

Reads `~/.claude/projects` and, when present, the `cclogsall` archive at
`~/.cclogsall/projects`, deduped by path so a session mirrored in both is
counted once. Zero dependencies, no network, no auth.

A file it can't read (permissions, corruption) is counted and reported, not
silently dropped — check the scan-summary line at the bottom of any view.

**A known limitation**: `--days` filters *after* reading every transcript in
full, live and archived — it does not skip files by date. On a large history
(thousands of transcripts) even a bounded query can take a minute or more.
`--no-archive` is the fast path — it skips the `cclogsall` archive entirely,
which is usually most of the file count.

## xbar

Symlink `bin/ccskillstats.js` into your xbar plugin directory with a refresh
suffix, or wrap it:

```sh
#!/bin/sh
# ccskillstats.30m.sh
exec ~/.local/bin/ccskillstats --xbar
```

The menu bar shows the top three; the dropdown lists every skill with its
interactive/scheduled split and how long since it last ran, then the
never-fired ones.

## A skill that never fires

Usually a description problem, not a dead feature. The name is matched from
natural language, so `--unused` is the input to rewriting a description — not a
delete list.

`--unused` compares against the skills found on disk under `~/.claude/skills`,
`~/.claude/plugins`, and `<project>/.claude/skills`. That inventory is
best-effort: skills bundled with the CLI ship inside the binary and have no
`SKILL.md` anywhere, so they can be invoked but never appear as "installed".
The inventory is never used to decide whether an invocation counts.

## Tests

```sh
npm test
```

Every case is a mistake this tool made against the real transcripts before it
was fixed — including a 749 MB session that `readFileSync(file, 'utf8')` could
not decode, whose invocations were being dropped with no error at all.

## Security & trust

A tool that inspects your sessions deserves maximum suspicion, so:

- **Zero dependencies, no postinstall, no build step** — read it first, it's short
- **Fully local** — nothing leaves your machine, no telemetry, no network calls
- **Read-only** — it never modifies a transcript or skill file
- Paranoid path: `git clone https://github.com/sue738/ccskillstats.git && node ccskillstats/bin/ccskillstats.js`

## License
MIT
