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
