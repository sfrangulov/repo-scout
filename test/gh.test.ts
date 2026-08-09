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
  const items = searchRepos(fake, "topic:mcp", 2, 200);
  assert.deepEqual(items, [
    { repo: "alice/tool", ownerType: "User" },
    { repo: "acme/lib", ownerType: "Organization" },
  ]);
  assert.ok(seen.includes("-X"));
  assert.ok(seen.includes("GET"));
  assert.ok(seen.some(a => a.includes("stars:2..200 fork:false archived:false")));
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
