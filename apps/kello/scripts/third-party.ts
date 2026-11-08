import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

const root = fileURLToPath(new URL("../", import.meta.url));
const tooling = process.argv.includes("--tooling");
const destination = join(root, tooling ? "../kello-cli/dist/third-party" : "dist/third-party");
await mkdir(destination, { recursive: true });
const manifest = v.object({ name: v.string(), version: v.string(), license: v.string() });
const packages = [
  {
    name: "drizzle-kit",
    version: "1.0.0-rc.5",
    entry: "drizzle-kit/api-postgres",
    levels: 0,
    patch: "drizzle-kit@1.0.0-rc.5.patch",
  },
  { name: "@neon/config-runtime", version: "1.12.0", entry: "@neon/config-runtime", levels: 1 },
  { name: "@neon/config", version: "1.13.0", entry: "@neon/config", levels: 1, patch: "@neon%2Fconfig@1.13.0.patch" },
  {
    name: "@neon/realtime-drizzle",
    version: "0.2.0",
    entry: "@neon/realtime-drizzle",
    levels: 1,
    patch: "@neon%2Frealtime-drizzle@0.2.0.patch",
  },
  {
    name: "@orpc/effect",
    version: "2.0.0-beta.49",
    entry: "@orpc/effect",
    levels: 1,
    patch: "@orpc%2Feffect@2.0.0-beta.49.patch",
  },
  { name: "zod", version: "4.6.7", entry: "zod", levels: 0 },
];
// The runtime package bundles these; kello-cli bundles the rest.
const runtimeBundled = new Set(["@neon/realtime-drizzle", "@orpc/effect"]);
for (const dependency of packages.filter((item) =>
  tooling ? !runtimeBundled.has(item.name) : runtimeBundled.has(item.name),
)) {
  let directory = dirname(fileURLToPath(import.meta.resolve(dependency.entry)));
  for (let index = 0; index < dependency.levels; index += 1) directory = dirname(directory);
  const contents = await readFile(join(directory, "package.json"), "utf8");
  const metadata = v.parse(manifest, JSON.parse(contents));
  if (metadata.name !== dependency.name || metadata.version !== dependency.version)
    throw new Error("Bundled dependency version changed; review its patch and notices");
  const name = dependency.name.replaceAll("/", "-").replace("@", "");
  await writeFile(join(destination, `${name}.package.json`), contents);
  if (dependency.name.startsWith("@neon/") || dependency.name.startsWith("@orpc/") || dependency.name === "zod")
    await writeFile(join(destination, `${name}.LICENSE`), await readFile(join(directory, "LICENSE")));
  if (dependency.patch) {
    const patch = await readFile(join(root, "../../patches", dependency.patch));
    await writeFile(join(destination, dependency.patch), patch);
    await writeFile(join(destination, `${name}.patch.sha256`), `${createHash("sha256").update(patch).digest("hex")}\n`);
  }
}
await writeFile(
  join(destination, "README.md"),
  tooling
    ? `# Bundled dependencies

Kello tooling bundles the PostgreSQL API from drizzle-kit 1.0.0-rc.5 (published package license: MIT), @neon/config-runtime 1.12.0 and @neon/config 1.13.0 (Apache-2.0), and their Zod 4.6.7 dependency (MIT). Their package metadata, available upstream license files and Kello's modifications are included here. Published JavaScript is minified without source maps; license notices remain in the emitted JavaScript.

The Drizzle patch adds schema-scoped read-only introspection; rename hints use the upstream API. The Neon config patch rejects unknown or missing bucket access levels. The runtime kello package separately bundles the patched @neon/realtime-drizzle adapter. These changes are pinned and tested; consumers do not apply installation patches. Only the tooling dependencies described above are bundled in kello-cli. The official Realtime SDK remains an external runtime dependency. Kello deploys functions with the application's development-only Vite+ toolchain and fflate ZIP creation, rather than the bundled Neon config runtime's default esbuild/native-package tracing path. Bundling tooling's Zod keeps it independent of the application's Standard Schema choice and avoids splitting Drizzle's type identity through incompatible peer resolutions.

The published drizzle-kit archive contains no standalone LICENSE file. Its metadata declares MIT; the upstream repository root separately carries Apache-2.0. Publication remains gated on the project's license and namespace review. This artifact record does not resolve that release decision.
`
    : `# Bundled dependencies

Kello bundles @neon/realtime-drizzle 0.2.0 (Apache-2.0), with the reviewed Drizzle RC5 and parameter-encoding patch, and @orpc/effect 2.0.0-beta.49 (MIT), with the declaration patch that restores its missing DecoratedProcedure import so published \`.effect()\` procedures keep their types. Its oRPC and Effect dependencies stay external, so the extension augments the application's single @orpc/server. Metadata, licenses and patches are retained here. The official Realtime SDK remains external. JavaScript is minified without source maps; license notices remain inline. Deployment, migration, Neon config and Zod tooling are distributed separately in kello-cli.
`,
);
