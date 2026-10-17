import { defineContract, oc } from "kello/contract";
import * as v from "valibot";
import { intentArgs, jobStatus } from "../validation";
const base = oc.errors({ UNAUTHORIZED: {}, FORBIDDEN: {} });
export default defineContract(({ validators }) => ({
  list: base
    .input(v.strictObject({}))
    .output(
      v.array(
        v.strictObject({
          _id: validators.id("files"),
          intentId: v.pipe(v.string(), v.uuid()),
          bucket: v.string(),
          size: v.number(),
          contentType: v.string(),
          sha256: v.string(),
          summary: v.nullable(v.string()),
        }),
      ),
    )
    .live(),
  status: base.input(intentArgs).output(v.nullable(jobStatus)),
}));
