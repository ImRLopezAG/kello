import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startIntegrationBackend } from "../fixtures/integration-examples";
import { startTestNeonAuth } from "../fixtures/neon-auth";

const connectionString = process.env.LOOM_TEST_DATABASE_URL;
function availablePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  void server.stop(true);
  assert(port);
  return port;
}
for (const framework of ["next", "start"] as const)
  for (const route of ["/", "/client"] as const)
    test.skipIf(!connectionString)(
      `${framework} ${route} client auth and live queries work without reloads`,
      async () => {
        assert(connectionString);
        const port = availablePort();
        const origin = `http://localhost:${port}`;
        const pageUrl = `${origin}${route}`;
        const backend = await startIntegrationBackend(connectionString, [origin], framework);
        const auth = await startTestNeonAuth({
          token: backend.token,
          origins: [origin],
          backendUrl: backend.url,
        }).catch(async (cause: unknown) => {
          await backend.stop();
          throw cause;
        });
        const root = fileURLToPath(new URL(`../../examples/${framework}/`, import.meta.url));
        let process: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
        let output: Promise<string> | undefined;
        let errors: Promise<string> | undefined;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          const build = Bun.spawn(["bun", "run", "build"], {
            cwd: root,
            env: {
              ...globalThis.process.env,
              NODE_ENV: "production",
              NEXT_PUBLIC_KELLO_SERVICE_URL: auth.origin,
              VITE_KELLO_SERVICE_URL: auth.origin,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const buildOutput = new Response(build.stdout).text();
          const buildErrors = new Response(build.stderr).text();
          expect(await build.exited, `${await buildOutput} ${await buildErrors}`).toBe(0);
          process = Bun.spawn(
            framework === "next"
              ? ["node", "node_modules/next/dist/bin/next", "start", "--port", String(port)]
              : ["node", ".output/server/index.mjs"],
            {
              cwd: root,
              env: {
                ...globalThis.process.env,
                NODE_ENV: "production",
                NEXT_PUBLIC_KELLO_SERVICE_URL: auth.origin,
                VITE_KELLO_SERVICE_URL: auth.origin,
                NODE_EXTRA_CA_CERTS: auth.caFile,
                PORT: String(port),
                HOST: "127.0.0.1",
              },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          output = new Response(process.stdout).text();
          errors = new Response(process.stderr).text();
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            if (
              await fetch(origin).then(
                (r) => r.ok,
                () => false,
              )
            ) {
              ready = true;
              break;
            }
            if (process.exitCode !== null) throw new Error(`Server exited: ${await output} ${await errors}`);
            await Bun.sleep(100);
          }
          assert(ready, "Production server must start");
          const alice = await backend.token("alice");
          const bob = await backend.token("bob");
          expect((await fetch(`${origin}/api/auth/get-session`)).status).toBe(404);
          const [a, b] = await Promise.all(
            [alice, bob].map(async (token) => {
              const response = await fetch(pageUrl, { headers: { authorization: `Bearer ${token}` } });
              expect(response.status).toBe(200);
              return response.text();
            }),
          );
          expect(a).not.toContain("Signed in as alice");
          expect(a).not.toContain(bob);
          expect(a).not.toContain(alice);
          expect(b).not.toContain("Signed in as bob");
          expect(b).not.toContain("Signed in as alice");
          browser = await chromium.launch({ headless: true });
          const aliceContext = await browser.newContext({ ignoreHTTPSErrors: true });
          const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
          for (const [context, user] of [
            [aliceContext, "alice"],
            [bobContext, "bob"],
          ] as const) {
            const page = await context.newPage();
            await page.goto(pageUrl);
            await page.evaluate(() => document.documentElement.setAttribute("data-navigation-test", "same-document"));
            await page.getByLabel("Email", { exact: true }).fill(`${user}@example.test`);
            await page.getByLabel("Password", { exact: true }).fill("fixture-password");
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            await page
              .getByText("Live updates connected", { exact: true })
              .waitFor()
              .catch(async (cause: unknown) => {
                throw new Error(`Client session or live query failed: ${await page.locator("body").innerText()}`, {
                  cause,
                });
              });
            expect(await page.locator("html").getAttribute("data-navigation-test")).toBe("same-document");
            await page.close();
          }
          const first = await aliceContext.newPage();
          const second = await aliceContext.newPage();
          const other = await bobContext.newPage();
          const pageErrors: string[] = [];
          const sentFrames: string[] = [];
          for (const page of [first, second, other]) {
            page.on("pageerror", (e) => pageErrors.push(e.message));
            page.on("websocket", (socket) =>
              socket.on("framesent", ({ payload }) => sentFrames.push(payload.toString())),
            );
            await page.goto(pageUrl);
            await page.getByText("Live updates connected", { exact: true }).waitFor();
          }
          await first.getByLabel("New note").fill("Shared across SSR and live");
          await first.getByRole("button", { name: "Add note" }).click();
          await second.getByText("Shared across SSR and live", { exact: true }).waitFor();
          expect(await other.getByText("Shared across SSR and live", { exact: true }).count()).toBe(0);
          const html = await (await fetch(pageUrl, { headers: { authorization: `Bearer ${alice}` } })).text();
          expect(html).not.toContain("Shared across SSR and live");
          expect(html).not.toContain(alice);
          const bobHtml = await (await fetch(pageUrl, { headers: { authorization: `Bearer ${bob}` } })).text();
          expect(bobHtml).not.toContain("Shared across SSR and live");
          await first.setViewportSize({ width: 390, height: 844 });
          expect(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await first.screenshot({
            path: `/tmp/loom-${framework}${route === "/client" ? "-client" : ""}-mobile.png`,
            fullPage: true,
          });
          await first.setViewportSize({ width: 1360, height: 900 });
          await first.screenshot({
            path: `/tmp/loom-${framework}${route === "/client" ? "-client" : ""}-desktop.png`,
            fullPage: true,
          });
          await first.evaluate(() => document.documentElement.setAttribute("data-navigation-test", "same-document"));
          await first.getByRole("button", { name: "Sign out" }).click();
          await first.getByRole("button", { name: "Sign in", exact: true }).waitFor();
          expect(await first.locator("html").getAttribute("data-navigation-test")).toBe("same-document");
          await second.reload();
          await second.getByRole("button", { name: "Sign in", exact: true }).waitFor();
          await second.getByLabel("Email", { exact: true }).fill("bob@example.test");
          await second.getByLabel("Password", { exact: true }).fill("fixture-password");
          await second.getByRole("button", { name: "Sign in", exact: true }).click();
          await second.getByText("Signed in as bob", { exact: true }).waitFor();
          await second.getByText("Live updates connected", { exact: true }).waitFor();
          expect(await second.getByText("Shared across SSR and live", { exact: true }).count()).toBe(0);
          expect(sentFrames.some((frame) => frame.includes("/examples/watch"))).toBe(true);
          expect(sentFrames.some((frame) => frame.includes("/examples/notes"))).toBe(false);
          expect(pageErrors).toEqual([]);
        } finally {
          try {
            await browser?.close();
          } finally {
            process?.kill();
            await process?.exited;
            await Promise.all([output, errors]);
            try {
              await auth.stop();
            } finally {
              await backend.stop();
            }
          }
        }
      },
      120_000,
    );
