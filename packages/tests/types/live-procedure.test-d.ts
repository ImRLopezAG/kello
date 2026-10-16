import { expectTypeOf } from "vite-plus/test";
import { implement } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, integer } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { oc } from "../../../apps/kello/src/core/contract";
import "../../../apps/kello/src/core/server/realtime/procedure";
import type { LiveQueryHooks } from "../../../apps/kello/src/core/react/live-query";
import type { OrdinaryLiveRouter } from "../../../apps/kello/src/core/client/realtime";

const contract = {
  list: oc
    .input(v.object({ limit: v.number() }))
    .output(v.array(v.object({ id: v.string() })))
    .live(),
  ordinary: oc.output(v.string()),
};
const os = implement(contract);
const table = pgTable("typed_tasks", { id: text().notNull(), count: integer().notNull() });
const db = drizzle.mock();
const router = os.router({
  list: os.list.live(() => db.select({ id: table.id }).from(table)),
  ordinary: os.ordinary.handler(() => "ok"),
});
type Client = RouterClient<typeof router>;
declare const api: LiveQueryHooks<Client>;
declare const ordinary: OrdinaryLiveRouter<Client>;

export function liveProcedureTypes() {
  expectTypeOf(api.list.useLiveQuery({ limit: 10 }).data).toEqualTypeOf<readonly { id: string }[] | undefined>();
  // @ts-expect-error The normal contract validates pagination; generated hooks retain that exact input.
  api.list.useLiveQuery({ limit: "ten" });
  // @ts-expect-error Ordinary functions remain ordinary native clients.
  api.ordinary.useLiveQuery();
  // @ts-expect-error A live capability is not an ordinary Query cache result.
  ordinary.list;
  expectTypeOf(ordinary.ordinary).toEqualTypeOf<Client["ordinary"]>();
  // @ts-expect-error Live outputs must declare a row array.
  oc.output(v.string()).live();
  // @ts-expect-error Awaiting a Drizzle builder would execute the query, rather than issuing it to Neon.
  os.list.live(async () => db.select({ id: table.id }).from(table));
  // @ts-expect-error The selected row must match the contract output.
  os.list.live(() => db.select({ id: table.count }).from(table));
  expectTypeOf(createORPCClient).toBeFunction();
}
