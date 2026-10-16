import * as v from "valibot";
import type { Router } from "@orpc/server";
import type { VerifiedSession } from "../auth/verify";

/** Opaque component context; generated declarations retain its exact capabilities. */
export type ComponentHttpContext = object;

/** Request and cancellation context for a mounted HTTP route. A session is present only after successful verification. */
export interface ComponentHttpInvocation {
  readonly request: Request;
  readonly signal: AbortSignal;
  readonly session: VerifiedSession | null;
}

/** Explicit route admission policy: anonymous, verified user with authorization, or signed webhook verified against original request bytes. */
export type ComponentHttpAccess =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "verified-user";
      readonly authorize: (session: VerifiedSession, request: Request) => boolean | Promise<boolean>;
    }
  | {
      readonly kind: "signed-webhook";
      readonly verify: (input: {
        readonly request: Request;
        readonly body: Uint8Array;
        readonly signal: AbortSignal;
      }) => void | Promise<void>;
    };

/** Component HTTP route with an explicit access policy and either a request handler or an oRPC router. Limits bound request size and execution time. */
export type ComponentHttpRoute<Context extends object = ComponentHttpContext> = {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly access: ComponentHttpAccess;
  /** Allowed browser origins; this is not a substitute for the access policy. */
  readonly origins?: readonly string[];
  /** Maximum body size in bytes. Defaults to 1 MiB; cannot exceed 10 MiB. */
  readonly maxRequestBytes?: number;
  /** Request deadline in milliseconds. Defaults to 30,000; cannot exceed 120,000. */
  readonly requestTimeoutMs?: number;
} & (
  | {
      readonly handle: (input: ComponentHttpInvocation & { readonly context: Context }) => Response | Promise<Response>;
      readonly router?: never;
    }
  | { readonly router: Router<Context>; readonly handle?: never }
);

/** Runtime HTTP mount binding a route prefix to its component-scoped invocation context. */
export interface ComponentHttpMount<Context extends object = ComponentHttpContext> {
  readonly prefix: string;
  readonly routes: readonly ComponentHttpRoute<Context>[];
  /** Acquires only this component's scoped capabilities after ingress authorization.
   * Keep the scope alive until work settles, then revoke callers and release services. */
  readonly invoke?: (
    invocation: ComponentHttpInvocation,
    work: (context: Context) => Promise<Response>,
  ) => Promise<Response>;
}

function validPath(path: string, root: boolean): boolean {
  return (root && path === "/") || /^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(path);
}

/** Shared by generation and runtime; no handler or SDK factory is executed. */
export function validateComponentHttpMounts(mounts: readonly ComponentHttpMount[]): void {
  const prefixes: string[] = [];
  const routes = new Set<string>();
  for (const mount of mounts) {
    const prefix = mount.prefix;
    if (
      !validPath(prefix, false) ||
      prefix === "/api" ||
      ["/api/kello", "/api/auth"].some((reserved) => prefix === reserved || prefix.startsWith(reserved + "/"))
    )
      throw new Error(`Reserved or invalid component HTTP prefix: ${prefix}`);
    if (prefixes.includes(prefix)) throw new Error(`Overlapping component HTTP prefix: ${prefix}`);
    prefixes.push(prefix);
    for (const route of mount.routes) {
      if (!validPath(route.path, true) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(route.method))
        throw new Error("Invalid component HTTP route");
      const key = `${route.method} ${prefix}${route.path === "/" ? "" : route.path}`;
      if (routes.has(key)) throw new Error(`Duplicate component HTTP route: ${key}`);
      routes.add(key);
      if (!route.access || !["anonymous", "verified-user", "signed-webhook"].includes(route.access.kind))
        throw new Error("Component HTTP routes require an explicit access policy");
      if (route.access.kind === "verified-user" && !v.is(v.function(), route.access.authorize))
        throw new Error("Missing HTTP authorization");
      if (route.access.kind === "signed-webhook" && !v.is(v.function(), route.access.verify))
        throw new Error("Missing webhook verifier");
      if (v.is(v.function(), route.handle) === (route.router !== undefined))
        throw new Error("Expected one HTTP handler or router");
      for (const [value, maximum] of [
        [route.maxRequestBytes ?? 1_048_576, 10_485_760],
        [route.requestTimeoutMs ?? 30_000, 120_000],
      ]) {
        if (!Number.isInteger(value) || value! < 1 || value! > maximum!)
          throw new Error("Invalid component HTTP limit");
      }
    }
  }
}
