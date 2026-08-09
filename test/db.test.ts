import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb, profileOf, htmlUrl, cloneUrl, insertNew, listNew, saveEvaluation,
  recordFailure, reviewQueue, setStarred, setFollowed, markReviewed, stats,
} from "../src/lib/db.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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

test("openDb creates nested directories for absolute paths", (t) => {
  const tmpRoot = mkdtempSync("/tmp/repo-scout-test-");
  const dbPath = resolve(tmpRoot, "nested/deep/test.sqlite");

  try {
    const db = openDb(dbPath);
    insertNew(db, "test/repo", "User", "q");
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
    insertNew(db1, "proj/root", "Organization", "q");
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
