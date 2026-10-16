import * as v from "valibot";
import { configValidator } from "../config/define-config";
import { quarantineBranchConnection } from "../deploy/neon/quarantine";
import { withDevelopmentConnection } from "./connection";
import type { DevelopmentConnectionOptions, DevelopmentDatabaseProvider } from "./connection";

/** Explicit database-only quarantine. Never called implicitly by development startup or synchronization. */
export async function quarantineDevelopmentDatabase(
  options: DevelopmentConnectionOptions,
  provider?: DevelopmentDatabaseProvider,
) {
  const config = v.parse(configValidator, options.config);
  return withDevelopmentConnection(
    { ...options, config },
    async (client, target) => {
      return quarantineBranchConnection(client, config.database.metadataNamespace, target, options.signal);
    },
    provider,
  );
}
