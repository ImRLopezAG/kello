import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, "dist/third-party");
await mkdir(destination, { recursive: true });
const manifest = v.object({ name: v.string(), version: v.string(), license: v.string() });
const packages = [
  {
    name: "drizzle-kit",
    version: "1.0.0-rc.4",
    entry: "drizzle-kit/api-postgres",
    levels: 0,
    patch: "drizzle-kit@1.0.0-rc.4.patch",
  },
  { name: "@neon/config-runtime", version: "1.10.1", entry: "@neon/config-runtime", levels: 1 },
  { name: "@neon/config", version: "1.9.2", entry: "@neon/config", levels: 1, patch: "@neon%2Fconfig@1.9.2.patch" },
  {
    name: "@neon/realtime-drizzle",
    version: "0.1.0",
    entry: "@neon/realtime-drizzle",
    levels: 1,
    patch: "@neon%2Frealtime-drizzle@0.1.0.patch",
  },
  { name: "zod", version: "4.6.5", entry: "zod", levels: 0 },
];
for (const dependency of packages) {
  let directory = dirname(fileURLToPath(import.meta.resolve(dependency.entry)));
  for (let index = 0; index < dependency.levels; index += 1) directory = dirname(directory);
  const contents = await readFile(join(directory, "package.json"), "utf8");
  const metadata = v.parse(manifest, JSON.parse(contents));
  if (metadata.name !== dependency.name || metadata.version !== dependency.version)
    throw new Error("Bundled dependency version changed; review its patch and notices");
  const name = dependency.name.replaceAll("/", "-").replace("@", "");
  await writeFile(join(destination, `${name}.package.json`), contents);
  if (dependency.name.startsWith("@neon/") || dependency.name === "zod")
    await writeFile(join(destination, `${name}.LICENSE`), await readFile(join(directory, "LICENSE")));
  if (dependency.patch) {
    const patch = await readFile(join(root, "../../patches", dependency.patch));
    await writeFile(join(destination, dependency.patch), patch);
    await writeFile(join(destination, `${name}.patch.sha256`), `${createHash("sha256").update(patch).digest("hex")}\n`);
  }
}
await writeFile(
  join(destination, "README.md"),
  `# Bundled dependencies

Kello tooling bundles the PostgreSQL API from drizzle-kit 1.0.0-rc.4 (published package license: MIT), @neon/config-runtime 1.10.1 and @neon/config 1.9.2 (Apache-2.0), and their Zod 4.6.5 dependency (MIT). Their package metadata, available upstream license files and Kello's modifications are included here. The source map retains the bundled source; license notices remain in the emitted JavaScript.

The Drizzle patch adds explicit rename hints and read-only introspection. The Neon config patch rejects unknown or missing bucket access levels. The bundled @neon/realtime-drizzle 0.1.0 adapter (Apache-2.0) includes Kello's reviewed Drizzle RC4 and parameter-encoding patch. These changes are pinned and tested; consumers do not apply installation patches. Only these five packages are bundled. Their external runtime dependencies, including native esbuild and the official Realtime SDK, are installed normally for the consumer platform. Bundling tooling's Zod keeps it independent of the application's Standard Schema choice and avoids splitting Drizzle's type identity through incompatible peer resolutions.

The published drizzle-kit archive contains no standalone LICENSE file. Its metadata declares MIT; the upstream repository root separately carries Apache-2.0. Publication remains gated on the project's license and namespace review. This artifact record does not resolve that release decision.
`,
);
