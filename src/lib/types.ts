export interface Config {
  /** GitHub search queries; "stars:<maxStars>" is appended to each. */
  queries: string[];
  maxStars: number;
  /** Max new candidates taken from one query per scan run. */
  perQuery: number;
  /** Minimum idea+skill sum to show in review. */
  reviewThreshold: number;
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
  description: string | null;
  securityFlag: boolean;
  securityReason: string;
  status: EntryStatus;
  failCount: number;
  starred: boolean;
  followed: boolean;
  reviewedAt: string | null;
}
