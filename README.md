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
pnpm review --min-interest 8
```

Following a user needs a one-time scope grant:
`gh auth refresh -h github.com -s user:follow` (the tool will tell you when).

## How it works

`scan`: for each query in `config.ts` → GitHub search (`sort=updated`,
`stars:minStars..maxStars fork:false archived:false`) → shallow clone →
digest (file list + snippets, README first) → one `claude -p` call returns
strict JSON `{idea, skill, interest, interest_reason, description,
security_flag, security_reason}` → SQLite (`data/scout.sqlite`, single
`entries` table).

`idea`/`skill` are generic engineering grades; `interest` is graded against
a personal interest profile baked into the prompt (`src/lib/evaluate.ts`) —
it's the primary ranking signal for review, since idea+skill barely
correlates with what actually gets starred.

Repos the model flags as malicious always enter the review queue,
regardless of score, shown last with a warning — the human still decides.
Repos that fail three times (or vanish) are parked as `failed`.

Each candidate card also shows repo context (stars, forks, license,
language, last push) and author context (followers, public repos), fetched
once when a repo is first found. This is display-only: it never filters,
skips, or auto-rejects anything. An author with very few followers and
repos gets a `THIN AUTHOR` attention flag on the card — empirically that
pattern matched junk/malware accounts in past scans — but it's a nudge to
look closer, not a verdict; the human still decides.

`review`: walks evaluated entries with `interest >= interestThreshold AND
skill >= minSkill` (plus every flagged repo, regardless of score), sorted
by `interest` first, `idea + skill` as a tiebreaker. Every action calls
`gh api` directly and is idempotent.

## Security notes

Grades are advisory, not a security verdict. A cloned repository's own
content — file names, README text, code comments — is untrusted input to
the model and can attempt prompt injection (text trying to talk the
grader into ignoring its instructions or inflating its own scores). The
interactive human review step is the real gate before any star or follow.
Symlinks are skipped while building the digest, so a malicious repo can't
use one to read or leak files outside its own clone.

## Development

```bash
pnpm test        # node:test, no network
pnpm typecheck   # tsc --noEmit
```

State lives in one SQLite file; delete `data/` to start over.
