# repo-scout

Find recently active, low-star GitHub repos on topics you care about,
grade them with a local `claude -p` call, then decide **yourself** in an
interactive CLI whether to star the repo or follow the author.

No automatic social actions — a human approves every star and follow.
(That is the deliberate difference from the follow-farming bots this idea
descends from: automated following/starring violates GitHub's Acceptable
Use Policies.)

## Requirements

- Node.js >= 24 (runs TypeScript natively, no build step)
- pnpm
- `git`, [`gh`](https://cli.github.com) (logged in), [`claude`](https://claude.com/claude-code) CLI
- macOS `open` for the [o]pen key (edit `src/review.ts` for Linux `xdg-open`)

## Usage

```bash
pnpm install
# edit config.ts: queries, thresholds, model
pnpm scan            # search GitHub, clone, grade with claude
pnpm review          # interactive: [s]tar [f]ollow [b]oth [o]pen [n]ext [q]uit
pnpm review --min-score 10
```

Following a user needs a one-time scope grant:
`gh auth refresh -h github.com -s user:follow` (the tool will tell you when).

## How it works

`scan`: for each query in `config.ts` → GitHub search (`sort=updated`,
`stars:<maxStars`) → shallow clone → digest (file list + snippets, README
first) → one `claude -p` call returns strict JSON
`{idea, skill, description, security_flag, security_reason}` → SQLite
(`data/scout.sqlite`, single `entries` table).

Repos the model flags as malicious are shown last with a warning — the
human still decides. Repos that fail three times (or vanish) are parked
as `failed`.

`review`: walks evaluated entries with `idea + skill >= reviewThreshold`,
best first. Every action calls `gh api` directly and is idempotent.

## Development

```bash
pnpm test        # node:test, no network
pnpm typecheck   # tsc --noEmit
```

State lives in one SQLite file; delete `data/` to start over.
