import * as v from "valibot";

/** Internal float4-bits-v1 boundary decoder; normalized ts_rank_cd(…, 32). */
export const exactRankFloat4 = v.pipe(
  v.string(),
  v.length(8),
  v.regex(/^[0-9a-f]{8}$/),
  v.transform((hex) => {
    const bytes = new Uint8Array(4);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return new DataView(bytes.buffer).getFloat32(0, false);
  }),
  // Float32 rounding can produce exactly 1; normalization excludes values above it.
  v.check(
    (rank) => Number.isFinite(rank) && rank >= 0 && !Object.is(rank, -0) && rank <= 1,
    "Invalid normalized float4 rank boundary",
  ),
);
