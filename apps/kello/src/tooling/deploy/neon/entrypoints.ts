import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNeonActivationVerifier } from "kello/neon";
import type { NeonActivationOptions, NeonTriggerBinding } from "kello/neon";
import { loadProject } from "../../project/load";
import { prepareProject } from "../../codegen/generate";
import { neonInjectedVariables } from "./environment";
import { resolveProjectPath } from "../../config/paths";

/** Writes immutable deployment bootstraps without resolving or storing secret values. */
export async function prepareNeonEntrypoints(
  root: string,
  input: NeonActivationOptions,
  triggers: Readonly<Record<string, NeonTriggerBinding>>,
) {
  const binding = structuredClone(input);
  try {
    createNeonActivationVerifier(binding);
  } catch {
    throw new Error("Invalid deployment activation binding");
  }
  const bindings = Object.fromEntries(
    Object.entries(structuredClone(triggers)).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  const project = await loadProject(root);
  if (project.version !== binding.version || project.config.database.metadataNamespace !== binding.metadataNamespace)
    throw new Error("Deployment binding does not match the current project generation");
  const notify = project.config.realtime.mode === "notify";
  const directRuntimeUrlEnv = project.config.database.directRuntimeUrlEnv;
  const runtimeUrlEnv = project.config.database.runtimeUrlEnv;
  const storage = project.storageBuckets.length > 0;
  if (
    [...neonInjectedVariables, "LOOM_ACTIVATION_TOKEN", "LOOM_SEARCH_CURSOR_KEY"].some(
      (name) => name === runtimeUrlEnv || (notify && name === directRuntimeUrlEnv),
    )
  )
    throw new Error("Runtime credentials must use a separate deployment environment variable");
  const generation = await prepareProject(project.root);
  if (generation.version !== binding.version) throw new Error("Project changed during deployment preparation");
  const hash = createHash("sha256")
    .update("kello-neon-entry-8\0")
    .update(JSON.stringify({ binding, bindings, runtimeUrlEnv, directRuntimeUrlEnv, notify, storage }))
    .digest("hex");
  const directory = await resolveProjectPath(project.root, `.loom/deploy/${hash}`);
  await mkdir(directory, { recursive: true });
  // Release artifacts must survive pruning the disposable development generations.
  const runtimeDirectory = join(directory, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const generationDirectory = join(project.root, ".loom/generations", generation.version);
  for (const entry of await readdir(generationDirectory)) {
    const content = await readFile(join(generationDirectory, entry));
    const destination = join(runtimeDirectory, entry);
    try {
      await writeFile(destination, content, { flag: "wx" });
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      if (!(await readFile(destination)).equals(content)) throw new Error("Deployment runtime artifact changed");
    }
  }
  for (const [name, factory] of [
    ["service", "createService"],
    ["worker", "createWorker"],
  ] as const) {
    const factoryPath = `./runtime/${name}.js`;
    const runtimeOptions = [
      "connectionString",
      `deployment: ${JSON.stringify(binding.deployment)}`,
      `branchId: ${JSON.stringify(binding.branchId)}`,
      "assertActive",
      "assertIngress",
    ];
    if (notify) runtimeOptions.push(`directConnectionString: process.env[${JSON.stringify(directRuntimeUrlEnv)}]`);
    if (storage)
      runtimeOptions.push(
        `storageBackend: createNeonStorageBackend(${JSON.stringify({ projectId: binding.projectId, branchId: binding.branchId })})`,
      );
    if (name === "worker")
      runtimeOptions.push(
        `bindings: await loadNeonTriggerBindings(${JSON.stringify(binding)}, connectionString, assertActive)`,
      );
    const contents = [
      `import { createNeonDeploymentEntrypoint${name === "worker" ? ", loadNeonTriggerBindings" : ""}${storage ? ", createNeonStorageBackend" : ""} } from "kello/neon";`,
      `import { ${factory} } from ${JSON.stringify(factoryPath)};`,
      `export default createNeonDeploymentEntrypoint({ binding: ${JSON.stringify(binding)}, artifactHash: ${JSON.stringify(hash)}, role: ${JSON.stringify(name)}, start: async (assertActive, assertIngress) => {`,
      `  const connectionString = process.env[${JSON.stringify(runtimeUrlEnv)}];`,
      '  if (!connectionString) throw new Error("Runtime connection missing");',
      `  return ${factory}({ ${runtimeOptions.join(", ")} });`,
      "} });",
      "",
    ].join("\n");
    const filename = join(directory, `${name}.mjs`);
    try {
      await writeFile(filename, contents, { flag: "wx" });
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      if ((await readFile(filename, "utf8")) !== contents) throw new Error("Deployment entry artifact changed");
    }
  }
  return Object.freeze({
    directory,
    hash,
    binding: Object.freeze(binding),
    service: join(directory, "service.mjs"),
    worker: join(directory, "worker.mjs"),
  });
}
