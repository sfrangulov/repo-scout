import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb, profileOf, htmlUrl, cloneUrl, insertNew, listNew, saveEvaluation,
  recordFailure, reviewQueue, setStarred, setFollowed, markReviewed, stats,
  setAuthorMeta, isThinAuthor,
} from "../src/lib/db.ts";
import type { RepoMeta } from "../src/lib/db.ts";
import type { Entry } from "../src/lib/types.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Placeholder repo metadata for tests that don't care about its values.
const noMeta: RepoMeta = { stars: 0, forks: 0, pushedAt: "", license: null, language: null };

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
  assert.equal(insertNew(db, "a/one", "User", "topic:mcp", noMeta), true);
  assert.equal(insertNew(db, "a/one", "User", "topic:rag", noMeta), false);
  const rows = listNew(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, "topic:mcp");
  assert.equal(rows[0].status, "new");
  assert.equal(rows[0].ownerType, "User");
});

test("saveEvaluation moves new -> evaluated", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q", noMeta);
  saveEvaluation(db, "a/one", {
    idea: 8.2, skill: 7.5, interest: 8, interestReason: "matches the profile",
    description: "A tiny ORM.", securityFlag: false, securityReason: "",
  });
  assert.equal(listNew(db).length, 0);
  const q = reviewQueue(db, 6, 4);
  assert.equal(q.length, 1);
  assert.equal(q[0].idea, 8.2);
  assert.equal(q[0].interest, 8);
  assert.equal(q[0].interestReason, "matches the profile");
  assert.ok(q[0].evaluatedAt);
});

test("recordFailure keeps status new until third failure", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q", noMeta);
  recordFailure(db, "a/one", { terminal: false });
  recordFailure(db, "a/one", { terminal: false });
  assert.equal(listNew(db).length, 1);
  recordFailure(db, "a/one", { terminal: false });
  assert.equal(listNew(db).length, 0);
  assert.equal(stats(db, 6, 4).failed, 1);
});

test("recordFailure terminal fails immediately", () => {
  const db = memDb();
  insertNew(db, "a/gone", "User", "q", noMeta);
  recordFailure(db, "a/gone", { terminal: true });
  assert.equal(stats(db, 6, 4).failed, 1);
});

test("reviewQueue gates on interest+skill and sorts security-flagged last", () => {
  const db = memDb();
  for (const [repo, idea, skill, interest, flag] of [
    ["a/low", 3, 3, 2, false], ["a/mid", 7, 6, 7, false],
    ["a/top", 9, 9, 9, false], ["a/bad", 9.5, 9.5, 1, true],
  ] as const) {
    insertNew(db, repo, "User", "q", noMeta);
    saveEvaluation(db, repo, {
      idea, skill, interest, interestReason: flag ? "" : "fits",
      description: "d", securityFlag: flag, securityReason: flag ? "steals keys" : "",
    });
  }
  const q = reviewQueue(db, 6, 4);
  assert.deepEqual(q.map(e => e.repo), ["a/top", "a/mid", "a/bad"]);
  assert.equal(q[2].securityFlag, true);
});

test("reviewQueue always surfaces flagged repos even below the interest gate, sorted last", () => {
  const db = memDb();
  insertNew(db, "a/flagged-low", "User", "q", noMeta);
  saveEvaluation(db, "a/flagged-low", {
    idea: 4, skill: 4, interest: 1, interestReason: "",
    description: "d", securityFlag: true, securityReason: "steals keys",
  });
  insertNew(db, "a/clean-low", "User", "q", noMeta);
  saveEvaluation(db, "a/clean-low", {
    idea: 4, skill: 4, interest: 2, interestReason: "meh",
    description: "d", securityFlag: false, securityReason: "",
  });
  const q = reviewQueue(db, 6, 4);
  assert.deepEqual(q.map(e => e.repo), ["a/flagged-low"]);
  assert.equal(q[0].securityFlag, true);
  assert.equal(q[0].idea, 4);
  assert.equal(q[0].skill, 4);
});

test("reviewQueue: flagged entry below the interest gate still appears, sorted last", () => {
  const db = memDb();
  insertNew(db, "a/clean-good", "User", "q", noMeta);
  saveEvaluation(db, "a/clean-good", {
    idea: 8, skill: 8, interest: 9, interestReason: "great fit",
    description: "d", securityFlag: false, securityReason: "",
  });
  insertNew(db, "a/flagged-poor-fit", "User", "q", noMeta);
  saveEvaluation(db, "a/flagged-poor-fit", {
    idea: 2, skill: 2, interest: 1, interestReason: "",
    description: "d", securityFlag: true, securityReason: "phones home",
  });
  const q = reviewQueue(db, 6, 4);
  assert.deepEqual(q.map(e => e.repo), ["a/clean-good", "a/flagged-poor-fit"]);
  assert.equal(q[1].securityFlag, true);
});

test("reviewQueue excludes a clean entry with high interest but skill below minSkill", () => {
  const db = memDb();
  insertNew(db, "a/exciting-but-sloppy", "User", "q", noMeta);
  saveEvaluation(db, "a/exciting-but-sloppy", {
    idea: 9, skill: 2, interest: 9, interestReason: "exactly the profile",
    description: "d", securityFlag: false, securityReason: "",
  });
  const q = reviewQueue(db, 6, 4);
  assert.deepEqual(q, []);
});

test("review actions: flags persist without status change, markReviewed closes", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q", noMeta);
  saveEvaluation(db, "a/one", {
    idea: 8, skill: 8, interest: 8, interestReason: "fits",
    description: "d", securityFlag: false, securityReason: "",
  });
  setStarred(db, "a/one");
  assert.equal(reviewQueue(db, 6, 4).length, 1); // still in queue after partial action
  markReviewed(db, "a/one");
  const s = stats(db, 6, 4);
  assert.equal(s.reviewed, 1);
  assert.equal(s.starred, 1);
  assert.equal(reviewQueue(db, 6, 4).length, 0);
  setFollowed(db, "a/one");
  assert.equal(stats(db, 6, 4).followed, 1);
});

test("stats counts below-gate evaluated rows, including NULL interest", () => {
  const db = memDb();
  insertNew(db, "a/low", "User", "q", noMeta);
  saveEvaluation(db, "a/low", {
    idea: 3, skill: 3, interest: 2, interestReason: "",
    description: "d", securityFlag: false, securityReason: "",
  });
  insertNew(db, "a/new", "User", "q", noMeta);
  const s = stats(db, 6, 4);
  assert.equal(s.total, 2);
  assert.equal(s.new, 1);
  assert.equal(s.evaluated, 1);
  assert.equal(s.belowThreshold, 1);
});

test("migrate: opening a database created with the pre-interest/author-signal schema adds the new columns", () => {
  const tmpRoot = mkdtempSync("/tmp/repo-scout-test-");
  const dbPath = resolve(tmpRoot, "legacy.sqlite");
  try {
    const legacy = openDb(dbPath);
    legacy.exec("DROP TABLE entries");
    legacy.exec(`
      CREATE TABLE entries (
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
      )`);
    legacy.close();

    const db = openDb(dbPath);
    const columns = (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>)
      .map(c => c.name);
    assert.ok(columns.includes("interest"));
    assert.ok(columns.includes("interest_reason"));
    for (const col of [
      "author_followers", "author_public_repos", "author_created_at",
      "repo_stars", "repo_forks", "repo_pushed_at", "repo_license", "repo_language",
    ]) {
      assert.ok(columns.includes(col), `missing column ${col}`);
    }

    insertNew(db, "a/migrated", "User", "q", noMeta);
    saveEvaluation(db, "a/migrated", {
      idea: 6, skill: 6, interest: 7, interestReason: "post-migration insert",
      description: "d", securityFlag: false, securityReason: "",
    });
    const q = reviewQueue(db, 6, 4);
    assert.equal(q.length, 1);
    assert.equal(q[0].interest, 7);
    assert.equal(q[0].interestReason, "post-migration insert");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("openDb creates nested directories for absolute paths", (t) => {
  const tmpRoot = mkdtempSync("/tmp/repo-scout-test-");
  const dbPath = resolve(tmpRoot, "nested/deep/test.sqlite");

  try {
    const db = openDb(dbPath);
    insertNew(db, "test/repo", "User", "q", noMeta);
    const rows = listNew(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo, "test/repo");
    assert.ok(existsSync(dbPath), "database file should exist");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("openDb resolves relative paths against project root", (t) => {
  const testDir = `data/test-tmp-${process.pid}`;
  const dbPath = `${testDir}/test.sqlite`;

  try {
    // First open: insert data
    const db1 = openDb(dbPath);
    insertNew(db1, "proj/root", "Organization", "q", noMeta);
    const rows1 = listNew(db1);
    assert.equal(rows1.length, 1);
    assert.equal(rows1[0].repo, "proj/root");
    assert.equal(rows1[0].ownerType, "Organization");

    // Reopen: verify data persists (proves file was created and usable)
    const db2 = openDb(dbPath);
    const rows2 = listNew(db2);
    assert.equal(rows2.length, 1, "data should persist across openDb calls");
    assert.equal(rows2[0].repo, "proj/root");
  } finally {
    rmSync(resolve(PROJECT_ROOT, testDir), { recursive: true, force: true });
  }
});

test("insertNew stores repo metadata from the search result", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q", {
    stars: 12, forks: 3, pushedAt: "2026-08-05T10:00:00Z", license: "MIT", language: "TypeScript",
  });
  const rows = listNew(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repoStars, 12);
  assert.equal(rows[0].repoForks, 3);
  assert.equal(rows[0].repoPushedAt, "2026-08-05T10:00:00Z");
  assert.equal(rows[0].repoLicense, "MIT");
  assert.equal(rows[0].repoLanguage, "TypeScript");
});

test("insertNew leaves author fields NULL until setAuthorMeta is called; setAuthorMeta round-trips", () => {
  const db = memDb();
  insertNew(db, "a/one", "User", "q", noMeta);
  const before = listNew(db)[0];
  assert.equal(before.authorFollowers, null);
  assert.equal(before.authorPublicRepos, null);
  assert.equal(before.authorCreatedAt, null);

  setAuthorMeta(db, "a/one", { followers: 15, publicRepos: 22, createdAt: "2019-03-01T00:00:00Z" });
  const after = listNew(db)[0];
  assert.equal(after.authorFollowers, 15);
  assert.equal(after.authorPublicRepos, 22);
  assert.equal(after.authorCreatedAt, "2019-03-01T00:00:00Z");
});

test("isThinAuthor: boundary cases", () => {
  const base: Entry = {
    repo: "a/one", ownerType: "User", query: "q", foundAt: "", evaluatedAt: null,
    idea: null, skill: null, interest: null, interestReason: "", description: null,
    securityFlag: false, securityReason: "", status: "new", failCount: 0,
    starred: false, followed: false, reviewedAt: null,
    authorFollowers: null, authorPublicRepos: null, authorCreatedAt: null,
    repoStars: null, repoForks: null, repoPushedAt: null, repoLicense: null, repoLanguage: null,
  };

  // At the threshold (<=1 follower, <=5 repos): thin.
  assert.equal(isThinAuthor({ ...base, authorFollowers: 1, authorPublicRepos: 5 }), true);
  // One field over threshold: not thin.
  assert.equal(isThinAuthor({ ...base, authorFollowers: 2, authorPublicRepos: 5 }), false);
  assert.equal(isThinAuthor({ ...base, authorFollowers: 1, authorPublicRepos: 6 }), false);
  // Missing author data: never flagged (display-only, no data to judge).
  assert.equal(isThinAuthor({ ...base, authorFollowers: null, authorPublicRepos: 3 }), false);
  assert.equal(isThinAuthor({ ...base, authorFollowers: 0, authorPublicRepos: null }), false);
});
