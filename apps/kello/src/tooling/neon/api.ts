import { createNeonClient } from "@neon/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRealNeonApi, type NeonApi } from "@neon/config-runtime/v1";
import * as v from "valibot";
import { NeonCredentialError, createNeonCredentials, type NeonCredentialOptions } from "./credentials";

const invocation = new AsyncLocalStorage<ReturnType<typeof createNeonCredentials>>();
export function withNeonCredentials<T>(options: NeonCredentialOptions, run: () => T): T {
  return invocation.run(createNeonCredentials(options), run);
}

export function createKelloNeonClient() {
  const credentials = invocation.getStore() ?? createNeonCredentials();
  return createNeonClient({
    apiKey: () => credentials.resolve(),
    throwOnError: true,
    retries: 0,
    requestTimeoutMs: 30_000,
  });
}

/** Resolve before every operation; never replay an ambiguous resource mutation. */
export function createKelloNeonApi(): NeonApi {
  const credentials = invocation.getStore() ?? createNeonCredentials();
  async function authenticated() {
    return createRealNeonApi({ apiKey: await credentials.resolve(), retryOnLocked: { maxAttempts: 1 } });
  }
  async function invoke<T>(run: (api: NeonApi) => Promise<T>): Promise<T> {
    const api = await authenticated();
    try {
      return await run(api);
    } catch (cause) {
      const response = v.safeParse(
        v.union([v.object({ details: v.object({ status: v.number() }) }), v.object({ status: v.number() })]),
        cause,
      );
      const status = response.success
        ? "status" in response.output
          ? response.output.status
          : response.output.details.status
        : undefined;
      if (status === 401) throw new NeonCredentialError("NEON_SESSION_REVOKED");
      if (status === 403) throw new NeonCredentialError("NEON_PERMISSION_DENIED");
      throw cause;
    }
  }
  return {
    listProjects: (...args) => invoke((api) => api.listProjects(...args)),
    getProject: (...args) => invoke((api) => api.getProject(...args)),
    createProject: (...args) => invoke((api) => api.createProject(...args)),
    updateProject: (...args) => invoke((api) => api.updateProject(...args)),
    listBranches: (...args) => invoke((api) => api.listBranches(...args)),
    createBranch: (...args) => invoke((api) => api.createBranch(...args)),
    updateBranch: (...args) => invoke((api) => api.updateBranch(...args)),
    listEndpoints: (...args) => invoke((api) => api.listEndpoints(...args)),
    updateEndpoint: (...args) => invoke((api) => api.updateEndpoint(...args)),
    listBranchRoles: (...args) => invoke((api) => api.listBranchRoles(...args)),
    listBranchDatabases: (...args) => invoke((api) => api.listBranchDatabases(...args)),
    getConnectionUri: (...args) => invoke((api) => api.getConnectionUri(...args)),
    getNeonAuth: (...args) => invoke((api) => api.getNeonAuth(...args)),
    enableNeonAuth: (...args) => invoke((api) => api.enableNeonAuth(...args)),
    getNeonDataApi: (...args) => invoke((api) => api.getNeonDataApi(...args)),
    enableProjectBranchDataApi: (...args) => invoke((api) => api.enableProjectBranchDataApi(...args)),
    updateProjectBranchDataApi: (...args) => invoke((api) => api.updateProjectBranchDataApi(...args)),
    deleteProjectBranchDataApi: (...args) => invoke((api) => api.deleteProjectBranchDataApi(...args)),
    listBranchBuckets: (...args) => invoke((api) => api.listBranchBuckets(...args)),
    createBranchBucket: (...args) => invoke((api) => api.createBranchBucket(...args)),
    deleteBranchBucket: (...args) => invoke((api) => api.deleteBranchBucket(...args)),
    getProjectBranchStorage: (...args) => invoke((api) => api.getProjectBranchStorage(...args)),
    listBranchFunctions: (...args) => invoke((api) => api.listBranchFunctions(...args)),
    deleteBranchFunction: (...args) => invoke((api) => api.deleteBranchFunction(...args)),
    deployBranchFunction: (...args) => invoke((api) => api.deployBranchFunction(...args)),
    getBranchFunction: (...args) =>
      invoke(async (api) => {
        if (!api.getBranchFunction) throw new Error("Neon adapter does not support getBranchFunction");
        return api.getBranchFunction(...args);
      }),
    listBranchTriggers: (...args) => invoke((api) => api.listBranchTriggers(...args)),
    createBranchTrigger: (...args) => invoke((api) => api.createBranchTrigger(...args)),
    updateBranchTrigger: (...args) => invoke((api) => api.updateBranchTrigger(...args)),
    deleteBranchTrigger: (...args) => invoke((api) => api.deleteBranchTrigger(...args)),
    listBranchCustomDomains: (...args) =>
      invoke(async (api) => {
        if (!api.listBranchCustomDomains) throw new Error("Neon adapter does not support listBranchCustomDomains");
        return api.listBranchCustomDomains(...args);
      }),
    registerBranchCustomDomain: (...args) =>
      invoke(async (api) => {
        if (!api.registerBranchCustomDomain)
          throw new Error("Neon adapter does not support registerBranchCustomDomain");
        return api.registerBranchCustomDomain(...args);
      }),
    deleteBranchCustomDomain: (...args) =>
      invoke(async (api) => {
        if (!api.deleteBranchCustomDomain) throw new Error("Neon adapter does not support deleteBranchCustomDomain");
        return api.deleteBranchCustomDomain(...args);
      }),
    createCredential: (...args) => invoke((api) => api.createCredential(...args)),
    listCredentials: (...args) => invoke((api) => api.listCredentials(...args)),
    revealCredential: (...args) => invoke((api) => api.revealCredential(...args)),
    revokeCredential: (...args) => invoke((api) => api.revokeCredential(...args)),
  };
}
