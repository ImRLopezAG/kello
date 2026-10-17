import { expect, test } from "bun:test";
import * as v from "valibot";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { chromium } from "playwright";
import { browserBundle } from "./bundle";

test("native optimistic state survives refetch until the mutation settles", async () => {
  const bundle = await browserBundle("rpc-transport.tsx");
  expect(bundle).not.toContain("DATABASE_URL");
  let calls = 0;
  let stopped = 0;
  let count = 1;
  const write = Promise.withResolvers<void>();
  const router = {
    write: os.input(v.number()).handler(async ({ input }) => {
      await write.promise;
      count = input;
      return count;
    }),
    read: os.handler(async function* ({ signal }) {
      calls++;
      try {
        yield { count };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        stopped++;
      }
    }),
  };
  const handler = new RPCHandler(router);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/kello/rpc/")) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("x-loom-version")).toBe("a".repeat(64));
        return (
          (await handler.handle(request, { prefix: "/api/kello/rpc" })).response ?? new Response(null, { status: 404 })
        );
      }
      if (path === "/client.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      return new Response(
        '<html><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.getByTestId("one").filter({ hasText: "1" }).waitFor();
    expect(await page.getByTestId("two").textContent()).toBe("1");
    expect(calls).toBe(1);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTestId("one").filter({ hasText: "9" }).waitFor();
    expect(await page.getByTestId("mutation").textContent()).toBe("pending");
    await page.getByRole("button", { name: "Refetch", exact: true }).click();
    for (let attempt = 0; attempt < 20 && calls !== 2; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(2);
    expect(await page.getByTestId("two").textContent()).toBe("9");
    write.resolve();
    await page.getByTestId("mutation").filter({ hasText: "success" }).waitFor();
    for (let attempt = 0; attempt < 20 && calls !== 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(3);
    expect(await page.getByTestId("one").textContent()).toBe("9");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByText("Signed out").waitFor();
    expect(await page.getByTestId("one").count()).toBe(0);
    for (let attempt = 0; attempt < 20 && stopped !== 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(3);
  } finally {
    write.resolve();
    await browser.close();
    await server.stop(true);
  }
}, 20_000);
