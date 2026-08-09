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
