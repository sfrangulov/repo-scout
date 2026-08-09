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
  interest        REAL,
  interest_reason TEXT NOT NULL DEFAULT '',
  description     TEXT,
  security_flag   INTEGER NOT NULL DEFAULT 0,
  security_reason TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'new',
  fail_count      INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  followed        INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TEXT
)`;

// Guards existing databases created before the interest columns existed.
function migrate(db: DatabaseSync): void {
  const columns = (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>)
    .map(c => c.name);
  if (!columns.includes("interest")) {
    db.exec("ALTER TABLE entries ADD COLUMN interest REAL");
  }
  if (!columns.includes("interest_reason")) {
    db.exec("ALTER TABLE entries ADD COLUMN interest_reason TEXT NOT NULL DEFAULT ''");
  }
}

export function openDb(dbPath: string): DatabaseSync {
  let path = dbPath;
  if (path !== ":memory:") {
    path = isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
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
    interest: (row.interest as number) ?? null,
    interestReason: (row.interest_reason as string) ?? "",
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
  e: {
    idea: number; skill: number; interest: number; interestReason: string;
    description: string; securityFlag: boolean; securityReason: string;
  },
): void {
  db.prepare(
    `UPDATE entries SET idea = ?, skill = ?, interest = ?, interest_reason = ?, description = ?,
     security_flag = ?, security_reason = ?, status = 'evaluated', evaluated_at = ? WHERE repo = ?`,
  ).run(
    e.idea, e.skill, e.interest, e.interestReason, e.description,
    e.securityFlag ? 1 : 0, e.securityReason, now(), repo,
  );
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

export function reviewQueue(db: DatabaseSync, minInterest: number, minSkill: number): Entry[] {
  return db
    .prepare(
      `SELECT * FROM entries WHERE status = 'evaluated'
       AND (security_flag = 1 OR (interest >= ? AND skill >= ?))
       ORDER BY security_flag ASC, interest DESC, idea + skill DESC`,
    )
    .all(minInterest, minSkill)
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

export function stats(db: DatabaseSync, minInterest: number, minSkill: number) {
  const one = (sql: string, ...params: Array<string | number>) =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return {
    total: one("SELECT COUNT(*) n FROM entries"),
    new: one("SELECT COUNT(*) n FROM entries WHERE status = 'new'"),
    evaluated: one("SELECT COUNT(*) n FROM entries WHERE status = 'evaluated'"),
    belowThreshold: one(
      `SELECT COUNT(*) n FROM entries WHERE status = 'evaluated' AND security_flag = 0
       AND (interest IS NULL OR interest < ? OR skill < ?)`,
      minInterest, minSkill,
    ),
    reviewed: one("SELECT COUNT(*) n FROM entries WHERE status = 'reviewed'"),
    failed: one("SELECT COUNT(*) n FROM entries WHERE status = 'failed'"),
    starred: one("SELECT COUNT(*) n FROM entries WHERE starred = 1"),
    followed: one("SELECT COUNT(*) n FROM entries WHERE followed = 1"),
  };
}
