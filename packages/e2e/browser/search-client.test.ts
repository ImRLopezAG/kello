import assert from "node:assert/strict";
import { test } from "bun:test";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import type { ServerWebSocket } from "bun";
import { chromium } from "playwright";
import { defineRelations } from "drizzle-orm";
import { createProjectContext, defineSchema, searchPublicNode } from "kello/server";
import { browserBundle } from "./bundle";

const schema = defineSchema((s) => ({ tasks: { title: s.text().notNull(), done: s.boolean().notNull() } }), {
  namespace: "app",
});
const { validators } = createProjectContext(schema, defineRelations(schema.tables));
const search = validators.tables.tasks.liveSearch({ scope: "public", columns: ["title", "done"], filter: ["title"] });

test("packed native liveOptions isolates replacement projections and identities", async () => {
  const bundle = await browserBundle("search-client.tsx");
  assert(!bundle.includes("DATABASE_URL"));
  const delayed = Promise.withResolvers<void>();
  const filtered = Promise.withResolvers<void>();
  const calls: { subject: string; pages: number; done: boolean; filtered: boolean }[] = [];
  let stopped = 0;
  const router = {
    watch: os
      .$context<{ subject: string }>()
      .input(search.input)
      .output(search.output)
      .handler(async function* ({ context, input, signal }) {
        calls.push({
          subject: context.subject,
          pages: input.loadedPages ?? 1,
          done: input.columns?.done === true,
          filtered: Boolean(input.where),
        });
        try {
          if (input.columns?.done) await (input.where ? filtered.promise : delayed.promise);
          const rows = Array.from({ length: 2 * (input.loadedPages ?? 1) }, (_, index) =>
            input.columns?.done ? { done: Boolean(input.where) } : { title: `${context.subject}-${index}` },
          );
          yield {
            pages: Array.from({ length: input.loadedPages ?? 1 }, (_, index) => rows.slice(index * 2, (index + 1) * 2)),
            nextCursor: null,
            previousCursor: null,
          };
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
  const tickets = new Map<string, string>();
  const sockets = new Set<ServerWebSocket<{ subject: string }>>();
  const server = Bun.serve<{ subject: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/kello/ticket") {
        const subject = request.headers.get("authorization")?.slice(7);
        assert(subject === "alice" || subject === "bob");
        const ticket = crypto.randomUUID().replaceAll("-", "").padEnd(43, "x");
        tickets.set(ticket, subject);
        return Response.json({ ticket, expiresAt: Date.now() / 1000 + 60 });
      }
      if (path === "/api/kello/socket") {
        const token = request.headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((value) => value.trim())
          .find((value) => value.startsWith("kello.ticket."))
          ?.slice("kello.ticket.".length);
        const subject = token ? tickets.get(token) : undefined;
        assert(subject);
        if (server.upgrade(request, { data: { subject }, headers: { "sec-websocket-protocol": "kello.orpc.2" } }))
          return;
      }
      if (path === "/client.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      return new Response(
        `<html><body><div id="root"></div><script id="search-policy" type="application/json">${JSON.stringify(searchPublicNode(search.input))}</script><script type="module" src="/client.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      async message(socket, message) {
        await handler.message(socket, message, { context: socket.data });
      },
      async close(socket) {
        sockets.delete(socket);
        await handler.close(socket);
      },
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByTestId("window").filter({ hasText: "alice-1" }).waitFor();
    assert.deepEqual(JSON.parse((await page.getByTestId("window").textContent()) ?? "null"), {
      pages: [[{ title: "alice-0" }, { title: "alice-1" }]],
      nextCursor: null,
      previousCursor: null,
    });
    assert.equal(calls.length, 1);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByTestId("window").filter({ hasText: "alice-3" }).waitFor();
    assert.equal(calls.length, 2);
    await page.getByRole("button", { name: "Done projection", exact: true }).click();
    await page.getByTestId("window").filter({ hasText: "loading" }).waitFor();
    assert(!(await page.getByTestId("window").textContent())?.includes("title"));
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    delayed.resolve();
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId("window").textContent(), "loading");
    filtered.resolve();
    await page.getByTestId("window").filter({ hasText: '"done":true' }).waitFor();
    // Native application values contain only the selected rows and cursors.
    // Private dependency/revision evidence must not enter the client cache.
    assert.deepEqual(JSON.parse((await page.getByTestId("window").textContent()) ?? "null"), {
      pages: [
        [{ done: true }, { done: true }],
        [{ done: true }, { done: true }],
      ],
      nextCursor: null,
      previousCursor: null,
    });
    assert.equal(await page.getByTestId("state").textContent(), "success");
    await page.getByRole("button", { name: "Switch identity", exact: true }).click();
    await page.getByTestId("window").filter({ hasText: "bob-1" }).waitFor();
    assert.deepEqual(JSON.parse((await page.getByTestId("window").textContent()) ?? "null"), {
      pages: [[{ title: "bob-0" }, { title: "bob-1" }]],
      nextCursor: null,
      previousCursor: null,
    });
    assert(!(await page.getByTestId("window").textContent())?.includes("alice"));
    await page.getByRole("button", { name: "Live suspense", exact: true }).click();
    await page.getByTestId("suspense-live").filter({ hasText: "bob-1" }).waitFor();
    assert.equal(calls.filter((call) => call.subject === "bob" && call.filtered).length, 1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByText("Signed out").waitFor();
    assert.equal(await page.getByTestId("window").count(), 0);
    const deadline = Date.now() + 2000;
    while (stopped < calls.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, calls.length);
    assert.equal(sockets.size, 0);
    assert.deepEqual(errors, []);
  } finally {
    delayed.resolve();
    filtered.resolve();
    await browser.close();
    await server.stop(true);
  }
}, 30000);
