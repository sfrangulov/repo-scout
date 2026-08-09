# repo-scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI tool that finds recently active low-star GitHub repos by topic, grades them with `claude -p`, and lets a human interactively decide star/follow/skip.

**Architecture:** Two entry points (`scan`, `review`) over one SQLite table. All external effects go through injectable subprocess runners (`git`, `gh`, `claude`), so pure logic is unit-testable without network. Spec: `docs/superpowers/specs/2026-08-09-repo-scout-design.md`.

**Tech Stack:** TypeScript on Node ≥ 24 (native type stripping, no build step), pnpm, `node:sqlite`, `node:test`, zero runtime dependencies.

## Global Constraints

- Node ≥ 24; `"engines": {"node": ">=24"}` in package.json.
- Zero runtime dependencies; devDependencies only `typescript` + `@types/node`.
- Erasable-syntax TypeScript only: no `enum`, no `namespace`, no parameter properties (`erasableSyntaxOnly` enforces).
- Local imports use explicit `.ts` extension (required by native type stripping).
- All npm scripts run node with `--no-warnings` (suppresses the `node:sqlite` experimental warning).
- All CLI output strings and code comments in English (public repo).
- Timestamps: UTC ISO-8601 via `new Date().toISOString()`.
- `gh api` calls that read: always `-X GET` explicitly (with `-f` params gh otherwise silently switches to POST → 404).
- Never call star/follow endpoints in tests — subprocess runners are faked.
- Commit after every task; messages in English, conventional prefixes (`feat:`, `test:`, `docs:`, `chore:`).

---

### Task 1: Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/lib/types.ts`, `config.ts`

**Interfaces:**
- Produces: `Config` type and the default config module every later task imports.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "repo-scout",
  "version": "0.1.0",
  "description": "Find, grade and manually star/follow interesting GitHub repos. Human in the loop.",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "scan": "node --no-warnings src/scan.ts",
    "review": "node --no-warnings src/review.ts",
    "test": "node --no-warnings --test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^25.7.0",
    "typescript": "^6.0.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["config.ts", "src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
data/
```

- [ ] **Step 4: Write src/lib/types.ts**

```ts
export interface Config {
  /** GitHub search queries; "stars:<maxStars>" is appended to each. */
  queries: string[];
  maxStars: number;
  /** Max new candidates taken from one query per scan run. */
  perQuery: number;
  /** Minimum idea+skill sum to show in review. */
  reviewThreshold: number;
  /** Model passed to `claude -p --model`. */
  model: string;
  /** SQLite path, relative to the project root. */
  dbPath: string;
}

export type EntryStatus = "new" | "evaluated" | "reviewed" | "failed";

export interface Entry {
  repo: string; // owner/name
  ownerType: "User" | "Organization";
  query: string;
  foundAt: string;
  evaluatedAt: string | null;
  idea: number | null;
  skill: number | null;
  description: string | null;
  securityFlag: boolean;
  securityReason: string;
  status: EntryStatus;
  failCount: number;
  starred: boolean;
  followed: boolean;
  reviewedAt: string | null;
}
```

- [ ] **Step 5: Write config.ts**

```ts
import type { Config } from "./src/lib/types.ts";

export default {
  queries: [
    "topic:mcp",
    "topic:claude-code",
    '"claude code" in:name,description',
    "topic:llm-agents",
    "topic:ai-agents language:typescript",
    "topic:rag language:typescript",
  ],
  maxStars: 200,
  perQuery: 10,
  reviewThreshold: 12,
  model: "haiku",
  dbPath: "data/scout.sqlite",
} satisfies Config;
```

- [ ] **Step 6: Install and verify**

Run: `pnpm install && pnpm typecheck`
Expected: lockfile created, typecheck exits 0.

Run: `node --no-warnings -e 'import("./config.ts").then(m => console.log(m.default.queries.length))'`
Expected: `6`

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/lib/types.ts config.ts pnpm-lock.yaml
git commit -m "chore: scaffold repo-scout (pnpm, tsconfig, config, types)"
```

---

### Task 2: Database layer (`db.ts`)

**Files:**
- Create: `src/lib/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `Entry`, `EntryStatus`, `Config` from `src/lib/types.ts`.
- Produces (all exported from `src/lib/db.ts`):
  - `openDb(dbPath: string): DatabaseSync` — resolves `dbPath` against the project root, `mkdir -p`s the parent dir, opens the DB, creates the table.
  - `profileOf(repo: string): string` — `"owner/name"` → `"owner"`.
  - `htmlUrl(repo: string): string` — `https://github.com/${repo}`.
  - `cloneUrl(repo: string): string` — `htmlUrl(repo) + ".git"`.
  - `insertNew(db, repo: string, ownerType: string, query: string): boolean` — INSERT OR IGNORE; true if the row was inserted.
  - `listNew(db): Entry[]` — status `new`, ordered by `found_at, repo`.
  - `saveEvaluation(db, repo: string, e: { idea: number; skill: number; description: string; securityFlag: boolean; securityReason: string }): void` — sets status `evaluated` + `evaluated_at`.
  - `recordFailure(db, repo: string, opts: { terminal: boolean }): void` — increments `fail_count`; sets status `failed` when `terminal` or `fail_count` reaches 3.
  - `reviewQueue(db, minScore: number): Entry[]` — status `evaluated`, `idea+skill >= minScore`, ordered `security_flag ASC, idea+skill DESC`.
  - `setStarred(db, repo: string): void`, `setFollowed(db, repo: string): void` — set the flag only (no status change).
  - `markReviewed(db, repo: string): void` — status `reviewed` + `reviewed_at`.
  - `stats(db, threshold: number): { total: number; new: number; evaluated: number; belowThreshold: number; reviewed: number; failed: number; starred: number; followed: number }`.

- [ ] **Step 1: Write the failing tests**

`test/db.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDb, profileOf, htmlUrl, cloneUrl, insertNew, listNew, saveEvaluation,
  recordFailure, reviewQueue, setStarred, setFollowed, markReviewed, stats,
} from "../src/lib/db.ts";

function memDb() {
  return openDb(":memory:");
}

test("derives profile and urls from the repo key", () => {
  assert.equal(profileOf("alice/tool"), "alice");
  assert.equal(htmlUrl("alice/tool"), "https://github.com/alice/tool");
  assert.equal(cloneUrl("alice/tool"), "https://github.com/alice/tool.git");
});

test("insertNew is idempotent by primary key", () => {
  const db = memDb();
  assert.equal(insertNew(db, "a/one", "User", "topic:mcp"), true);
  assert.equal(insertNew(db, "a/one", "User", "topic:rag"), false);
  const rows = listNew(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, "topic:mcp");
  assert.equal(rows[0].status, "new");
  assert.equal(rows[0].ownerType, "User");
});

test("saveEvaluation moves new -> evaluated", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q");
  saveEvaluation(db, "a/one", {
    idea: 8.2, skill: 7.5, description: "A tiny ORM.",
    securityFlag: false, securityReason: "",
  });
  assert.equal(listNew(db).length, 0);
  const q = reviewQueue(db, 12);
  assert.equal(q.length, 1);
  assert.equal(q[0].idea, 8.2);
  assert.ok(q[0].evaluatedAt);
});

test("recordFailure keeps status new until third failure", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q");
  recordFailure(db, "a/one", { terminal: false });
  recordFailure(db, "a/one", { terminal: false });
  assert.equal(listNew(db).length, 1);
  recordFailure(db, "a/one", { terminal: false });
  assert.equal(listNew(db).length, 0);
  assert.equal(stats(db, 12).failed, 1);
});

test("recordFailure terminal fails immediately", () => {
  const db = memDb();
  insertNew(db, "a/gone", "User", "q");
  recordFailure(db, "a/gone", { terminal: true });
  assert.equal(stats(db, 12).failed, 1);
});

test("reviewQueue filters by threshold and sorts security-flagged last", () => {
  const db = memDb();
  for (const [repo, idea, skill, flag] of [
    ["a/low", 3, 3, false], ["a/mid", 7, 6, false],
    ["a/top", 9, 9, false], ["a/bad", 9.5, 9.5, true],
  ] as const) {
    insertNew(db, repo, "User", "q");
    saveEvaluation(db, repo, {
      idea, skill, description: "d", securityFlag: flag, securityReason: flag ? "steals keys" : "",
    });
  }
  const q = reviewQueue(db, 12);
  assert.deepEqual(q.map(e => e.repo), ["a/top", "a/mid", "a/bad"]);
  assert.equal(q[2].securityFlag, true);
});

test("review actions: flags persist without status change, markReviewed closes", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q");
  saveEvaluation(db, "a/one", {
    idea: 8, skill: 8, description: "d", securityFlag: false, securityReason: "",
  });
  setStarred(db, "a/one");
  assert.equal(reviewQueue(db, 12).length, 1); // still in queue after partial action
  markReviewed(db, "a/one");
  const s = stats(db, 12);
  assert.equal(s.reviewed, 1);
  assert.equal(s.starred, 1);
  assert.equal(reviewQueue(db, 12).length, 0);
  setFollowed(db, "a/one");
  assert.equal(stats(db, 12).followed, 1);
});

test("stats counts below-threshold evaluated rows", () => {
  const db = memDb();
  insertNew(db, "a/low", "User", "q");
  saveEvaluation(db, "a/low", {
    idea: 3, skill: 3, description: "d", securityFlag: false, securityReason: "",
  });
  insertNew(db, "a/new", "User", "q");
  const s = stats(db, 12);
  assert.equal(s.total, 2);
  assert.equal(s.new, 1);
  assert.equal(s.evaluated, 1);
  assert.equal(s.belowThreshold, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../src/lib/db.ts'`.

- [ ] **Step 3: Implement src/lib/db.ts**

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, EntryStatus } from "./types.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  repo            TEXT PRIMARY KEY,
  owner_type      TEXT NOT NULL,
  query           TEXT NOT NULL,
  found_at        TEXT NOT NULL,
  evaluated_at    TEXT,
  idea            REAL,
  skill           REAL,
  description     TEXT,
  security_flag   INTEGER NOT NULL DEFAULT 0,
  security_reason TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'new',
  fail_count      INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  followed        INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TEXT
)`;

export function openDb(dbPath: string): DatabaseSync {
  let path = dbPath;
  if (path !== ":memory:") {
    path = isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function profileOf(repo: string): string {
  return repo.split("/")[0];
}

export function htmlUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

export function cloneUrl(repo: string): string {
  return `${htmlUrl(repo)}.git`;
}

function now(): string {
  return new Date().toISOString();
}

type Row = Record<string, unknown>;

function toEntry(row: Row): Entry {
  return {
    repo: row.repo as string,
    ownerType: row.owner_type as Entry["ownerType"],
    query: row.query as string,
    foundAt: row.found_at as string,
    evaluatedAt: (row.evaluated_at as string) ?? null,
    idea: (row.idea as number) ?? null,
    skill: (row.skill as number) ?? null,
    description: (row.description as string) ?? null,
    securityFlag: row.security_flag === 1,
    securityReason: row.security_reason as string,
    status: row.status as EntryStatus,
    failCount: row.fail_count as number,
    starred: row.starred === 1,
    followed: row.followed === 1,
    reviewedAt: (row.reviewed_at as string) ?? null,
  };
}

export function insertNew(
  db: DatabaseSync, repo: string, ownerType: string, query: string,
): boolean {
  const res = db
    .prepare("INSERT OR IGNORE INTO entries (repo, owner_type, query, found_at) VALUES (?, ?, ?, ?)")
    .run(repo, ownerType, query, now());
  return res.changes === 1;
}

export function listNew(db: DatabaseSync): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE status = 'new' ORDER BY found_at, repo")
    .all()
    .map(r => toEntry(r as Row));
}

export function saveEvaluation(
  db: DatabaseSync,
  repo: string,
  e: { idea: number; skill: number; description: string; securityFlag: boolean; securityReason: string },
): void {
  db.prepare(
    `UPDATE entries SET idea = ?, skill = ?, description = ?, security_flag = ?,
     security_reason = ?, status = 'evaluated', evaluated_at = ? WHERE repo = ?`,
  ).run(e.idea, e.skill, e.description, e.securityFlag ? 1 : 0, e.securityReason, now(), repo);
}

export function recordFailure(
  db: DatabaseSync, repo: string, opts: { terminal: boolean },
): void {
  db.prepare(
    `UPDATE entries SET fail_count = fail_count + 1,
     status = CASE WHEN ? = 1 OR fail_count + 1 >= 3 THEN 'failed' ELSE status END
     WHERE repo = ?`,
  ).run(opts.terminal ? 1 : 0, repo);
}

export function reviewQueue(db: DatabaseSync, minScore: number): Entry[] {
  return db
    .prepare(
      `SELECT * FROM entries WHERE status = 'evaluated' AND idea + skill >= ?
       ORDER BY security_flag ASC, idea + skill DESC`,
    )
    .all(minScore)
    .map(r => toEntry(r as Row));
}

export function setStarred(db: DatabaseSync, repo: string): void {
  db.prepare("UPDATE entries SET starred = 1 WHERE repo = ?").run(repo);
}

export function setFollowed(db: DatabaseSync, repo: string): void {
  db.prepare("UPDATE entries SET followed = 1 WHERE repo = ?").run(repo);
}

export function markReviewed(db: DatabaseSync, repo: string): void {
  db.prepare("UPDATE entries SET status = 'reviewed', reviewed_at = ? WHERE repo = ?")
    .run(now(), repo);
}

export function stats(db: DatabaseSync, threshold: number) {
  const one = (sql: string, ...params: Array<string | number>) =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    total: one("SELECT COUNT(*) n FROM entries"),
    new: one("SELECT COUNT(*) n FROM entries WHERE status = 'new'"),
    evaluated: one("SELECT COUNT(*) n FROM entries WHERE status = 'evaluated'"),
    belowThreshold: one(
      "SELECT COUNT(*) n FROM entries WHERE status = 'evaluated' AND idea + skill < ?", threshold),
    reviewed: one("SELECT COUNT(*) n FROM entries WHERE status = 'reviewed'"),
    failed: one("SELECT COUNT(*) n FROM entries WHERE status = 'failed'"),
    starred: one("SELECT COUNT(*) n FROM entries WHERE starred = 1"),
    followed: one("SELECT COUNT(*) n FROM entries WHERE followed = 1"),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: all db tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts test/db.test.ts
git commit -m "feat: sqlite layer with entry lifecycle and derived urls"
```

---

### Task 3: Digest builder (`digest.ts`)

**Files:**
- Create: `src/lib/digest.ts`
- Test: `test/digest.test.ts`

**Interfaces:**
- Produces (exported from `src/lib/digest.ts`):
  - `buildDigest(root: string): string` — walks `root`, returns `"FILES:\n  <path>\n..."` header plus `----- <path> -----\n<snippet>` blocks; returns `""` when no usable files.
  - Constants: `MAX_FILES = 20`, `MAX_LINES_PER_FILE = 80`, `MAX_CHARS_PER_FILE = 4000`, `MAX_TOTAL_CHARS = 40000`, `MAX_FILE_BYTES = 262144`.

- [ ] **Step 1: Write the failing tests**

`test/digest.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDigest, MAX_FILES } from "../src/lib/digest.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "scout-digest-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test("lists files and includes snippets, README first", t => {
  const root = fixture({
    "src/app.ts": "console.log(1);\n",
    "README.md": "# Hello\n",
    "zzz.py": "print(1)\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const d = buildDigest(root);
  assert.match(d, /^FILES:\n/);
  const readmeAt = d.indexOf("----- README.md -----");
  const appAt = d.indexOf("----- src/app.ts -----");
  assert.ok(readmeAt !== -1 && appAt !== -1 && readmeAt < appAt);
  assert.match(d, /# Hello/);
});

test("skips ignored dirs, unknown extensions and oversized files", t => {
  const root = fixture({
    "node_modules/dep/index.js": "ignored\n",
    ".git/config": "ignored\n",
    "image.png": "binary",
    "big.ts": "x".repeat(300_000),
    "ok.ts": "const a = 1;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const d = buildDigest(root);
  assert.match(d, /ok\.ts/);
  assert.doesNotMatch(d, /node_modules|\.git|image\.png|big\.ts/);
});

test("caps the number of files deterministically (alphabetical)", t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, "0")}.ts`] = "x\n";
  const root = fixture(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const d = buildDigest(root);
  const listed = [...d.matchAll(/^ {2}(\S+)$/gm)].map(m => m[1]);
  assert.equal(listed.length, MAX_FILES);
  assert.deepEqual(listed.slice(0, 2), ["f00.ts", "f01.ts"]);
});

test("returns empty string when nothing usable", t => {
  const root = fixture({ "photo.jpg": "x" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(buildDigest(root), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../src/lib/digest.ts'`.

- [ ] **Step 3: Implement src/lib/digest.ts**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MAX_FILES = 20;
export const MAX_LINES_PER_FILE = 80;
export const MAX_CHARS_PER_FILE = 4_000;
export const MAX_TOTAL_CHARS = 40_000;
export const MAX_FILE_BYTES = 262_144;

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "vendor", "target",
  "__pycache__", ".venv", "venv", ".next", ".idea", ".vscode",
]);

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".md",
  ".yaml", ".yml", ".toml", ".sh", ".sql",
]);

function walk(dir: string, root: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) walk(abs, root, acc);
      continue;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
    if (!EXTENSIONS.has(ext)) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    acc.push(relative(root, abs));
  }
}

function isReadme(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return base.toLowerCase().startsWith("readme");
}

export function buildDigest(root: string): string {
  const all: string[] = [];
  walk(root, root, all);
  all.sort((a, b) =>
    Number(isReadme(b)) - Number(isReadme(a)) || a.localeCompare(b));
  const files = all.slice(0, MAX_FILES);
  if (files.length === 0) return "";

  const lines = ["FILES:", ...files.map(f => `  ${f}`), ""];
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const snippet = text
      .split("\n")
      .slice(0, MAX_LINES_PER_FILE)
      .join("\n")
      .slice(0, MAX_CHARS_PER_FILE);
    const block = `\n----- ${rel} -----\n${snippet}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    lines.push(block);
    total += block.length;
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts test/digest.test.ts
git commit -m "feat: repo digest builder (file list + snippets, README first)"
```

---

### Task 4: Subprocess runner + evaluation (`run.ts`, `evaluate.ts`)

**Files:**
- Create: `src/lib/run.ts`, `src/lib/evaluate.ts`
- Test: `test/evaluate.test.ts`

Note: `run.ts` is a small addition to the spec's file list — the shared
subprocess seam used by `evaluate.ts`, `gh.ts` and `clone.ts`.

**Interfaces:**
- Produces (from `src/lib/run.ts`):
  - `interface RunResult { status: number | null; stdout: string; stderr: string }`
  - `type Runner = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => RunResult`
  - `run: Runner` — `spawnSync` wrapper, `encoding: "utf8"`, default timeout 180 000 ms; when the binary is missing, returns `status: null` with the error message in `stderr`.
- Produces (from `src/lib/evaluate.ts`):
  - `interface Evaluation { idea: number; skill: number; description: string; securityFlag: boolean; securityReason: string }`
  - `parseEvaluation(text: string): Evaluation` — throws `Error("no JSON object in model output: ...")` when no `{...}` found.
  - `buildPrompt(repo: string, digest: string): string`
  - `evaluateRepo(runner: Runner, model: string, repo: string, digest: string): Evaluation` — runs `claude -p --model <model>` with the prompt on stdin; throws on non-zero exit.

- [ ] **Step 1: Write the failing tests**

`test/evaluate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvaluation, buildPrompt, evaluateRepo } from "../src/lib/evaluate.ts";
import type { Runner } from "../src/lib/run.ts";

test("parses a clean JSON object", () => {
  const e = parseEvaluation(
    '{"idea": 8.5, "skill": 7, "description": "A tool.", "security_flag": false, "security_reason": ""}',
  );
  assert.deepEqual(e, {
    idea: 8.5, skill: 7, description: "A tool.", securityFlag: false, securityReason: "",
  });
});

test("extracts JSON surrounded by prose and clamps scores into [1,10]", () => {
  const e = parseEvaluation(
    'Sure! Here is the JSON:\n{"idea": 42, "skill": -3, "description": "d"}\nHope this helps.',
  );
  assert.equal(e.idea, 10);
  assert.equal(e.skill, 1);
});

test("coerces loose security_flag values and defaults the reason", () => {
  const flagged = parseEvaluation('{"idea": 1, "skill": 1, "description": "d", "security_flag": "true"}');
  assert.equal(flagged.securityFlag, true);
  assert.equal(flagged.securityReason, "flagged as malicious (no reason given)");
  const clean = parseEvaluation('{"idea": 5, "skill": 5, "description": "d", "security_flag": 0}');
  assert.equal(clean.securityFlag, false);
});

test("non-numeric scores fall back to 1.0", () => {
  const e = parseEvaluation('{"idea": "high", "skill": null, "description": "d"}');
  assert.equal(e.idea, 1);
  assert.equal(e.skill, 1);
});

test("throws when there is no JSON object", () => {
  assert.throws(() => parseEvaluation("I cannot help with that."), /no JSON object/);
});

test("buildPrompt embeds repo name and digest", () => {
  const p = buildPrompt("alice/tool", "FILES:\n  a.ts");
  assert.match(p, /alice\/tool/);
  assert.match(p, /FILES:/);
  assert.match(p, /STRICT JSON/);
});

test("evaluateRepo pipes prompt via stdin and parses stdout", () => {
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const fake: Runner = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    return {
      status: 0,
      stdout: '{"idea": 6, "skill": 6, "description": "ok", "security_flag": false, "security_reason": ""}',
      stderr: "",
    };
  };
  const e = evaluateRepo(fake, "haiku", "alice/tool", "FILES:\n  a.ts");
  assert.equal(e.idea, 6);
  assert.deepEqual(calls[0].args, ["-p", "--model", "haiku"]);
  assert.match(calls[0].input ?? "", /alice\/tool/);
});

test("evaluateRepo throws on non-zero exit", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "boom" });
  assert.throws(() => evaluateRepo(fake, "haiku", "a/b", "FILES:"), /claude failed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement src/lib/run.ts**

```ts
import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
) => RunResult;

export const run: Runner = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.error ? String(res.error) : (res.stderr ?? ""),
  };
};
```

- [ ] **Step 4: Implement src/lib/evaluate.ts**

```ts
import type { Runner } from "./run.ts";

export interface Evaluation {
  idea: number;
  skill: number;
  description: string;
  securityFlag: boolean;
  securityReason: string;
}

const PROMPT_HEADER = `You are a senior code reviewer. Below is a digest of a GitHub repository.
Return a STRICT JSON object with exactly these fields:
  "idea": float in [1.0, 10.0] grading the novelty and usefulness of the project idea,
  "skill": float in [1.0, 10.0] grading the engineering skill shown in the code,
  "security_flag": true only when the code is MALICIOUS (its purpose is to harm whoever runs it), else false,
  "security_reason": empty string, or one sentence naming the malicious behaviour and where it is,
  "description": one short English sentence summarizing what the repository does.
Grade anchors: 1 = trivial/junior, 5 = ordinary/middle, 9 = strong/senior.
MALICIOUS-BEHAVIOUR SCREEN (highest priority): set security_flag=true when the digest shows
credential / API-token / SSH-key / .env / browser-cookie harvesting sent off-host; file,
clipboard or environment exfiltration; obfuscated or base64/hex payloads run via
exec/eval/subprocess; install- or import-time code that fetches and runs remote code;
hardcoded command-and-control endpoints; typosquatting of a well-known project; or a tool
whose stated purpose is innocuous but which also reads secrets and phones home.
Clean, well-structured code does NOT lower suspicion — malware is often tidy; judge intent
from what the code does with data and the network. When flagged, set idea and skill to 1.0.
A risky-but-legitimate pattern (a deploy script fetching an official release, a documented
security tool) is NOT malicious.
Return ONLY the JSON object, no prose.`;

export function buildPrompt(repo: string, digest: string): string {
  return `${PROMPT_HEADER}\n\nRepository: ${repo}\n\nDigest:\n${digest}\n`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function toScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? clamp(n, 1, 10) : 1;
}

export function parseEvaluation(text: string): Evaluation {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(match[0]) as Record<string, unknown>;
  const rawFlag = data.security_flag;
  const flagged = typeof rawFlag === "string"
    ? ["true", "1", "yes"].includes(rawFlag.trim().toLowerCase())
    : Boolean(rawFlag);
  const reason = String(data.security_reason ?? "").trim().slice(0, 500);
  return {
    idea: toScore(data.idea),
    skill: toScore(data.skill),
    description: String(data.description ?? "").trim(),
    securityFlag: flagged,
    securityReason: flagged ? (reason || "flagged as malicious (no reason given)") : "",
  };
}

export function evaluateRepo(
  runner: Runner, model: string, repo: string, digest: string,
): Evaluation {
  const res = runner("claude", ["-p", "--model", model], {
    input: buildPrompt(repo, digest),
  });
  if (res.status !== 0) {
    throw new Error(`claude failed (status ${res.status}): ${res.stderr.slice(0, 300)}`);
  }
  return parseEvaluation(res.stdout);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/run.ts src/lib/evaluate.ts test/evaluate.test.ts
git commit -m "feat: claude -p evaluation with strict-JSON parsing and security screen"
```

---

### Task 5: GitHub API + clone wrappers (`gh.ts`, `clone.ts`)

**Files:**
- Create: `src/lib/gh.ts`, `src/lib/clone.ts`
- Test: `test/gh.test.ts`, `test/clone.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunResult` from `src/lib/run.ts`; `cloneUrl` from `src/lib/db.ts`.
- Produces (from `src/lib/gh.ts`):
  - `interface SearchItem { repo: string; ownerType: "User" | "Organization" }`
  - `searchRepos(runner: Runner, query: string, maxStars: number): SearchItem[]` — throws on gh failure.
  - `interface ActionResult { ok: boolean; needsScope: boolean; message: string }`
  - `starRepo(runner: Runner, repo: string): ActionResult`
  - `followUser(runner: Runner, profile: string): ActionResult` — `needsScope: true` when stderr contains `403`.
  - `ensureGhReady(runner: Runner): void` — throws unless `gh auth status` exits 0.
- Produces (from `src/lib/clone.ts`):
  - `interface CloneResult { ok: boolean; notFound: boolean; message: string }`
  - `cloneShallow(runner: Runner, repo: string, targetDir: string): CloneResult` — `notFound: true` on "repository not found"-style git errors.

- [ ] **Step 1: Write the failing tests**

`test/gh.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchRepos, starRepo, followUser, ensureGhReady } from "../src/lib/gh.ts";
import type { Runner } from "../src/lib/run.ts";

const searchPayload = JSON.stringify({
  items: [
    { full_name: "alice/tool", owner: { login: "alice", type: "User" } },
    { full_name: "acme/lib", owner: { login: "acme", type: "Organization" } },
    { full_name: "", owner: null },
  ],
});

test("searchRepos uses explicit GET and parses items", () => {
  let seen: string[] = [];
  const fake: Runner = (_cmd, args) => {
    seen = args;
    return { status: 0, stdout: searchPayload, stderr: "" };
  };
  const items = searchRepos(fake, "topic:mcp", 200);
  assert.deepEqual(items, [
    { repo: "alice/tool", ownerType: "User" },
    { repo: "acme/lib", ownerType: "Organization" },
  ]);
  assert.ok(seen.includes("-X"));
  assert.ok(seen.includes("GET"));
  assert.ok(seen.some(a => a.includes("topic:mcp stars:<200")));
});

test("searchRepos throws on gh failure", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "rate limited" });
  assert.throws(() => searchRepos(fake, "q", 200), /rate limited/);
});

test("starRepo interpolates the repo path (no gh placeholders)", () => {
  let endpoint = "";
  const fake: Runner = (_cmd, args) => {
    endpoint = args[args.length - 1];
    return { status: 0, stdout: "", stderr: "" };
  };
  const res = starRepo(fake, "alice/tool");
  assert.equal(res.ok, true);
  assert.equal(endpoint, "user/starred/alice/tool");
});

test("followUser maps 403 to needsScope", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "HTTP 403: forbidden" });
  const res = followUser(fake, "alice");
  assert.equal(res.ok, false);
  assert.equal(res.needsScope, true);
});

test("ensureGhReady throws when gh auth fails", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "not logged in" });
  assert.throws(() => ensureGhReady(fake), /gh is not ready/);
});
```

`test/clone.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneShallow } from "../src/lib/clone.ts";
import type { Runner } from "../src/lib/run.ts";

test("clones shallow and quiet from the derived url", () => {
  let seen: string[] = [];
  const fake: Runner = (_cmd, args) => {
    seen = args;
    return { status: 0, stdout: "", stderr: "" };
  };
  const res = cloneShallow(fake, "alice/tool", "/tmp/x");
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [
    "clone", "--depth", "1", "--quiet", "https://github.com/alice/tool.git", "/tmp/x",
  ]);
});

test("maps 'repository not found' to notFound", () => {
  const fake: Runner = () => ({
    status: 128, stdout: "",
    stderr: "fatal: repository 'https://github.com/a/b.git/' not found",
  });
  const res = cloneShallow(fake, "a/b", "/tmp/x");
  assert.equal(res.ok, false);
  assert.equal(res.notFound, true);
});

test("other git failures are not terminal", () => {
  const fake: Runner = () => ({ status: 128, stdout: "", stderr: "unable to access: timeout" });
  const res = cloneShallow(fake, "a/b", "/tmp/x");
  assert.equal(res.ok, false);
  assert.equal(res.notFound, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement src/lib/gh.ts**

```ts
import type { Runner } from "./run.ts";

export interface SearchItem {
  repo: string;
  ownerType: "User" | "Organization";
}

export interface ActionResult {
  ok: boolean;
  needsScope: boolean;
  message: string;
}

// -X GET is mandatory: with -f params gh silently switches to POST,
// and POST /search/repositories does not exist (404).
export function searchRepos(
  runner: Runner, query: string, maxStars: number,
): SearchItem[] {
  const res = runner("gh", [
    "api", "-X", "GET", "/search/repositories",
    "-f", `q=${query} stars:<${maxStars}`,
    "-f", "sort=updated",
    "-f", "order=desc",
    "-F", "per_page=100",
  ]);
  if (res.status !== 0) {
    throw new Error(`gh search failed: ${res.stderr.slice(0, 300)}`);
  }
  const body = JSON.parse(res.stdout) as {
    items?: Array<{ full_name?: string; owner?: { type?: string } | null }>;
  };
  const out: SearchItem[] = [];
  for (const item of body.items ?? []) {
    const repo = item.full_name ?? "";
    if (!repo || !item.owner) continue;
    out.push({
      repo,
      ownerType: item.owner.type === "Organization" ? "Organization" : "User",
    });
  }
  return out;
}

// Values are interpolated into the endpoint: literal {owner}/{repo} would be
// substituted by gh itself from the cwd repository.
function putAction(runner: Runner, endpoint: string): ActionResult {
  const res = runner("gh", ["api", "-X", "PUT", endpoint]);
  if (res.status === 0) return { ok: true, needsScope: false, message: "" };
  return {
    ok: false,
    needsScope: res.stderr.includes("403"),
    message: res.stderr.trim().slice(0, 300),
  };
}

export function starRepo(runner: Runner, repo: string): ActionResult {
  return putAction(runner, `user/starred/${repo}`);
}

export function followUser(runner: Runner, profile: string): ActionResult {
  return putAction(runner, `user/following/${profile}`);
}

export function ensureGhReady(runner: Runner): void {
  const res = runner("gh", ["auth", "status"]);
  if (res.status !== 0) {
    throw new Error(
      `gh is not ready (install gh and run \`gh auth login\`): ${res.stderr.slice(0, 200)}`,
    );
  }
}
```

- [ ] **Step 4: Implement src/lib/clone.ts**

```ts
import type { Runner } from "./run.ts";
import { cloneUrl } from "./db.ts";

export interface CloneResult {
  ok: boolean;
  notFound: boolean;
  message: string;
}

const NOT_FOUND_RE = /not found|does not exist|could not read from remote/i;

export function cloneShallow(
  runner: Runner, repo: string, targetDir: string,
): CloneResult {
  const res = runner("git", [
    "clone", "--depth", "1", "--quiet", cloneUrl(repo), targetDir,
  ]);
  if (res.status === 0) return { ok: true, notFound: false, message: "" };
  return {
    ok: false,
    notFound: NOT_FOUND_RE.test(res.stderr),
    message: res.stderr.trim().slice(0, 300),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gh.ts src/lib/clone.ts test/gh.test.ts test/clone.test.ts
git commit -m "feat: gh api and shallow-clone wrappers over injectable runner"
```

---

### Task 6: Scan entry point (`scan.ts`)

**Files:**
- Create: `src/scan.ts`

**Interfaces:**
- Consumes: `config.ts` default export; `openDb`, `insertNew`, `listNew`, `saveEvaluation`, `recordFailure`, `stats` from `db.ts`; `searchRepos`, `ensureGhReady` from `gh.ts`; `cloneShallow` from `clone.ts`; `buildDigest` from `digest.ts`; `evaluateRepo` from `evaluate.ts`; `run` from `run.ts`.
- Produces: the `pnpm scan` command. No exports.

- [ ] **Step 1: Implement src/scan.ts**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../config.ts";
import {
  openDb, insertNew, listNew, saveEvaluation, recordFailure, stats,
} from "./lib/db.ts";
import { searchRepos, ensureGhReady } from "./lib/gh.ts";
import { cloneShallow } from "./lib/clone.ts";
import { buildDigest } from "./lib/digest.ts";
import { evaluateRepo } from "./lib/evaluate.ts";
import { run } from "./lib/run.ts";

function ensureClaudeReady(): void {
  const res = run("claude", ["--version"]);
  if (res.status !== 0) {
    throw new Error(`claude CLI is not available: ${res.stderr.slice(0, 200)}`);
  }
}

function main(): void {
  ensureGhReady(run);
  ensureClaudeReady();
  const db = openDb(config.dbPath);

  let added = 0;
  for (const query of config.queries) {
    let items;
    try {
      items = searchRepos(run, query, config.maxStars);
    } catch (err) {
      console.warn(`search failed for "${query}": ${(err as Error).message}`);
      continue;
    }
    let taken = 0;
    for (const item of items) {
      if (taken >= config.perQuery) break;
      if (insertNew(db, item.repo, item.ownerType, query)) {
        taken += 1;
        added += 1;
      }
    }
    console.log(`query "${query}": +${taken} new`);
  }

  const pending = listNew(db);
  console.log(`evaluating ${pending.length} repos with model ${config.model}`);
  let evaluated = 0;
  let failed = 0;
  for (const [i, entry] of pending.entries()) {
    const label = `[${i + 1}/${pending.length}] ${entry.repo}`;
    const target = mkdtempSync(join(tmpdir(), "repo-scout-"));
    try {
      const cloned = cloneShallow(run, entry.repo, join(target, "repo"));
      if (!cloned.ok) {
        console.warn(`${label} clone failed: ${cloned.message}`);
        recordFailure(db, entry.repo, { terminal: cloned.notFound });
        failed += 1;
        continue;
      }
      const digest = buildDigest(join(target, "repo"));
      if (digest === "") {
        console.warn(`${label} no usable files — skipping evaluation`);
        recordFailure(db, entry.repo, { terminal: false });
        failed += 1;
        continue;
      }
      const e = evaluateRepo(run, config.model, entry.repo, digest);
      saveEvaluation(db, entry.repo, e);
      evaluated += 1;
      const flag = e.securityFlag ? `  SECURITY: ${e.securityReason}` : "";
      console.log(
        `${label} idea ${e.idea.toFixed(1)} skill ${e.skill.toFixed(1)}` +
        ` sum ${(e.idea + e.skill).toFixed(1)} — ${e.description}${flag}`,
      );
    } catch (err) {
      console.warn(`${label} evaluation failed: ${(err as Error).message}`);
      recordFailure(db, entry.repo, { terminal: false });
      failed += 1;
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }

  const s = stats(db, config.reviewThreshold);
  console.log(
    `done: +${added} found, ${evaluated} evaluated, ${failed} failed this run; ` +
    `queue: ${s.evaluated - s.belowThreshold} above threshold, ` +
    `${s.belowThreshold} below, ${s.new} pending, ${s.failed} failed total`,
  );
}

main();
```

- [ ] **Step 2: Verify quality gates**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (no new tests; existing suites and types must stay green).

- [ ] **Step 3: Smoke test against the real world**

Temporarily lower the volume — edit `config.ts` in the working tree to `perQuery: 2` and `queries: ["topic:claude-code"]`, then:

Run: `pnpm scan`
Expected: search line `query "topic:claude-code": +2 new`, two `[i/2] owner/repo idea X skill Y ...` progress lines (real claude calls), summary line. `data/scout.sqlite` created.

Inspect: `node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("data/scout.sqlite");console.log(db.prepare("select repo,status,idea,skill from entries").all())'`
Expected: two rows with status `evaluated` and numeric scores (or `new` with fail_count if a repo legitimately failed — rerun judgement applies).

Then revert `config.ts` to the committed version: `git checkout config.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/scan.ts
git commit -m "feat: scan entry point (search, clone, digest, evaluate)"
```

---

### Task 7: Review entry point (`review.ts`)

**Files:**
- Create: `src/review.ts`

**Interfaces:**
- Consumes: `config.ts`; `openDb`, `reviewQueue`, `setStarred`, `setFollowed`, `markReviewed`, `stats`, `profileOf`, `htmlUrl` from `db.ts`; `starRepo`, `followUser`, `ensureGhReady` from `gh.ts`; `run` from `run.ts`; `parseArgs` from `node:util`.
- Produces: the `pnpm review` command. No exports.

- [ ] **Step 1: Implement src/review.ts**

```ts
import { emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";
import config from "../config.ts";
import {
  openDb, reviewQueue, setStarred, setFollowed, markReviewed, stats,
  profileOf, htmlUrl,
} from "./lib/db.ts";
import { starRepo, followUser, ensureGhReady } from "./lib/gh.ts";
import { run } from "./lib/run.ts";
import type { Entry } from "./lib/types.ts";

function readKey(): Promise<string> {
  return new Promise(resolvePromise => {
    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      process.stdin.off("keypress", onKey);
      process.stdin.pause();
      if (key.ctrl && key.name === "c") resolvePromise("q");
      else resolvePromise(key.name ?? "");
    };
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
  });
}

function show(entry: Entry, index: number, total: number): void {
  const sum = (entry.idea ?? 0) + (entry.skill ?? 0);
  console.log("");
  console.log(
    `[${index + 1}/${total}] ${entry.repo}   idea ${entry.idea?.toFixed(1)}` +
    `  skill ${entry.skill?.toFixed(1)}  sum ${sum.toFixed(1)}   (query: ${entry.query})`,
  );
  console.log(`  ${entry.description ?? ""}`);
  if (entry.securityFlag) {
    console.log(`  SECURITY WARNING: ${entry.securityReason}`);
  }
  console.log(`  ${htmlUrl(entry.repo)}`);
  const canFollow = entry.ownerType === "User";
  console.log(canFollow
    ? "\n  [s]tar  [f]ollow  [b]oth  [o]pen  [n]ext  [q]uit"
    : "\n  [s]tar  [o]pen  [n]ext  [q]uit   (follow unavailable: organization)");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "min-score": { type: "string" } },
  });
  const minScore = values["min-score"] !== undefined
    ? Number(values["min-score"])
    : config.reviewThreshold;
  if (!Number.isFinite(minScore)) {
    console.error("--min-score must be a number");
    process.exit(2);
  }

  ensureGhReady(run);
  const db = openDb(config.dbPath);
  const queue = reviewQueue(db, minScore);

  if (queue.length === 0) {
    const s = stats(db, minScore);
    console.log(
      `queue is empty: ${s.belowThreshold} evaluated below ${minScore}` +
      ` (try --min-score), ${s.new} awaiting evaluation (run scan)`,
    );
    return;
  }

  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let index = 0;
  while (index < queue.length) {
    const entry = queue[index];
    show(entry, index, queue.length);
    const key = await readKey();

    const canFollow = entry.ownerType === "User";
    const star = (): boolean => {
      const res = starRepo(run, entry.repo);
      if (res.ok) { setStarred(db, entry.repo); console.log("  starred"); return true; }
      console.warn(`  star failed: ${res.message}`);
      return false;
    };
    const follow = (): boolean => {
      const res = followUser(run, profileOf(entry.repo));
      if (res.ok) { setFollowed(db, entry.repo); console.log("  followed"); return true; }
      if (res.needsScope) {
        console.warn("  follow needs an extra scope — run once: gh auth refresh -h github.com -s user:follow");
      } else {
        console.warn(`  follow failed: ${res.message}`);
      }
      return false;
    };

    if (key === "q") break;
    if (key === "o") {
      run("open", [htmlUrl(entry.repo)]);
      continue; // stay on the candidate
    }
    if (key === "n") {
      markReviewed(db, entry.repo);
      index += 1;
      continue;
    }
    if (key === "s") {
      if (star()) { markReviewed(db, entry.repo); index += 1; }
      continue;
    }
    if (key === "f" && canFollow) {
      if (follow()) { markReviewed(db, entry.repo); index += 1; }
      continue;
    }
    if (key === "b" && canFollow) {
      // Partial success keeps the entry open; repeating is safe (PUT is idempotent).
      if (star() && follow()) { markReviewed(db, entry.repo); index += 1; }
      continue;
    }
    // Unknown key: redraw the same candidate.
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  const s = stats(db, minScore);
  console.log(`\nreviewed ${s.reviewed} total; starred ${s.starred}, followed ${s.followed}`);
}

main();
```

- [ ] **Step 2: Verify quality gates**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test the empty state**

Run: `pnpm review --min-score 99`
Expected: `queue is empty: ... (try --min-score), ... awaiting evaluation (run scan)`, exit 0.

- [ ] **Step 4: Smoke test the interactive loop (no side effects)**

Run: `pnpm review --min-score 0` (uses rows from the Task 6 smoke scan). Press `o` (browser opens, candidate stays), then `n` (advances), then `q` (exits with summary). Do NOT press `s`/`f`/`b` during the smoke test.
Expected: candidate screens render with scores/description/url; `n` marks reviewed; summary line prints.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts
git commit -m "feat: interactive review loop (star/follow/skip, human in the loop)"
```

---

### Task 8: README, publish, hand over

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything; final quality gates.

- [ ] **Step 1: Write README.md**

```markdown
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
```

- [ ] **Step 2: Run all quality gates**

Run: `pnpm test && pnpm typecheck`
Expected: all suites PASS, typecheck clean.

- [ ] **Step 3: Commit README**

```bash
git add README.md
git commit -m "docs: README (usage, requirements, design summary)"
```

- [ ] **Step 4: Create the public GitHub repo and push**

User decision on 2026-08-09: repository is **public**.

```bash
gh repo create repo-scout --public --source . --description "Find, grade and manually star/follow interesting GitHub repos. Human in the loop." --push
git status
```

Expected: `origin` set, branch `main` pushed, working tree clean, "up to date with origin".

- [ ] **Step 5: Verify the published repo**

Run: `gh api repos/sfrangulov/repo-scout --jq '{name, visibility, default_branch}'`
Expected: `{"name":"repo-scout","visibility":"public","default_branch":"main"}`.
