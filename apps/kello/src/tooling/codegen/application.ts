import { relative } from "node:path";
import type { loadProject } from "../project/load";
import { contractGraph } from "./contracts";
import { searchPublicNode } from "kello/server";
import { liveQueryRows } from "../../core/realtime/contract";
import { liveRowsSource } from "./live-query";

export function applicationArtifacts(project: Awaited<ReturnType<typeof loadProject>>, hasRelations: boolean) {
  const schema = `${
    hasRelations ? 'import relations from "../relations";' : 'import { defineRelations } from "drizzle-orm";'
  }
import schema from "../schema";
import { createProjectContext } from "kello/server";
${hasRelations ? "" : "const relations = defineRelations(schema.tables);"}
export { schema, relations };
export const { tables, validators } = createProjectContext(schema, relations);
`;
  const declarations = project.contractModules
    .map(
      (module, index) =>
        `import declaration${index} from ${JSON.stringify(`../contracts/${module.path.replace(/\.[cm]?[jt]s$/, "")}`)};`,
    )
    .join("\n");
  const registry = `import type {} from "./registration";
import { resolveContract } from "kello/contract";
import { validators } from "./schema";
${declarations}
${project.contractModules.map((_, index) => `export const contract${index} = resolveContract(declaration${index}, { validators });`).join("\n")}
export const contract = ${contractGraph(project.contractModules, (index) => `contract${index}`)};
`;
  const mounted = project.components.filter((node) => !node.path.includes("/"));
  const componentTypes = `import type { ComponentServices } from "kello/server";
import type { RouterContractClient } from "kello/contract";
import type { SearchRouterClient } from "kello/client";
${mounted.map((node, index) => `import type { contract as contract${index} } from ${JSON.stringify(node.packageDescriptor?.contractRegistry ?? relative(`${project.backend}/_generated`, `${node.directory}/_generated/contract-registry`).replaceAll("\\", "/"))};`).join("\n")}
export type PublicComponents = {
${mounted.flatMap((node, index) => (node.public === undefined ? [] : [`${JSON.stringify(node.public)}: Omit<typeof contract${index}, "internal">;`])).join("\n")}
};
export interface Components {
${mounted
  .map(
    (node, index) =>
      `${JSON.stringify(node.reference.name)}: { readonly rpc: SearchRouterClient<RouterContractClient<Omit<typeof contract${index}, "internal">>>; readonly services: ComponentServices<typeof import(${JSON.stringify(
        node.packageDescriptor?.entry ??
          relative(`${project.backend}/_generated`, node.setupFile)
            .replaceAll("\\", "/")
            .replace(/\.[cm]?[jt]s$/, ""),
      )}).default> };`,
  )
  .join("\n")}
}
`;
  const registration = `import type { Components } from "./components";
import type { schema, relations, validators } from "./schema";
import type { contract } from "./contract-registry";
declare module "kello/contract" {
  interface ProjectRegistration {
    components: Components;
    schema: typeof schema;
    relations: typeof relations;
    validators: typeof validators;
    contract: typeof contract;
  }
}
`;
  const rpc = `import type {} from "./registration";
import { createApplicationRpc } from "kello/server";
import app from "../app.config";
import { schema, relations } from "./schema";
import { contract } from "./contract-registry";
const rpc = createApplicationRpc(app, { schema, relations, contract });
${project.builderNames.map((key, index) => `const builder${index} = rpc[${JSON.stringify(key)}]; export { builder${index} as ${key} };`).join("\n")}
`;
  const files = new Map([
    ["schema.ts", schema],
    ["components.ts", componentTypes],
    ["config.js", `export const configuration = Object.freeze(${JSON.stringify(project.publicConfiguration)});\n`],
    [
      "config.d.ts",
      "export declare const configuration: Readonly<{ serviceUrl?: string; authUrl?: string; dataApiUrl?: string }>;\n",
    ],
    ["contract-registry.ts", registry],
    ["registration.d.ts", registration],
    ["rpc.ts", rpc],
  ]);
  for (const [index, module] of project.contractModules.entries()) {
    const filename = `contracts/${module.path.replace(/\.[cm]?[jt]s$/, "")}.ts`;
    const parent = filename
      .split("/")
      .slice(0, -1)
      .map(() => "..")
      .join("/");
    files.set(filename, `export { contract${index} as default } from "${parent}/contract-registry";\n`);
  }
  return Object.fromEntries(files);
}

interface ClientArtifactFiles {
  "api.js": string;
  "api.d.ts": string;
  "react.js"?: string;
  "react.d.ts"?: string;
}

export function applicationClientArtifacts(
  project: Pick<Awaited<ReturnType<typeof loadProject>>, "backend" | "procedures" | "version">,
  directory: string,
) {
  const registry = relative(directory, `${project.backend}/_generated/contract-registry`).replaceAll("\\", "/");
  const configurationPath = relative(directory, `${project.backend}/_generated/config.js`).replaceAll("\\", "/");
  const search = project.procedures.flatMap((entry) => {
    if (entry.visibility !== "public") return [];
    const node = entry.definition["~orpc"].inputSchemas?.map(searchPublicNode).find((node) => node !== undefined);
    return node ? [{ path: entry.path, node }] : [];
  });
  const live = project.procedures.flatMap((entry) => {
    const rows = entry.visibility === "public" ? liveQueryRows(entry.definition) : undefined;
    return rows ? [{ path: entry.path, rows: liveRowsSource(rows) }] : [];
  });
  const livePaths = JSON.stringify(live.map(({ path }) => path));
  const plugin = search.length
    ? `, plugins: [createSearchQueryPlugin(${JSON.stringify(search)}.map(({ path, node }) => createSearchDataGuard(path, node)))]`
    : "";
  const files: ClientArtifactFiles = {
    "api.js": `import { createORPCClient, createRpcTransport, createRpcHttpTransport } from "kello/client";
import { createTanstackQueryUtils } from "kello/client";
${live.length ? 'import { createNeonLiveClient } from "kello/client";' : ""}
${search.length ? 'import { createSearchQueryPlugin, createSearchDataGuard } from "kello/client";' : ""}
export const version = ${JSON.stringify(project.version)};
import { configuration } from ${JSON.stringify(configurationPath.startsWith(".") ? configurationPath : `./${configurationPath}`)};
export { configuration };
${
  live.length
    ? `const livePaths = ${livePaths};
const isLive = path => livePaths.some(candidate => candidate.length === path.length && candidate.every((part, index) => part === path[index]));
function queryUtils(link, options) {
  const ordinary = createORPCClient({ async call(path, input, callOptions) {
    if (isLive(path)) throw new Error("Use the generated useLiveQuery hook for a live procedure");
    return link.call(path, input, callOptions);
  }});
  return createTanstackQueryUtils(ordinary, { prefix: options.cachePrefix${plugin} });
}`
    : ""
}
export function createServerClient(options) {
  const url = options.url ?? configuration.serviceUrl;
  if (!url) throw new Error("Kello service URL is missing. Deploy or pass url explicitly.");
  const transport = createRpcHttpTransport({ ...options, url, version });
  const client = createORPCClient(transport.link);
  return Object.freeze({ ...transport, client, rpc: ${live.length ? "queryUtils(transport.link, options)" : `createTanstackQueryUtils(client, { prefix: options.cachePrefix${plugin} })`} });
}
export function createClient(options) {
  const url = options.url ?? configuration.serviceUrl;
  if (!url) throw new Error("Kello service URL is missing. Deploy or pass url explicitly.");
  ${live.length ? `if (!options.realtimeUrl) throw new Error("Neon Realtime URL is missing");` : ""}
  const transport = createRpcTransport({ ...options, url, version });
  ${
    live.length
      ? `
  const http = createRpcHttpTransport({ ...options, url, version });
  const live = createNeonLiveClient({ url: options.realtimeUrl });
  const link = { async call(path, input, callOptions) { return (isLive(path) ? http.link : transport.link).call(path, input, callOptions); } };
  const client = createORPCClient(link);
  return Object.freeze({ ...http, client, live, rpc: queryUtils(link, options), dispose() { live.dispose(); http.dispose(); transport.dispose(); } });`
      : `const client = createORPCClient(transport.link);
  return Object.freeze({ ...transport, client, rpc: createTanstackQueryUtils(client, { prefix: options.cachePrefix${plugin} }) });`
  }
}
`,
    "api.d.ts": `import type { contract } from ${JSON.stringify(registry.startsWith(".") ? registry : `./${registry}`)};
import type { PublicComponents } from ${JSON.stringify(relative(directory, `${project.backend}/_generated/components`).replaceAll("\\", "/"))};
import type { SearchRouterClient, SearchRouterUtils } from "kello/client";
import type { RouterContractClient } from "kello/contract";
import type { RpcCallContext, RpcTransportOptions, createRpcTransport } from "kello/client";
${live.length ? 'import type { OrdinaryLiveRouter, createNeonLiveClient } from "kello/client";' : ""}
export type PublicContract = Omit<typeof contract, "internal"> & PublicComponents;
type NativeClient = RouterContractClient<PublicContract, RpcCallContext>;
export type Client = SearchRouterClient<NativeClient>;
export declare const configuration: Readonly<{ serviceUrl?: string; authUrl?: string; dataApiUrl?: string }>;
export declare const version: ${JSON.stringify(project.version)};
export declare function createServerClient(options: Omit<RpcTransportOptions, "version" | "url"> & { readonly url?: string }): ReturnType<typeof createRpcTransport> & { readonly client: Client; readonly rpc: SearchRouterUtils<${live.length ? "OrdinaryLiveRouter<NativeClient>" : "NativeClient"}> };
export declare function createClient(options: Omit<RpcTransportOptions, "version" | "url"> & { readonly url?: string${live.length ? "; readonly realtimeUrl: string" : ""} }): ReturnType<typeof createRpcTransport> & { readonly client: Client; readonly rpc: SearchRouterUtils<${live.length ? "OrdinaryLiveRouter<NativeClient>" : "NativeClient"}>${live.length ? "; readonly live: ReturnType<typeof createNeonLiveClient>" : ""} };
`,
  };
  if (live.length) {
    files["react.js"] = `"use client";
import { createClient as createBaseClient } from "./api.js";
import { createLiveQueryHooks } from "kello/react";
import * as v from "valibot";
const declarations = [${live.map(({ path, rows }) => `{ path: ${JSON.stringify(path)}, rows: ${rows} }`).join(",")}];
export function createClient(options) {
  const connection = createBaseClient(options);
  return Object.freeze({ ...connection, api: createLiveQueryHooks(connection.client, connection.live, declarations) });
}
`;
    files["react.d.ts"] = `import type { createClient as createBaseClient, Client } from "./api.js";
import type { LiveQueryHooks } from "kello/react";
export declare function createClient(options: Parameters<typeof createBaseClient>[0]): ReturnType<typeof createBaseClient> & { readonly api: LiveQueryHooks<Client> };
`;
  }
  return files;
}
