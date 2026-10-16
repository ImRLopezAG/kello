import { call, ORPCError } from "@orpc/server";
import { Context } from "effect";
import * as v from "valibot";
import { json } from "../../validation/encoding";
import { Invocation } from "../effect/runtime";
import { rpcValue, serializeRpcValue, rpcProtocolVersion } from "../rpc/serialization";
import { jobFailure } from "./contracts";
import { createDurableJobWorker } from "./durable-worker";
import type { DurableWorkerOptions } from "./durable-worker";
import { decodeRpcJobInput } from "./rpc-contracts";
import type { RpcJobCall } from "./rpc-contracts";
import type { InternalProcedureEntry } from "./rpc-queue";

/** Entries must be bound to the same authorization/transaction services as RPC.
 * The stable job id owns replay; lease owner and token never change its identity. */
export function createRpcJobWorker(
  options: Omit<DurableWorkerOptions<RpcJobCall>, "execute"> & {
    readonly internal: readonly InternalProcedureEntry[];
  },
) {
  const procedures = new Map(
    options.internal.map((entry) => [JSON.stringify([entry.scope ?? "", entry.path]), entry.procedure]),
  );
  if (procedures.size !== options.internal.length) throw new Error("Duplicate internal procedure path");
  return createDurableJobWorker({
    ...options,
    execute: async (job, signal) => {
      const procedure = procedures.get(JSON.stringify([job.call.scope ?? "", job.call.path]));
      if (!procedure) return { ok: false, error: { code: "NOT_FOUND" } };
      const invocation = Object.freeze({
        identity: job.identity ? Object.freeze({ ...job.identity }) : null,
        requestId: crypto.randomUUID(),
        signal,
        job: Object.freeze({ id: job.id, attempt: job.attempt }),
      });
      try {
        signal.throwIfAborted();
        const result = await call(procedure, decodeRpcJobInput(job.call), {
          path: job.call.path,
          signal,
          context: {
            ...invocation,
            idempotencyKey: job.id,
            "effect/context": Context.make(Invocation, invocation),
          },
        });
        signal.throwIfAborted();
        return {
          ok: true,
          value: v.parse(
            json,
            JSON.parse(
              JSON.stringify({
                protocol: rpcProtocolVersion,
                payload: serializeRpcValue(v.parse(rpcValue, result)),
              }),
            ),
          ),
        };
      } catch (cause) {
        const code = cause instanceof ORPCError ? v.safeParse(jobFailure, cause.code) : undefined;
        return { ok: false, error: { code: signal.aborted ? "CANCELLED" : code?.success ? code.output : "INTERNAL" } };
      }
    },
  });
}
