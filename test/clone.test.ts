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
