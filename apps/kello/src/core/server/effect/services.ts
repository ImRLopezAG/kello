import { Context } from "effect";
import type { AnyRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DatabaseSchema } from "../database/connection";
import type { SearchValidators } from "../../search/contract";
import type { SearchContext } from "../../search/executor";
import type { InvocationStorage } from "../storage/invocation";

import type { RpcScheduler } from "../jobs/rpc-scheduler";

export class RpcSchedulerService extends Context.Service<RpcSchedulerService, RpcScheduler>()("kello/RpcScheduler") {}

export class Storage extends Context.Service<Storage, InvocationStorage>()("kello/Storage") {}

/** Keep service identity distinct from its value: an empty table map must not
 * accidentally satisfy every other Effect service requirement. */
export interface ProjectService<Key extends string, Value> {
  readonly key: Key;
  readonly value: Value;
}

/** Schema-bound keys are created once by generated server bindings. Database is
 * provided with the invocation's guarded transaction, never the shared raw pool. */
export function createProjectServices<
  Schema extends DatabaseSchema & { readonly validators: object },
  Relations extends AnyRelations,
>() {
  const Database = Context.Service<
    ProjectService<"kello/Database", NodePgDatabase<Relations>>,
    NodePgDatabase<Relations>
  >("kello/Database");
  const Tables = Context.Service<ProjectService<"kello/Tables", Schema["tables"]>, Schema["tables"]>("kello/Tables");
  const Validators = Context.Service<
    ProjectService<"kello/Validators", SearchValidators<Schema, Relations>>,
    SearchValidators<Schema, Relations>
  >("kello/Validators");
  const Search = Context.Service<ProjectService<"kello/Search", SearchContext<Relations>>, SearchContext<Relations>>(
    "kello/Search",
  );
  return Object.freeze({ Database, Tables, Validators, Search });
}
