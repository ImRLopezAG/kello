import type { BunPlugin } from "bun";
import { dirname, join, resolve } from "node:path";
import { serverBindings } from "../codegen/server";

/** Discovery must not read a previous generation back into its own source hash. */
export function projectReferences(
  backend: string,
  relationsFile: string | undefined,
  application: {
    readonly contracts: string;
    readonly builders: readonly string[];
    readonly modules: readonly { readonly path: string }[];
  },
): BunPlugin {
  return {
    name: "loom-project-references",
    setup(build) {
      build.onResolve({ filter: /^kello:contracts$/ }, () => ({ path: "contracts", namespace: "loom-contracts" }));
      build.onLoad({ filter: /.*/, namespace: "loom-contracts" }, () => {
        return { contents: application.contracts, loader: "js" };
      });
      build.onResolve({ filter: /^kello:relations$/ }, () => ({ path: "relations", namespace: "loom-relations" }));
      build.onLoad({ filter: /.*/, namespace: "loom-relations" }, () => ({
        contents: relationsFile
          ? `export { default } from ${JSON.stringify(relationsFile)};`
          : `import { defineRelations } from "drizzle-orm"; import schema from ${JSON.stringify(join(backend, "schema.ts"))}; export default defineRelations(schema.tables);`,
        loader: "js",
      }));
      build.onResolve({ filter: /_generated\// }, ({ path, importer }) => {
        const filename = resolve(dirname(importer), path).replace(/\.[cm]?[jt]s$/, "");
        if (filename === join(backend, "_generated/rpc")) return { path: "rpc", namespace: "loom-application-rpc" };
        const contractIndex = application.modules.findIndex(
          (module) => filename === join(backend, "_generated/contracts", module.path.replace(/\.[cm]?[jt]s$/, "")),
        );
        if (contractIndex !== undefined && contractIndex >= 0)
          return { path: String(contractIndex), namespace: "loom-contract-entry" };
        if (filename === join(backend, "_generated/server"))
          return { path: "server", namespace: "loom-reference-entry" };
        if (["api", "internal"].some((name) => filename === join(backend, "_generated", name)))
          throw new Error("Server procedures must import procedure objects directly, not generated client bindings");
      });
      build.onLoad({ filter: /.*/, namespace: "loom-contract-entry" }, ({ path }) => ({
        contents: `export { contract${path} as default } from "kello:contracts";`,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "loom-application-rpc" }, () => {
        return {
          contents: `import { createApplicationRpc } from "kello/server";
import app from ${JSON.stringify(join(backend, "app.config.ts"))};
import schema from ${JSON.stringify(join(backend, "schema.ts"))};
import relations from "kello:relations";
import { contract } from "kello:contracts";
const rpc = createApplicationRpc(app, { schema, relations, contract });
${application.builders.map((key, index) => `const builder${index} = rpc[${JSON.stringify(key)}]; export { builder${index} as ${key} };`).join("\n")}`,
          loader: "js",
        };
      });
      build.onLoad({ filter: /.*/, namespace: "loom-reference-entry" }, () => ({
        contents: `import relations from "kello:relations";
import schema from ${JSON.stringify(join(backend, "schema.ts"))};
${serverBindings(false)}
import app from ${JSON.stringify(join(backend, "app.config.ts"))};
import { createApplicationEnvironmentAccess } from "kello/server";
export const env = createApplicationEnvironmentAccess(() => app);`,
        loader: "js",
      }));
    },
  };
}
