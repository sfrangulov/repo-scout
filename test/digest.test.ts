import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

test("skips file symlinks: no exfiltration of the link target", t => {
  const outsideDir = mkdtempSync(join(tmpdir(), "scout-outside-"));
  const secretPath = join(outsideDir, "id_rsa");
  writeFileSync(secretPath, "SUPER-SECRET-KEY-CONTENT\n");
  const root = fixture({ "ok.ts": "const a = 1;\n" });
  symlinkSync(secretPath, join(root, "README.md"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
  const d = buildDigest(root);
  assert.doesNotMatch(d, /SUPER-SECRET-KEY-CONTENT/);
  assert.doesNotMatch(d, /README\.md/);
});

test("skips directory symlinks and tolerates a self-referential loop", t => {
  const root = fixture({ "ok.ts": "const a = 1;\n" });
  symlinkSync(".", join(root, "loop"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => buildDigest(root));
});
