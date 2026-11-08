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
    name: "kello-project-references",
    setup(build) {
      build.onResolve({ filter: /^kello:contracts$/ }, () => ({ path: "contracts", namespace: "kello-contracts" }));
      build.onLoad({ filter: /.*/, namespace: "kello-contracts" }, () => {
        return { contents: application.contracts, loader: "js" };
      });
      build.onResolve({ filter: /^kello:relations$/ }, () => ({ path: "relations", namespace: "kello-relations" }));
      build.onLoad({ filter: /.*/, namespace: "kello-relations" }, () => ({
        contents: relationsFile
          ? `export { default } from ${JSON.stringify(relationsFile)};`
          : `import { defineRelations } from "drizzle-orm"; import schema from ${JSON.stringify(join(backend, "schema.ts"))}; export default defineRelations(schema.tables);`,
        loader: "js",
      }));
      build.onResolve({ filter: /_generated\// }, ({ path, importer }) => {
        const filename = resolve(dirname(importer), path).replace(/\.[cm]?[jt]s$/, "");
        if (filename === join(backend, "_generated/rpc")) return { path: "rpc", namespace: "kello-application-rpc" };
        const contractIndex = application.modules.findIndex(
          (module) => filename === join(backend, "_generated/contracts", module.path.replace(/\.[cm]?[jt]s$/, "")),
        );
        if (contractIndex !== undefined && contractIndex >= 0)
          return { path: String(contractIndex), namespace: "kello-contract-entry" };
        if (filename === join(backend, "_generated/server"))
          return { path: "server", namespace: "kello-reference-entry" };
        if (["api", "internal"].some((name) => filename === join(backend, "_generated", name)))
          throw new Error("Server procedures must import procedure objects directly, not generated client bindings");
      });
      build.onLoad({ filter: /.*/, namespace: "kello-contract-entry" }, ({ path }) => ({
        contents: `export { contract${path} as default } from "kello:contracts";`,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "kello-application-rpc" }, () => {
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
      build.onLoad({ filter: /.*/, namespace: "kello-reference-entry" }, () => ({
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
