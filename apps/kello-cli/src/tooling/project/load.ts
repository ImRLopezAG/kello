import { componentPackageHash } from "./component-package";
import { resolveProjectAuth } from "./auth";
import { validateComponentHttpMounts } from "kello/server";
import type { ComponentHttpRoute } from "kello/server";
import { componentReferences, componentVirtual } from "./component-references";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isKelloSchema,
  isNativeRelations,
  validateSchemaRelations,
  defineRpcAuth,
  isRpcAuthDefinition,
  defineProcedureStorage,
  isProcedureStorage,
  isProcedureCrons,
  compileProcedureCapabilities,
  compileJobMigrations,
  isJobMigrations,
  isApplicationDefinition,
  sealComponentGraph,
  defineRateLimits,
  isRateLimitDefinitions,
} from "kello/server";
import type { RouterContract } from "@orpc/contract";
import { ProcedureContract } from "@orpc/contract";
import type {
  LoadedSchema,
  RpcAuthDefinition,
  ProcedureStorageDefinition,
  ProcedureCron,
  JobMigration,
  prepareApplicationEnvironment,
  RateLimitDefinitions,
} from "kello/server";
import * as v from "valibot";
import type { AnyRelations } from "drizzle-orm";
import { readPublicProjectConfiguration, readResolvedProject } from "../config/resolve";
import { configValidator } from "../config/define-config";
import { resolveProjectPath } from "../config/paths";

import { discoverProcedures, moduleNamespace } from "../codegen/procedures";
import type { BunPlugin } from "bun";
import { projectReferences } from "./references";
import { contractGraph, assertContractImplementations } from "../codegen/contracts";
import { assertSegment } from "../codegen/procedures";
import { sourceFiles } from "./sources";
import {
  componentSetupFiles,
  componentSetupSource,
  resolveComponentSources,
  componentSourceScopes,
  componentBundleSource,
} from "./components";

async function bundleModule(root: string, source: string, plugins: BunPlugin[] = [], readOnly = false) {
  const { build } = await import("bun");
  // Bun resolves external packages relative to the virtual entry's existing parent.
  if (!readOnly) await mkdir(await resolveProjectPath(root, ".kello/modules"), { recursive: true });
  const entry = readOnly ? join(root, "entry.ts") : join(root, ".kello", "entry.ts");
  const result = await build({
    entrypoints: [entry],
    files: { [entry]: source },
    root,
    target: "bun",
    format: "esm",
    packages: "external",
    minify: { whitespace: true },
    plugins: readOnly
      ? [
          ...plugins,
          {
            name: "absolute-config-imports",
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => {
                if (args.path.startsWith("node:") || args.path === "bun") return { path: args.path, external: true };
                return { path: Bun.resolveSync(args.path, args.resolveDir || root), external: true };
              });
            },
          },
        ]
      : plugins,
  });
  if (!result.success) throw new Error("Project TypeScript bundling failed", { cause: result.logs });
  const output = result.outputs[0];
  if (!output || result.outputs.length !== 1) throw new Error("Project bundle must have exactly one JavaScript output");
  const content = await output.text();
  const hash = createHash("sha256").update(content).digest("hex");
  return { content, hash };
}

async function importBundle(root: string, content: string, version: string) {
  const parent = await resolveProjectPath(root, ".kello/modules");
  await mkdir(parent, { recursive: true });
  const directory = join(parent, version);
  const staging = join(parent, `.loading-${crypto.randomUUID()}`);
  const artifacts = {
    "project.mjs": content,
    "version.mjs": `export const version = ${JSON.stringify(version)};\n`,
  };
  await mkdir(staging);
  try {
    await Promise.all(
      Object.entries(artifacts).map(([name, source]) => writeFile(join(staging, name), source, { flag: "wx" })),
    );
    try {
      await rename(staging, directory);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || !["EEXIST", "ENOTEMPTY"].includes(String(cause.code)))
        throw cause;
      for (const [name, source] of Object.entries(artifacts)) {
        if ((await readFile(join(directory, name), "utf8")) !== source)
          throw new Error("Cached project artifact does not match its build identity");
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return v.parse(moduleNamespace, await import(pathToFileURL(join(directory, "project.mjs")).href));
}

async function optionalModule(
  root: string,
  backend: string,
  name: "crons" | "relations" | "auth" | "auth.config" | "storage" | "upgrade" | "rate-limits",
  fallback: string,
): Promise<string> {
  const filename = await resolveProjectPath(root, join(backend, `${name}.ts`));
  try {
    if (!(await stat(filename)).isFile()) throw new Error(`Expected a file at ${backend}/${name}.ts`);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return fallback;
    throw cause;
  }
  const alias = name === "auth.config" ? "auth" : name === "rate-limits" ? "rateLimits" : name;
  return `export { default as ${alias} } from ${JSON.stringify(filename)};`;
}

/** Loads operational configuration without requiring a compilable application schema or functions. */
export async function loadProjectConfig(projectRoot: string, options: { readOnly?: boolean } = {}) {
  const root = await resolveProjectPath(projectRoot, ".");
  const configFile = await resolveProjectPath(root, "kello.config.ts");
  const present = await stat(configFile).then(
    (entry) => {
      if (!entry.isFile()) throw new Error("kello.config.ts must be a file");
      return true;
    },
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
      throw cause;
    },
  );
  const loadedConfig = present
    ? await bundleModule(root, `export { default } from ${JSON.stringify(configFile)};`, [], options.readOnly)
    : undefined;
  const configExports = loadedConfig
    ? options.readOnly
      ? v.parse(
          moduleNamespace,
          await import(`data:text/javascript;base64,${Buffer.from(loadedConfig.content).toString("base64")}`),
        )
      : await importBundle(root, loadedConfig.content, loadedConfig.hash)
    : undefined;
  const authored = v.parse(configValidator, configExports ? configExports.default : {});
  // Validate project/branch conflicts before using saved discovery for operational defaults.
  const publicConfiguration = await readPublicProjectConfiguration(root, authored);
  const saved = await readResolvedProject(root);
  const runtimeRole =
    authored.database.metadataNamespace === "loom_meta"
      ? "loom_runtime"
      : `${authored.database.metadataNamespace}_runtime`;
  const defaults = saved
    ? {
        databaseName: saved.databaseName,
        migrationRole: saved.migrationRole,
        runtimeRole,
      }
    : undefined;
  const config =
    defaults && saved
      ? v.parse(configValidator, {
          ...authored,
          projectId: authored.projectId ?? saved.projectId,
          branchId: authored.branchId ?? saved.branchId,
          development: authored.development ?? defaults,
          deployment: authored.deployment ?? { ...defaults, environment: "preview", deployment: "preview" },
        })
      : authored;
  if (config.database.migrations === `${config.backend}/_generated/migrations`) {
    for (const path of new Set(["kello/migrations", join(config.backend, "migrations")])) {
      const legacy = await resolveProjectPath(root, path);
      const exists = await stat(legacy).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
          throw cause;
        },
      );
      if (exists)
        throw new Error(
          `Move existing migrations from ${path} to ${config.database.migrations}, or explicitly configure database.migrations to retain the legacy path. Replace the _generated directory ignore rule with _generated/* and !_generated/migrations/. Commit migration history.`,
        );
    }
  }
  return {
    config,
    publicConfiguration,
    hash: createHash("sha256")
      .update(loadedConfig?.hash ?? "loom-default-config-v1")
      .update(JSON.stringify(config))
      .digest("hex"),
  };
}

export async function loadProject(projectRoot: string) {
  const root = await resolveProjectPath(projectRoot, ".");
  const { config, publicConfiguration, hash: configHash } = await loadProjectConfig(root);
  const backend = await resolveProjectPath(root, config.backend);
  const setupFiles = await componentSetupFiles(backend);
  await resolveProjectPath(root, config.database.migrations);
  const schemaFile = await resolveProjectPath(root, join(config.backend, "schema.ts"));
  const applicationFile = await resolveProjectPath(root, join(config.backend, "app.config.ts"));
  await stat(applicationFile).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      throw new Error("app.config.ts is required; declare the application and its native contracts before generation");
    throw cause;
  });
  const contractDirectory = await resolveProjectPath(root, join(config.backend, "contracts"));
  const contractModules = (await sourceFiles(root, contractDirectory)).map((file) => ({
    file,
    path: relative(contractDirectory, file).replaceAll("\\", "/"),
  }));
  const contractSource = `import { resolveContract } from "kello/contract";
import { createProjectContext } from "kello/server";
import schema from ${JSON.stringify(schemaFile)};
import relations from "kello:relations";
const { validators } = createProjectContext(schema, relations);
${contractModules.map((module, index) => `import declaration${index} from ${JSON.stringify(module.file)}; export const contract${index} = resolveContract(declaration${index}, { validators });`).join("\n")}
export const contract = ${contractGraph(contractModules, (index) => `contract${index}`)};`;
  const functionsDirectory = await resolveProjectPath(root, join(config.backend, "functions"));
  const files = await sourceFiles(root, functionsDirectory);
  const internalDirectory = await resolveProjectPath(root, join(config.backend, "internal"));
  const internalFiles = await sourceFiles(root, internalDirectory).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  });
  const procedureModules = [
    ...files.map((file) => ({
      file,
      path: relative(functionsDirectory, file).replaceAll("\\", "/"),
      visibility: "public" as const,
    })),
    ...internalFiles.map((file) => ({
      file,
      path: relative(internalDirectory, file).replaceAll("\\", "/"),
      visibility: "internal" as const,
    })),
  ];
  const absentRateLimits = "export const rateLimits = undefined;";
  const rateLimitsSource = await optionalModule(root, config.backend, "rate-limits", absentRateLimits);
  const source = [
    `import schema from ${JSON.stringify(schemaFile)}; export { schema };`,
    `export { default as application } from ${JSON.stringify(applicationFile)};`,
    'export { contract } from "kello:contracts";',
    ...procedureModules.map(({ file }, index) => `export * as module${index} from ${JSON.stringify(file)};`),
    await optionalModule(root, config.backend, "crons", "export const crons = {};"),
    await optionalModule(root, config.backend, "upgrade", "export const upgrade = [];"),
    await optionalModule(root, config.backend, "storage", "export const storage = undefined;"),
    rateLimitsSource,
    await optionalModule(root, config.backend, "auth.config", "export const auth = undefined;"),
    'export { default as relations } from "kello:relations";',
  ].join("\n");
  const relationsFile = join(backend, "relations.ts");
  const hasRelations = await stat(relationsFile).then(
    () => true,
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
      throw cause;
    },
  );
  const builders: string[] = [];
  const applicationReferences = { contracts: contractSource, builders, modules: contractModules };
  const bootstrap = await bundleModule(
    root,
    `import app from ${JSON.stringify(applicationFile)};
export { app as application };
${componentSetupSource(setupFiles)}
import schema from ${JSON.stringify(schemaFile)};
import relations from "kello:relations";
import { contract } from "kello:contracts";
import { createApplicationRpc } from "kello/server";
export const builders = Object.keys(createApplicationRpc(app, { schema, relations, contract }));`,
    [
      componentReferences(setupFiles),
      projectReferences(backend, hasRelations ? relationsFile : undefined, applicationReferences),
    ],
  );
  const bootstrapped = await importBundle(root, bootstrap.content, bootstrap.hash);
  if (!isApplicationDefinition(bootstrapped.application)) throw new Error("Expected defineApplication's result");
  const bootstrapComponents = await resolveComponentSources(
    backend,
    setupFiles,
    bootstrapped,
    sealComponentGraph(bootstrapped.application),
  );
  const mountedSetupFiles = [...new Set(bootstrapComponents.map((node) => node.setupFile))];
  applicationReferences.builders = v.parse(v.array(v.string()), bootstrapped.builders);
  for (const name of applicationReferences.builders) assertSegment(name);
  const scopeSources = await componentSourceScopes(bootstrapComponents);
  if (scopeSources.length) {
    const scopeBootstrap = await bundleModule(
      root,
      scopeSources
        .map(
          (scope) =>
            `export { builders as componentBuilders${scope.index} } from ${JSON.stringify(componentVirtual(scope, "rpc"))};`,
        )
        .join("\n"),
      [componentReferences(setupFiles, scopeSources)],
    );
    const scopeExports = await importBundle(root, scopeBootstrap.content, scopeBootstrap.hash);
    for (const scope of scopeSources) {
      scope.builders = Object.keys(v.parse(moduleNamespace, scopeExports[`componentBuilders${scope.index}`]));
      for (const name of scope.builders) assertSegment(name);
    }
  }
  const loaded = await bundleModule(
    root,
    source + "\n" + componentSetupSource(mountedSetupFiles) + "\n" + componentBundleSource(scopeSources),
    [
      componentReferences(setupFiles, scopeSources),
      projectReferences(backend, hasRelations ? relationsFile : undefined, applicationReferences),
    ],
  );
  const hash = createHash("sha256")
    .update("loom-contract-37\0")
    .update(configHash)
    .update(JSON.stringify(config))
    .update(loaded.hash);
  for (const node of bootstrapComponents) {
    if (!node.packageDescriptor) continue;
    hash.update(node.path).update(JSON.stringify(node.packageDescriptor));
  }
  const packageHashes = new Map<string, string>();
  for (const scope of scopeSources) {
    if (!scope.packageEntry) continue;
    let digest = packageHashes.get(scope.setupFile);
    if (!digest) {
      digest = await componentPackageHash(scope.setupFile, scope.packageEntry);
      packageHashes.set(scope.setupFile, digest);
    }
    hash.update(scope.mountPath).update(digest);
  }
  for (const name of ["package.json", "bun.lock"]) {
    try {
      hash.update(name).update(await readFile(join(root, name)));
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
    }
  }
  const version = hash.digest("hex");
  const exports = await importBundle(root, loaded.content, version);
  const schema: LoadedSchema = v.parse(
    v.custom<LoadedSchema>(isKelloSchema, "Expected defineSchema's result as the schema default export"),
    exports.schema,
  );
  if (schema.metadata.namespace !== config.database.namespace)
    throw new Error("Schema namespace differs from kello.config.ts");
  const relations = v.parse(
    v.custom<AnyRelations>(isNativeRelations, "Expected native Drizzle relations as the relations default export"),
    exports.relations,
  );
  validateSchemaRelations(schema, relations);
  const procedures = discoverProcedures(
    procedureModules.map((module, index) => ({
      path: module.path,
      visibility: module.visibility,
      exports: v.parse(moduleNamespace, exports[`module${index}`]),
    })),
  );
  const application = v.parse(
    v.custom<Parameters<typeof prepareApplicationEnvironment>[0]>(
      isApplicationDefinition,
      "Expected defineApplication's result",
    ),
    exports.application,
  );
  const components = await resolveComponentSources(
    backend,
    mountedSetupFiles,
    exports,
    sealComponentGraph(application),
  );
  validateComponentHttpMounts(
    components
      .filter((node) => node.definition.http?.length)
      .map((node) => ({
        prefix: `/api/components/${node.path}`,
        // SAFETY: validation inspects declarations only and never invokes context-bound handlers.
        routes: node.definition.http as readonly ComponentHttpRoute[],
      })),
  );
  const componentScopes = scopeSources.map((scope) => {
    const schema: LoadedSchema = v.parse(
      v.custom<LoadedSchema>(isKelloSchema),
      exports[`componentSchema${scope.index}`],
    );
    const relations = v.parse(v.custom<AnyRelations>(isNativeRelations), exports[`componentRelations${scope.index}`]);
    validateSchemaRelations(schema, relations);
    const contract = v.parse(
      v.custom<RouterContract>((value) => value instanceof ProcedureContract || v.is(moduleNamespace, value)),
      exports[`componentContract${scope.index}`],
    );
    const procedures = discoverProcedures(
      scope.procedureModules.map((module, index) => ({
        path: module.path,
        visibility: module.visibility,
        exports: v.parse(moduleNamespace, exports[`component${scope.index}Module${index}`]),
      })),
    );
    assertContractImplementations(contract, procedures);
    const crons = v.parse(
      v.custom<Readonly<Record<string, ProcedureCron>>>(isProcedureCrons),
      exports[`componentCrons${scope.index}`] ?? {},
    );
    const storage = v.parse(
      v.custom<ProcedureStorageDefinition>(isProcedureStorage),
      exports[`componentStorage${scope.index}`] ?? defineProcedureStorage(),
    );
    const rateLimits = v.parse(
      v.custom<RateLimitDefinitions>(
        isRateLimitDefinitions,
        "Expected defineRateLimits's result as the component rate-limits default export",
      ),
      scope.rateLimitsFile ? exports[`componentRateLimits${scope.index}`] : defineRateLimits({}),
    );
    const compiled = compileProcedureCapabilities({
      version,
      scope: scope.mountPath,
      internal: procedures
        .filter((entry) => entry.visibility === "internal")
        .map((entry) => ({ scope: scope.mountPath, path: entry.path, procedure: entry.definition })),
      crons,
      storage,
      maxAttempts: config.jobs.maxAttempts,
    });
    return { ...scope, schema, relations, contract, procedures, crons, storage, rateLimits, compiled };
  });
  const contract = v.parse(
    v.custom<RouterContract>((value) => value instanceof ProcedureContract || v.is(moduleNamespace, value)),
    exports.contract,
  );
  assertContractImplementations(contract, procedures);
  const publicPrefixes = new Set(
    procedures.filter((entry) => entry.visibility === "public").map((entry) => entry.path[0]),
  );
  for (const node of components) {
    if (node.public === undefined) continue;
    if (publicPrefixes.has(node.public)) throw new Error(`Conflicting public component prefix: ${node.public}`);
    publicPrefixes.add(node.public);
    const scope = componentScopes.find((entry) => entry.mountPath === node.path);
    if (!scope?.procedures.some((entry) => entry.visibility === "public"))
      throw new Error(`Component has no exported RPCs: ${node.path}`);
  }
  const common = {
    root,
    backend,
    config,
    publicConfiguration,
    schema,
    relations,
    procedures,
    procedureModules,
    application,
    components,
    componentScopes,
    authScopes: await resolveProjectAuth(application, components),
    contractModules,
    builderNames: applicationReferences.builders,
    version,
    bundle: loaded.content,
  };
  const auth = v.parse(
    v.custom<RpcAuthDefinition>(isRpcAuthDefinition, "Expected defineRpcAuth's result as the auth default export"),
    exports.auth === undefined ? defineRpcAuth() : exports.auth,
  );
  const storage = v.parse(
    v.custom<ProcedureStorageDefinition>(
      isProcedureStorage,
      "Expected defineProcedureStorage's result as the storage default export",
    ),
    exports.storage === undefined ? defineProcedureStorage() : exports.storage,
  );
  const rateLimits = v.parse(
    v.custom<RateLimitDefinitions>(
      isRateLimitDefinitions,
      "Expected defineRateLimits's result as the rate-limits default export",
    ),
    rateLimitsSource === absentRateLimits ? defineRateLimits({}) : exports.rateLimits,
  );
  const authoredCrons = v.parse(
    v.custom<Readonly<Record<string, ProcedureCron>>>(
      isProcedureCrons,
      "Expected a record of native procedure cron declarations",
    ),
    exports.crons,
  );
  const jobMigrations = v.parse(
    v.custom<readonly JobMigration[]>(isJobMigrations, "Expected job migration declarations"),
    exports.upgrade,
  );
  compileJobMigrations({
    version,
    internal: [
      ...procedures
        .filter((entry) => entry.visibility === "internal")
        .map((entry) => ({ path: entry.path, procedure: entry.definition })),
      ...componentScopes.flatMap((scope) =>
        scope.procedures
          .filter((entry) => entry.visibility === "internal")
          .map((entry) => ({ scope: scope.mountPath, path: entry.path, procedure: entry.definition })),
      ),
    ],
    migrations: jobMigrations,
  });
  const compiled = compileProcedureCapabilities({
    version,
    internal: procedures
      .filter((entry) => entry.visibility === "internal")
      .map((entry) => ({ path: entry.path, procedure: entry.definition })),
    crons: authoredCrons,
    storage,
    maxAttempts: config.jobs.maxAttempts,
  });
  const allCrons = { ...compiled.crons };
  for (const scope of componentScopes) {
    for (const [name, declaration] of Object.entries(scope.compiled.crons)) {
      const key = `${scope.namespace}-${name}`;
      if (Object.hasOwn(allCrons, key)) throw new Error(`Conflicting cron identity: ${key}`);
      allCrons[key] = declaration;
    }
  }
  return {
    ...common,
    protocol: "loom-orpc-2" as const,
    auth,
    storage,
    rateLimits,
    storageBuckets: Object.freeze(
      [
        ...new Set([
          ...Object.keys(storage.buckets),
          ...componentScopes.flatMap((scope) => Object.keys(scope.storage.buckets)),
        ]),
      ].sort(),
    ),
    authoredCrons,
    jobMigrations,
    crons: Object.freeze(allCrons),
  };
}
