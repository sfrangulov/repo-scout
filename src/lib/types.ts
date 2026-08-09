export interface Config {
  /** GitHub search queries; "stars:<minStars>..<maxStars>" is appended to each. */
  queries: string[];
  minStars: number;
  maxStars: number;
  /** Max new candidates taken from one query per scan run. */
  perQuery: number;
  /** Minimum personal-interest score to show in review. */
  interestThreshold: number;
  /** Minimum skill score to show in review. */
  minSkill: number;
  /** Model passed to `claude -p --model`. */
  model: string;
  /** SQLite path, relative to the project root. */
  dbPath: string;
}

export type EntryStatus = "new" | "evaluated" | "reviewed" | "failed";

export interface Entry {
  repo: string; // owner/name
  ownerType: "User" | "Organization";
  query: string;
  foundAt: string;
  evaluatedAt: string | null;
  idea: number | null;
  skill: number | null;
  interest: number | null;
  interestReason: string;
  description: string | null;
  securityFlag: boolean;
  securityReason: string;
  status: EntryStatus;
  failCount: number;
  starred: boolean;
  followed: boolean;
  reviewedAt: string | null;
  authorFollowers: number | null;
  authorPublicRepos: number | null;
  authorCreatedAt: string | null;
  repoStars: number | null;
  repoForks: number | null;
  repoPushedAt: string | null;
  repoLicense: string | null;
  repoLanguage: string | null;
}
