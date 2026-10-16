import * as v from "valibot";
import { readResponse } from "./control-plane";
import { abortable } from "../adapters/neon/abortable";
import type { RpcTransportOptions } from "./rpc-transport";

const sessionSchema = v.strictObject({
  key: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  expiresAt: v.pipe(v.number(), v.finite()),
});
export type VerifiedClientSession = v.InferOutput<typeof sessionSchema>;

/** Identity comes from the deployed verifier, never from decoding an unverified token. */
export async function verifyClientSession(
  options: RpcTransportOptions,
  shutdown: AbortSignal,
): Promise<VerifiedClientSession> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const token = await abortable(options.getToken(), signal);
  if (!token) throw new Error("Authentication required");
  const response = await fetch(`${options.url.replace(/\/$/, "")}/api/kello/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-loom-protocol": "loom-orpc-2", "x-loom-version": options.version },
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Session verification refused (${response.status})`);
  }
  const session = v.parse(sessionSchema, JSON.parse(await readResponse(response, 1024, signal)));
  signal.throwIfAborted();
  if (session.expiresAt <= Date.now() / 1000) throw new Error("Expired session");
  return Object.freeze(session);
}
