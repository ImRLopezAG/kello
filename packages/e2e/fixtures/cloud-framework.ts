import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser } from "playwright";

/** Hosts only the built frontend; auth, RPC and live issuance remain on Neon. */
export async function startCloudFramework(root: string, framework: "next" | "start", origin: URL) {
  const child = Bun.spawn(
    framework === "next"
      ? [
          "node",
          join(root, "node_modules/next/dist/bin/next"),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          origin.port,
        ]
      : ["node", join(root, ".output/server/index.mjs")],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", PORT: origin.port, HOST: "127.0.0.1" },
      stdin: "ignore",
      stdout: "ignore",
      // Build/server output may contain configuration. Never copy it to provider logs.
      stderr: "ignore",
    },
  );
  async function stop() {
    if (child.exitCode === null) child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    try {
      await child.exited;
    } finally {
      clearTimeout(deadline);
    }
  }
  try {
    const signal = AbortSignal.timeout(30_000);
    while (!signal.aborted) {
      if (child.exitCode !== null) throw new Error("Framework frontend exited before readiness");
      const response = await fetch(origin, { signal }).catch(() => undefined);
      if (response?.ok) return { stop };
      await Bun.sleep(100);
    }
    throw new Error("Framework frontend readiness timed out");
  } catch (cause) {
    await stop();
    throw cause;
  }
}

export async function verifyCloudFramework(browser: Browser, origin: URL, functionUrl: string, diagnostics: string[]) {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  try {
    const first = await alice.newPage();
    const second = await alice.newPage();
    const other = await bob.newPage();
    const errors: string[] = [];
    const rpcOrigins = new Set<string>();
    const authOrigins = new Set<string>();
    for (const page of [first, second, other]) {
      page.on("pageerror", (error) => errors.push(error.name));
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/kello/rpc/")) rpcOrigins.add(url.origin);
        if (url.pathname.startsWith("/api/auth/")) authOrigins.add(url.origin);
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        const category = path.startsWith("/api/auth/") ? "auth" : path.startsWith("/api/kello/") ? "rpc" : undefined;
        if (category && response.status() >= 400) diagnostics.push(`${category}: ${response.status()}`);
      });
    }
    const email = `kello-${crypto.randomUUID()}@example.test`;
    const password = crypto.randomUUID();
    const otherEmail = `kello-${crypto.randomUUID()}@example.test`;
    async function register(page: typeof first, user: string) {
      await page.goto(origin.href);
      await page.evaluate(() => document.documentElement.setAttribute("data-navigation-test", "same-document"));
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Cloud acceptance");
      await page.getByLabel("Email", { exact: true }).fill(user);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await page.getByLabel("New note", { exact: true }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-navigation-test"), "same-document");
    }
    await register(first, email);
    await register(other, otherEmail);
    const otherNote = `Other account note ${crypto.randomUUID()}`;
    await other.getByLabel("New note", { exact: true }).fill(otherNote);
    await other.getByRole("button", { name: "Add note", exact: true }).click();
    await other.getByText(otherNote, { exact: true }).waitFor();
    await second.goto(new URL("/client", origin).href);
    await second.getByLabel("New note", { exact: true }).waitFor();
    const note = `Private live note ${crypto.randomUUID()}`;
    await first.getByLabel("New note", { exact: true }).fill(note);
    await first.getByRole("button", { name: "Add note", exact: true }).click();
    // No reload or refetch action: both independent SDK subscriptions must install the write.
    await first.getByText(note, { exact: true }).waitFor();
    await second.getByText(note, { exact: true }).waitFor();
    assert.equal(await other.getByText(note, { exact: true }).count(), 0);
    for (const route of ["/", "/client"]) {
      const response = await fetch(new URL(route, origin));
      assert.equal(response.status, 200);
      const html = await response.text();
      assert(!html.includes(note) && !html.includes(email), "Public SSR must not contain private rows or identity");
    }
    assert.equal((await fetch(new URL("/api/auth/get-session", origin))).status, 404);
    assert.equal((await fetch(new URL("/api/kello/rpc/examples/greeting", origin))).status, 404);
    assert.deepEqual([...rpcOrigins], [new URL(functionUrl).origin], "RPC must target Neon Functions directly");
    assert.deepEqual([...authOrigins], [new URL(functionUrl).origin], "Auth must target Neon Functions directly");
    await first.setViewportSize({ width: 390, height: 844 });
    assert(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await first.getByRole("button", { name: "Sign out", exact: true }).click();
    await first.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await second.reload();
    await second.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await second.getByText(note, { exact: true }).count(), 0);
    await first.getByLabel("Email", { exact: true }).fill(email);
    await first.getByLabel("Password", { exact: true }).fill(password);
    await first.getByRole("button", { name: "Sign in", exact: true }).click();
    await first.getByText(note, { exact: true }).waitFor();
    await first.getByRole("button", { name: "Sign out", exact: true }).click();
    await first.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await second.reload();
    await second.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await second.getByLabel("Email", { exact: true }).fill(otherEmail);
    await second.getByLabel("Password", { exact: true }).fill(password);
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await second.getByText(otherNote, { exact: true }).waitFor();
    assert.equal(await second.getByText(note, { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    try {
      await alice.close();
    } finally {
      await bob.close();
    }
  }
}
