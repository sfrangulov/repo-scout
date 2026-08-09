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
