import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { exactRankFloat4 } from "../../../apps/kello/src/core/search/rank";

const exactValues = [
  { bits: "00000000", value: 0 },
  { bits: "00000001", value: 2 ** -149 },
  { bits: "00000002", value: 2 ** -148 },
  { bits: "007fffff", value: 2 ** -126 - 2 ** -149 },
  { bits: "00800000", value: 2 ** -126 },
  { bits: "3f000000", value: 0.5 },
  { bits: "3f000001", value: 0.5 + 2 ** -24 },
  { bits: "3f7fffff", value: 1 - 2 ** -24 },
  { bits: "3f800000", value: 1 },
];
const invalidRanks = [
  null,
  0,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  "",
  "0000000",
  "000000000",
  "0000000g",
  "3F000000",
  " 00000000",
  "00000000\n",
  "80000000",
  "80000001",
  "bf000000",
  "7fc00000",
  "7f800001",
  "7f800000",
  "ff800000",
  "3f800001",
  "7f7fffff",
];

describe("strict private float4 rank boundaries", () => {
  test.each(exactValues)("decodes $bits to an independent IEEE-754 value", ({ bits, value }) => {
    const decoded = v.parse(exactRankFloat4, bits);
    expect(decoded).toBe(value);
    expect(Object.is(decoded, -0)).toBe(false);
  });
  test.each(invalidRanks)("rejects rank boundary %j without coercion", (rank) => {
    expect(v.safeParse(exactRankFloat4, rank).success).toBe(false);
  });
});
