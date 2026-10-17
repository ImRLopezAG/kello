import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildNeonFunctionBundle } from "kello/tooling";
import { createKelloNeonApi } from "kello/tooling";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** Deploys only a public verification key; the signing key stays in this test process. */
export async function createCloudIssuer(root: string, projectId: string, branchId: string) {
  const api = createKelloNeonApi();
  const slug = "loomissuer";
  assert(!(await api.listBranchFunctions(projectId, branchId)).some((fn) => fn.slug === slug));
  const keys = await generateKeyPair("ES256");
  const kid = crypto.randomUUID();
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid, alg: "ES256", use: "sig" }] };
  const source = join(root, "issuer.mjs");
  await writeFile(
    source,
    `export default { fetch(request) { return new URL(request.url).pathname === "/jwks" ? Response.json(${JSON.stringify(jwks)}) : new Response("Not found", { status: 404 }); } };`,
  );
  const bundle = await buildNeonFunctionBundle(source);
  const deployment = await api.deployBranchFunction(projectId, branchId, slug, {
    bundle,
    runtime: "nodejs24",
    environment: {},
  });
  const signal = AbortSignal.timeout(90000);
  for (;;) {
    signal.throwIfAborted();
    const current = (await api.listBranchFunctions(projectId, branchId)).find((fn) => fn.slug === slug);
    assert.notEqual(current?.currentDeployment?.status, "failed", "Issuer deployment failed");
    if (current?.activeDeploymentId === deployment.id && current.currentDeployment?.status === "completed") {
      const issuer = new URL(current.invocationUrl).origin;
      const jwksUrl = new URL("/jwks", issuer).href;
      const freshJwksUrl = `${jwksUrl}?key=${kid}`;
      const response = await fetch(freshJwksUrl, { signal });
      // A reused function URL can briefly serve its previous deployment even
      // after control-plane activation. Never mint tokens until the new key is live.
      const ready = response.ok && isDeepStrictEqual(await response.json(), jwks);
      if (!response.ok) await response.body?.cancel();
      if (!ready) {
        await setTimeout(1000, undefined, { signal });
        continue;
      }
      return {
        issuer,
        jwksUrl: freshJwksUrl,
        token: (subject: string, audience = "loom-acceptance", expiresIn = "5m") =>
          new SignJWT({})
            .setProtectedHeader({ alg: "ES256", kid })
            .setIssuer(issuer)
            .setSubject(subject)
            .setAudience(audience)
            .setIssuedAt()
            .setExpirationTime(expiresIn)
            .sign(keys.privateKey),
      };
    }
    await setTimeout(1000, undefined, { signal });
  }
}
