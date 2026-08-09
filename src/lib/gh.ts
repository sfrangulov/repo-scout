import type { Runner } from "./run.ts";

export interface SearchItem {
  repo: string;
  ownerType: "User" | "Organization";
  stars: number;
  forks: number;
  pushedAt: string;
  license: string | null;
  language: string | null;
}

export interface AuthorMeta {
  followers: number;
  publicRepos: number;
  createdAt: string;
}

export interface ActionResult {
  ok: boolean;
  needsScope: boolean;
  message: string;
}

// -X GET is mandatory: with -f params gh silently switches to POST,
// and POST /search/repositories does not exist (404).
export function searchRepos(
  runner: Runner, query: string, minStars: number, maxStars: number,
): SearchItem[] {
  const res = runner("gh", [
    "api", "-X", "GET", "/search/repositories",
    "-f", `q=${query} stars:${minStars}..${maxStars} fork:false archived:false`,
    "-f", "sort=updated",
    "-f", "order=desc",
    "-F", "per_page=100",
  ]);
  if (res.status !== 0) {
    throw new Error(`gh search failed: ${res.stderr.slice(0, 300)}`);
  }
  const body = JSON.parse(res.stdout) as {
    items?: Array<{
      full_name?: string;
      owner?: { type?: string } | null;
      archived?: boolean;
      is_template?: boolean;
      stargazers_count?: number;
      forks_count?: number;
      pushed_at?: string;
      license?: { spdx_id?: string | null; key?: string | null } | null;
      language?: string | null;
    }>;
  };
  const out: SearchItem[] = [];
  for (const item of body.items ?? []) {
    const repo = item.full_name ?? "";
    if (!repo || !item.owner) continue;
    // Belt-and-braces beyond the query filters: the search payload includes
    // these fields, so skip anything that slipped through.
    if (item.archived === true || item.is_template === true) continue;
    out.push({
      repo,
      ownerType: item.owner.type === "Organization" ? "Organization" : "User",
      stars: item.stargazers_count ?? 0,
      forks: item.forks_count ?? 0,
      pushedAt: item.pushed_at ?? "",
      license: item.license?.spdx_id ?? item.license?.key ?? null,
      language: item.language ?? null,
    });
  }
  return out;
}

// Best-effort: author data is display-only, so a failed lookup returns null
// rather than throwing and aborting the scan.
export function fetchAuthor(runner: Runner, login: string): AuthorMeta | null {
  const res = runner("gh", ["api", "-X", "GET", `users/${login}`]);
  if (res.status !== 0) return null;
  try {
    const body = JSON.parse(res.stdout) as {
      followers?: number;
      public_repos?: number;
      created_at?: string;
    };
    if (
      typeof body.followers !== "number" ||
      typeof body.public_repos !== "number" ||
      typeof body.created_at !== "string"
    ) {
      return null;
    }
    return {
      followers: body.followers,
      publicRepos: body.public_repos,
      createdAt: body.created_at,
    };
  } catch {
    return null;
  }
}

// Values are interpolated into the endpoint: literal {owner}/{repo} would be
// substituted by gh itself from the cwd repository.
function putAction(runner: Runner, endpoint: string): ActionResult {
  const res = runner("gh", ["api", "-X", "PUT", endpoint]);
  if (res.status === 0) return { ok: true, needsScope: false, message: "" };
  return {
    ok: false,
    needsScope: res.stderr.includes("403"),
    message: res.stderr.trim().slice(0, 300),
  };
}

export function starRepo(runner: Runner, repo: string): ActionResult {
  return putAction(runner, `user/starred/${repo}`);
}

export function followUser(runner: Runner, profile: string): ActionResult {
  return putAction(runner, `user/following/${profile}`);
}

export function ensureGhReady(runner: Runner): void {
  const res = runner("gh", ["auth", "status"]);
  if (res.status !== 0) {
    throw new Error(
      `gh is not ready (install gh and run \`gh auth login\`): ${res.stderr.slice(0, 200)}`,
    );
  }
}
