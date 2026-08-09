import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketInterest } from "../src/lib/histogram.ts";

test("bucketInterest partitions contiguously, including fractional scores", () => {
  assert.equal(bucketInterest(1), "1-4");
  assert.equal(bucketInterest(4), "1-4");
  assert.equal(bucketInterest(4.5), "1-4");
  assert.equal(bucketInterest(4.999), "1-4");
  assert.equal(bucketInterest(5), "5-7");
  assert.equal(bucketInterest(5.5), "5-7");
  assert.equal(bucketInterest(7), "5-7");
  assert.equal(bucketInterest(7.3), "5-7");
  assert.equal(bucketInterest(7.9), "5-7");
  assert.equal(bucketInterest(8), "8-10");
  assert.equal(bucketInterest(8.1), "8-10");
  assert.equal(bucketInterest(10), "8-10");
});
