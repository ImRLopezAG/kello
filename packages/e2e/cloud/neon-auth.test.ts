import * as v from "valibot";
import { verifyCloudUploadWorkflow } from "../fixtures/cloud-upload-workflow";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import {
  createKelloNeonApi,
  applyMigrations,
  deployProjectRelease,
  enableRealtime,
  NeonFunctionHealthError,
  inspectDeploymentTarget,
  defineConfig,
  generateProject,
  generateRelease,
  loadProjectConfig,
  readNeonFunctionReceipt,
} from "kello/tooling";
import { verifyCloudAppPeers } from "../fixtures/cloud-app-peers";
import { verifyCloudComponentBrowser } from "../fixtures/cloud-component-browser";
import { startCloudFramework, verifyCloudFramework } from "../fixtures/cloud-framework";
import { startCloudFrontend } from "../fixtures/cloud-frontend";
import { verifyCloudSchemaExpansion } from "../fixtures/cloud-schema-expansion";

test.skipIf(process.env.LOOM_CLOUD_NEON_AUTH !== "1")(
  "Neon Auth signs in the actual example against Neon Functions",
  async () => {
    const example = v.parse(
      v.picklist(["tasks", "jobs-storage", "next", "start", "components"]),
      process.env.LOOM_CLOUD_AUTH_EXAMPLE ?? "tasks",
    );
    const projectId = process.env.KELLO_CLOUD_PROJECT_ID;
    const branchId = process.env.LOOM_CLOUD_BRANCH_ID;
    const authUrl = process.env.VITE_NEON_AUTH_URL;
    const connectionString = process.env.LOOM_MIGRATION_DATABASE_URL;
    assert(projectId && branchId && authUrl && connectionString);
    const target = await inspectDeploymentTarget(
      defineConfig({ project: example, provider: { projectId, targets: { preview: { branchId } } } }),
      "preview",
    );
    assert.match(target.branchName, /^loom-acceptance-/);
    const provider = createKelloNeonApi();
    const fixtures = fileURLToPath(new URL("../.cloud-receipts/", import.meta.url));
    await mkdir(fixtures, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(fixtures, "neon-auth-"));
    const admin = new pg.Client({ connectionString });
    const browser = await chromium.launch({ headless: true });
    const frontend = startCloudFrontend(root, async () => {
      throw new Error("Test identities are disabled");
    });
    // Neon Auth's allow-localhost setting accepts localhost, not the loopback IP.
    const frontendUrl = new URL(frontend.url);
    frontendUrl.hostname = "localhost";
    const previousOrigins = process.env.APP_ORIGINS;
    const previousCookieSecret = process.env.NEON_AUTH_COOKIE_SECRET;
    process.env.APP_ORIGINS = frontendUrl.origin;
    process.env.NEON_AUTH_COOKIE_SECRET = crypto.randomUUID() + crypto.randomUUID();
    let framework: Awaited<ReturnType<typeof startCloudFramework>> | undefined;
    let stage = "copy";
    let passed = false;
    const diagnostics: string[] = [];
    try {
      const source = fileURLToPath(new URL(`../../examples/${example}/`, import.meta.url));
      await cp(source, root, {
        recursive: true,
        filter: (path) =>
          !["node_modules", "dist", "_generated", ".kello", ".turbo", ".next", ".output"].includes(basename(path)),
      });
      await cp(join(source, "kello/migrations"), join(root, "kello/migrations"), {
        recursive: true,
      });
      await symlink(join(source, "node_modules"), join(root, "node_modules"));
      const address = new URL(connectionString);
      const runtimeRole = process.env.LOOM_CLOUD_RUNTIME_ROLE;
      assert(
        runtimeRole && /^runtime_[a-f0-9]{32}$/.test(runtimeRole),
        "Use the runtime role from the owned acceptance branch",
      );
      const { config: exampleConfig } = await loadProjectConfig(source);
      // Each hook run exercises schema expansion independently of retained deployments.
      const namespace = example === "tasks" ? `accept_${runtimeRole.slice(8)}` : exampleConfig.database.namespace;
      const metadataNamespace = example === "tasks" ? `loom_${namespace}` : exampleConfig.database.metadataNamespace;
      if (example === "tasks") {
        const schemaPath = join(root, "kello/schema.ts");
        const original = await readFile(schemaPath, "utf8");
        const scoped = original.replace('{ namespace: "app" }', `{ namespace: "${namespace}" }`);
        assert.notEqual(scoped, original, "Tasks fixture must declare its isolated namespace");
        await writeFile(schemaPath, scoped);
        // Only the disposable copy is regenerated; committed example migrations stay unchanged.
        await rm(join(root, "kello/migrations"), { recursive: true, force: true });
      }
      const config = {
        project: example,
        database: { ...exampleConfig.database, namespace, metadataNamespace, migrations: "kello/migrations" },
        provider: { projectId, targets: { preview: { branchId } } },
        auth: {
          origins: [frontendUrl.origin],
          issuers: [{ issuer: new URL(authUrl).origin, jwksUrl: `${authUrl}/.well-known/jwks.json` }],
        },
        deployment: {
          environment: "preview",
          deployment: "preview",
          databaseName: decodeURIComponent(address.pathname.slice(1)),
          migrationRole: decodeURIComponent(address.username),
          runtimeRole,
          quarantine: "preserve",
          variables: {
            APP_ORIGINS: "APP_ORIGINS",
            NEON_AUTH_COOKIE_SECRET: "NEON_AUTH_COOKIE_SECRET",
          },
        },
      } satisfies Parameters<typeof defineConfig>[0];
      await writeFile(
        join(root, "kello.config.ts"),
        `import { defineConfig } from "kello/tooling"; export default defineConfig(${JSON.stringify(config)});`,
      );
      if (example === "tasks") await generateRelease(root, "acceptance-initial");
      let generated = await generateProject(root);
      stage = "restricted runtime";
      await applyMigrations({
        connectionString,
        root,
        runtimeRole,
        namespace: config.database.namespace,
        metadataNamespace: config.database.metadataNamespace,
        migrations: "kello/migrations",
      });
      await admin.connect();
      const password = crypto.randomUUID();
      await admin.query(`ALTER ROLE "${runtimeRole}" LOGIN PASSWORD '${password}'`);
      address.username = runtimeRole;
      address.password = password;
      process.env.LOOM_DATABASE_URL = address.href;
      process.env.LOOM_ACTIVATION_TOKEN = crypto.randomUUID().replaceAll("-", "").repeat(2);
      stage = "enable example Realtime";
      const realtime = await enableRealtime(root, defineConfig(config), {
        allowedOrigins: [frontendUrl.origin],
        timeoutMs: 120_000,
        selection: { projectId, branch: branchId, databaseName: config.deployment.databaseName },
      });
      assert.equal(realtime.state, "ready", "Example Realtime must be ready before deployment");
      stage = "deploy Neon Auth configuration";
      const release = await deployProjectRelease(root, "kello.config.ts", provider, AbortSignal.timeout(240000));
      const functionStage = release.completed.find((entry) => entry.stage === "functions");
      assert(functionStage);
      let deployed = await readNeonFunctionReceipt(root, functionStage.artifactHash);
      let url = deployed.functions[0].invocationUrl;
      assert(url);
      stage = "build Neon Auth frontend";
      async function buildFrontend(invocationUrl: string) {
        const build = Bun.spawn(["bun", "run", "build"], {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "production",
            VITE_LOOM_ACCEPTANCE: "0",
            VITE_NEON_AUTH_URL: authUrl,
            VITE_LOOM_URL: invocationUrl,
            NEXT_PUBLIC_KELLO_SERVICE_URL: invocationUrl,
            VITE_KELLO_SERVICE_URL: invocationUrl,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(build.stdout).text(),
          new Response(build.stderr).text(),
          build.exited,
        ]);
        if (exitCode !== 0) {
          await writeFile(join(root, "frontend-build.log"), `${stdout}\n${stderr}`, { mode: 0o600 });
        }
        assert.equal(exitCode, 0);
      }
      await buildFrontend(url);
      if (example === "next" || example === "start") {
        stage = "start production framework frontend";
        await frontend.stop();
        framework = await startCloudFramework(root, example, frontendUrl);
      }

      stage = "browser signup";
      let schemaExpansion: Awaited<ReturnType<typeof verifyCloudSchemaExpansion>>["evidence"] | undefined;
      if (example === "next" || example === "start") {
        stage = "direct Function auth, RPC and SDK browser delivery";
        await verifyCloudFramework(browser, frontendUrl, url, diagnostics);
      } else if (example === "components") {
        stage = "component SDK browser isolation, pause and validation";
        await verifyCloudComponentBrowser(browser, frontendUrl, diagnostics);
      } else {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.name));
        page.on("response", (response) => {
          if (response.status() >= 400) diagnostics.push(`${new URL(response.url()).pathname}: ${response.status()}`);
        });
        page.on("requestfailed", (request) => diagnostics.push(`${new URL(request.url()).pathname}: network failure`));
        await page.goto(frontendUrl.href);
        await page.getByRole("button", { name: "Create an account", exact: true }).click();
        const email = `loom-${crypto.randomUUID()}@example.test`;
        const userPassword = crypto.randomUUID();
        async function signIn() {
          {
            const ready = page.getByLabel(example === "tasks" ? "Project name" : "Choose a file", { exact: true });
            await page.getByLabel("Email", { exact: true }).or(ready).first().waitFor();
            if (await ready.isVisible()) return;
          }
          await page.getByLabel("Email", { exact: true }).fill(email);
          await page.getByLabel("Password", { exact: true }).fill(userPassword);
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
        }
        await page.getByLabel("Name", { exact: true }).fill("Neon acceptance");
        await page.getByLabel("Email", { exact: true }).fill(email);
        await page.getByLabel("Password", { exact: true }).fill(userPassword);
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        await page
          .getByLabel(example === "tasks" ? "Project name" : "Choose a file")
          .waitFor()
          .catch(async () => {
            const alerts = await page.getByRole("alert").allTextContents();
            diagnostics.push(
              ...alerts.map((alert) => alert.replaceAll(email, "[email]").replaceAll(userPassword, "[password]")),
            );
            throw new Error("Signup did not establish a session");
          });
        if (example === "tasks") {
          stage = "authenticated mutation and live query";
          await page.getByLabel("Project name").fill("Neon Auth workspace");
          await page.getByRole("button", { name: "Create project", exact: true }).click();
          await page.getByLabel("Task title").fill("Real authenticated task");
          await page.getByRole("button", { name: "Add task", exact: true }).click();
          await page.getByRole("checkbox", { name: "Real authenticated task" }).waitFor();
        } else {
          stage = "provider uploads, events and durable processing";
          await verifyCloudUploadWorkflow(page);
        }
        stage = "SDK peer delivery and account isolation";
        await verifyCloudAppPeers(browser, page, frontendUrl, example);
        if (example === "tasks") {
          stage = "safe schema expansion and compatible deployment";
          await page.goto("about:blank");
          const expanded = await verifyCloudSchemaExpansion(root, admin, provider, async () => {
            await page.goto(frontendUrl.href);
            await signIn();
            await page.getByRole("checkbox", { name: "Real authenticated task" }).waitFor();
            await page.goto("about:blank");
          });
          generated = expanded.generated;
          deployed = expanded.deployed;
          schemaExpansion = expanded.evidence;
          url = deployed.functions[0].invocationUrl;
          assert(url);
          await buildFrontend(url);
          await page.goto(frontendUrl.href);
          await signIn();
          await page.getByRole("checkbox", { name: "Real authenticated task" }).waitFor();
          await page.getByLabel("Task title").fill("Task after schema expansion");
          await page.getByRole("button", { name: "Add task", exact: true }).click();
          await page.getByRole("checkbox", { name: "Task after schema expansion" }).waitFor();
        }
        stage = "sign out and sign back in";
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await signIn();
        if (example === "tasks") await page.getByRole("checkbox", { name: "Real authenticated task" }).waitFor();
        else await page.getByRole("article", { name: "uploads", exact: true }).waitFor();
        assert.deepEqual(errors, []);
      }
      passed = true;
      if (process.env.LOOM_CLOUD_RECEIPT)
        await writeFile(
          process.env.LOOM_CLOUD_RECEIPT,
          JSON.stringify(
            {
              example,
              namespace,
              metadataNamespace,
              runtimeRole,
              projectId,
              branchId,
              region: process.env.LOOM_CLOUD_REGION,
              version: generated.version,
              schemaExpansion,
              functions: deployed.functions.map(({ role, functionId, deploymentId, invocationUrl }) => ({
                role,
                functionId,
                deploymentId,
                invocationUrl,
              })),
              passed: true,
              completedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
    } catch (cause) {
      if (cause instanceof NeonFunctionHealthError)
        diagnostics.push(
          JSON.stringify({
            healthStage: cause.stage,
            aborted: cause.aborted,
            status: cause.status,
            identityMismatch: cause.identityMismatch,
          }),
        );
      const frames =
        cause instanceof Error
          ? cause.stack
              ?.split("\n")
              .filter((line) => /^\s+at .*:\d+:\d+\)?$/.test(line))
              .slice(0, 5)
              .join("\n")
          : "";
      if (cause instanceof Error && /^Could not prepare Neon schedule triggers during [a-z ]+$/.test(cause.message))
        diagnostics.push(cause.message);
      diagnostics.push(`retained fixture: ${root}`);
      throw new Error(`Neon Auth acceptance failed during ${stage}; ${diagnostics.join("; ")}\n${frames}`);
    } finally {
      if (previousOrigins === undefined) delete process.env.APP_ORIGINS;
      else process.env.APP_ORIGINS = previousOrigins;
      if (previousCookieSecret === undefined) delete process.env.NEON_AUTH_COOKIE_SECRET;
      else process.env.NEON_AUTH_COOKIE_SECRET = previousCookieSecret;
      try {
        await browser.close();
      } finally {
        try {
          await framework?.stop();
        } finally {
          try {
            await frontend.stop();
          } finally {
            await admin.end();
          }
        }
      }
      if (passed) await rm(root, { recursive: true, force: true });
    }
  },
  600000,
);
