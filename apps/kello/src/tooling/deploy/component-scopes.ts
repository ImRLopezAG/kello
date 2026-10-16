import * as v from "valibot";
import type { loadProject } from "../project/load";
import { projectMigrationScopes } from "../migrations/component-scopes";
import { createSnapshot, snapshotHash } from "../migrations/adapter";
import { readMigrations } from "../migrations/history";
import { inspectReleaseSchema, releaseSchemaRangeValidator } from "./compatibility";

export const componentReleaseScopesValidator = v.array(
  v.strictObject({
    mountPath: v.string(),
    namespace: v.string(),
    migrations: v.string(),
    migrationHashes: v.array(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
    schema: releaseSchemaRangeValidator,
  }),
);

export async function defaultComponentReleaseScopes(project: Awaited<ReturnType<typeof loadProject>>) {
  return Promise.all(
    projectMigrationScopes(project)
      .filter((scope) => scope.mountPath)
      .map(async (scope) => {
        const artifacts = await readMigrations(project.root, scope.migrations);
        const head = artifacts.at(-1);
        if (!head) throw new Error(`Generate component migrations before deployment: ${scope.mountPath}`);
        return {
          mountPath: scope.mountPath,
          namespace: scope.namespace,
          migrations: scope.migrations,
          migrationHashes: artifacts.map((entry) => entry.plan.hash),
          schema: { minimum: head.plan.after, maximum: head.plan.after, target: head.plan.after },
        };
      }),
  );
}

export async function inspectComponentReleaseScopes(
  project: Awaited<ReturnType<typeof loadProject>>,
  declared: v.InferOutput<typeof componentReleaseScopesValidator>,
) {
  const scopes = projectMigrationScopes(project).filter((scope) => scope.mountPath);
  if (declared.length !== scopes.length || new Set(declared.map((scope) => scope.mountPath)).size !== scopes.length)
    throw new Error("Release must declare every component migration scope exactly once");
  return Promise.all(
    scopes.map(async (scope) => {
      const options = declared.find((entry) => entry.mountPath === scope.mountPath);
      if (!options || options.namespace !== scope.namespace || options.migrations !== scope.migrations)
        throw new Error("Release component scope identity changed");
      const { mountPath: _mountPath, ...schemaOptions } = options;
      const inspection = await inspectReleaseSchema(project.root, schemaOptions);
      const history = await readMigrations(project.root, scope.migrations);
      const sourceSchema = snapshotHash(await createSnapshot(scope.schema, history.at(-1)?.plan.snapshot));
      if (!inspection.schemas.includes(sourceSchema)) throw new Error("Component compatibility excludes source schema");
      return { ...scope, options: schemaOptions, inspection, sourceSchema };
    }),
  );
}
