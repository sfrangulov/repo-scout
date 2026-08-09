export type InterestBucket = "1-4" | "5-7" | "8-10";

// Contiguous partition of the 1-10 interest scale: every finite score
// (including fractional values like 4.5 or 7.3) falls into exactly one
// bucket. Used by scan.ts to sanity-check the model isn't drifting into a
// cluster between manual review passes.
export function bucketInterest(v: number): InterestBucket {
  if (v < 5) return "1-4";
  if (v < 8) return "5-7";
  return "8-10";
}
