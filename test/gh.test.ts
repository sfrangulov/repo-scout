import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchRepos, starRepo, followUser, ensureGhReady, fetchAuthor,
} from "../src/lib/gh.ts";
import type { Runner } from "../src/lib/run.ts";

const searchPayload = JSON.stringify({
  items: [
    {
      full_name: "alice/tool", owner: { login: "alice", type: "User" },
      stargazers_count: 12, forks_count: 3, pushed_at: "2026-08-05T10:00:00Z",
      license: { spdx_id: "MIT", key: "mit" }, language: "TypeScript",
    },
    {
      full_name: "acme/lib", owner: { login: "acme", type: "Organization" },
      stargazers_count: 0, forks_count: 0, pushed_at: "2026-01-01T00:00:00Z",
      license: { spdx_id: null, key: "other" }, language: null,
    },
    { full_name: "", owner: null },
    {
      full_name: "junk/archived", owner: { login: "junk", type: "User" },
      archived: true, stargazers_count: 1, forks_count: 0, pushed_at: "2026-01-01T00:00:00Z",
      license: null, language: null,
    },
    {
      full_name: "junk/template", owner: { login: "junk", type: "User" },
      is_template: true, stargazers_count: 1, forks_count: 0, pushed_at: "2026-01-01T00:00:00Z",
      license: null, language: null,
    },
  ],
});

test("searchRepos uses explicit GET and parses items, including nested license fallback", () => {
  let seen: string[] = [];
  const fake: Runner = (_cmd, args) => {
    seen = args;
    return { status: 0, stdout: searchPayload, stderr: "" };
  };
  const items = searchRepos(fake, "topic:mcp", 2, 200);
  assert.deepEqual(items, [
    {
      repo: "alice/tool", ownerType: "User",
      stars: 12, forks: 3, pushedAt: "2026-08-05T10:00:00Z", license: "MIT", language: "TypeScript",
    },
    {
      repo: "acme/lib", ownerType: "Organization",
      stars: 0, forks: 0, pushedAt: "2026-01-01T00:00:00Z", license: "other", language: null,
    },
  ]);
  assert.ok(seen.includes("-X"));
  assert.ok(seen.includes("GET"));
  assert.ok(seen.some(a => a.includes("stars:2..200 fork:false archived:false")));
});

test("searchRepos skips archived and template repos even if the query filter lets them through", () => {
  const fake: Runner = () => ({ status: 0, stdout: searchPayload, stderr: "" });
  const items = searchRepos(fake, "topic:mcp", 2, 200);
  assert.ok(!items.some(i => i.repo === "junk/archived"));
  assert.ok(!items.some(i => i.repo === "junk/template"));
});

test("searchRepos throws on gh failure", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "rate limited" });
  assert.throws(() => searchRepos(fake, "q", 2, 200), /rate limited/);
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

test("fetchAuthor happy path: parses followers/public_repos/created_at and hits users/<login> interpolated", () => {
  let seen: string[] = [];
  const fake: Runner = (_cmd, args) => {
    seen = args;
    return {
      status: 0,
      stdout: JSON.stringify({ followers: 15, public_repos: 22, created_at: "2019-03-01T00:00:00Z" }),
      stderr: "",
    };
  };
  const meta = fetchAuthor(fake, "alice");
  assert.deepEqual(meta, { followers: 15, publicRepos: 22, createdAt: "2019-03-01T00:00:00Z" });
  assert.ok(seen.includes("-X"));
  assert.ok(seen.includes("GET"));
  assert.equal(seen[seen.length - 1], "users/alice");
  assert.ok(!seen.some(a => a.includes("{") || a.includes("}")), "endpoint must be interpolated, not a gh placeholder");
});

test("fetchAuthor returns null on gh failure, never throws", () => {
  const fake: Runner = () => ({ status: 1, stdout: "", stderr: "404 Not Found" });
  assert.equal(fetchAuthor(fake, "ghost"), null);
});

test("fetchAuthor returns null on unparsable JSON", () => {
  const fake: Runner = () => ({ status: 0, stdout: "not json", stderr: "" });
  assert.equal(fetchAuthor(fake, "alice"), null);
});

test("fetchAuthor returns null when expected fields are missing", () => {
  const fake: Runner = () => ({ status: 0, stdout: JSON.stringify({ followers: 15 }), stderr: "" });
  assert.equal(fetchAuthor(fake, "alice"), null);
});
