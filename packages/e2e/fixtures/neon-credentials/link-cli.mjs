// Stands in for the pinned Neon CLI. Records argv and whether the expected key arrived through the
// environment, without ever writing the key itself.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const context = args[args.indexOf("--context-file") + 1];
writeFileSync(
  process.env.KELLO_LINK_RECORD,
  JSON.stringify({
    args,
    keyFromEnvironment: process.env.NEON_API_KEY === process.env.KELLO_LINK_EXPECTED_KEY,
    profile: process.env.NEON_PROFILE ?? null,
    ci: process.env.CI,
  }),
);
writeFileSync(context, JSON.stringify({ projectId: args[args.indexOf("--project-id") + 1] }));
