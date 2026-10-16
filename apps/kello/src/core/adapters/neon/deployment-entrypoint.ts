import { timingSafeEqual } from "node:crypto";
import * as v from "valibot";
import { createNeonActivationVerifier, createNeonPreparationVerifier } from "./activation";
import { createNeonIngressVerifier } from "./ingress";
import type { NeonActivationOptions } from "./activation";
import { createNeonEntrypoint } from "./entrypoint";
import type { NeonEntrypointApplication } from "./entrypoint";

export interface NeonDeploymentEntrypointOptions {
  readonly binding: NeonActivationOptions;
  readonly artifactHash: string;
  readonly role: "service" | "worker";
  readonly start: (
    assertActive: ReturnType<typeof createNeonActivationVerifier>,
    assertIngress: ReturnType<typeof createNeonIngressVerifier>,
  ) => Promise<NeonEntrypointApplication>;
}

/** Probes an isolated startup and closes it without exposing its dispatcher or activating its grant. */
export function createNeonDeploymentEntrypoint(options: NeonDeploymentEntrypointOptions) {
  const binding = structuredClone(options.binding);
  const artifactHash = v.parse(v.pipe(v.string(), v.length(64), v.regex(/^[a-f0-9]+$/)), options.artifactHash);
  const role = v.parse(v.picklist(["service", "worker"]), options.role);
  const start = options.start;
  const assertActive = createNeonActivationVerifier(binding);
  const assertPrepared = createNeonPreparationVerifier(binding);
  const assertIngress = createNeonIngressVerifier(binding);
  const normal = createNeonEntrypoint(() => start(assertActive, assertIngress));
  let probe: Promise<{ readonly databaseDrainProtocol: 0 | 1 } | undefined> | undefined;
  let stopping: Promise<void> | undefined;
  const unavailable = () =>
    new Response("Service unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  function authenticated(request: Request): boolean {
    const token = process.env.LOOM_ACTIVATION_TOKEN;
    const authorization = request.headers.get("authorization");
    const supplied = authorization?.slice(7);
    return (
      request.method === "POST" &&
      authorization?.startsWith("Bearer ") === true &&
      token?.length === 64 &&
      supplied?.length === 64 &&
      /^[a-f0-9]+$/.test(token) &&
      /^[a-f0-9]+$/.test(supplied) &&
      timingSafeEqual(Buffer.from(token), Buffer.from(supplied))
    );
  }
  return Object.freeze({
    async fetch(this: void, request: Request): Promise<Response> {
      if (stopping) return unavailable();
      if (new URL(request.url).pathname !== "/_loom/deployment/health") return normal.fetch(request);
      if (!authenticated(request))
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      if (request.signal.aborted) return unavailable();
      probe ??= Promise.resolve()
        .then(async () => {
          const application = await start(assertPrepared, assertIngress);
          await application.stop();
          return { databaseDrainProtocol: application.databaseDrainProtocol ?? 0 } as const;
        })
        .catch(() => undefined)
        .finally(() => {
          probe = undefined;
        });
      const healthy = await probe;
      if (!healthy || stopping || request.signal.aborted) return unavailable();
      return Response.json(
        {
          format: 1,
          version: binding.version,
          artifactHash,
          role,
          databaseDrainProtocol: healthy.databaseDrainProtocol,
        },
        { headers: { "cache-control": "no-store" } },
      );
    },
    stop(): Promise<void> {
      stopping ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled([probe, normal.stop()]);
        if (results.some((result) => result.status === "rejected")) throw new Error("Deployment entry shutdown failed");
      });
      return stopping;
    },
  });
}
