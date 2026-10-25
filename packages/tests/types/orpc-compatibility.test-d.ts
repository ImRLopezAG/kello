import "@orpc/effect/extensions/effect";
import { os, createRouterClient } from "@orpc/server";
import type { WithEffectContext } from "@orpc/effect";
import { Context } from "effect";
import * as v from "valibot";

class Greeting extends Context.Service<Greeting, { prefix: string }>()("types/Greeting") {}
const procedure = os
  .$context<WithEffectContext<Greeting>>()
  .input(v.string())
  .effect(function* ({ input }) {
    const service = yield* Greeting;
    return `${service.prefix} ${input}`;
  });

export function checkCompatibility(context: WithEffectContext<Greeting>) {
  const client = createRouterClient({ greet: procedure }, { context });
  const result: Promise<string> = client.greet("Kello");
  // @ts-expect-error Native input inference rejects invalid calls.
  void client.greet(1);
  // @ts-expect-error A required Effect service cannot be omitted.
  createRouterClient({ greet: procedure }, { context: {} });
  return result;
}
