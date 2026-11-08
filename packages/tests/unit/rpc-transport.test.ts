import { createServer } from "node:http";
import type { Server } from "node:http";
import * as v from "valibot";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRpcHttpTransport } from "kello/client";
import { createNeonRpcApplication } from "kello/neon";
import { createProjectProcedures, defineSchema } from "kello/server";

const tcpAddress = v.object({ port: v.number() });
const listeningPort = (server: Server) => v.parse(tcpAddress, server.address()).port;

describe("native browser transport lifetime", () => {
  it("rejects credential-bearing URLs and stale version formats before connecting", () => {
    const getToken = async () => "token";
    for (const url of ["https://user:password@example.test", "https://example.test/?token=x", "ftp://example.test"]) {
      expect(() => createRpcHttpTransport({ url, version: "a".repeat(64), getToken })).toThrow(
        "Invalid RPC service URL",
      );
    }
    expect(() => createRpcHttpTransport({ url: "https://example.test", version: "old", getToken })).toThrow(
      "Invalid RPC version",
    );
  });

  it("surfaces a version refusal without retrying credentials or the procedure", async () => {
    const verify = vi.fn(async () => {
      throw new Error("Must refuse before authentication");
    });
    const handler = vi.fn(() => null);
    const { procedure } = createProjectProcedures(defineSchema(() => ({})));
    const app = await createNeonRpcApplication({
      version: "b".repeat(64),
      origins: [],
      verify,
      router: { write: procedure.handler(handler) },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((address, init) =>
        app.fetch(address instanceof Request ? new Request(address, init) : new Request(String(address), init)),
      );
    const transport = createRpcHttpTransport({
      url: "https://example.test",
      version: "a".repeat(64),
      getToken: async () => "token",
    });
    try {
      await expect(transport.link.call(["write"], {}, { context: {} })).rejects.toMatchObject({
        code: "RPC_VERSION_MISMATCH",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(verify).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
      fetchSpy.mockRestore();
      await app.stop();
    }
  });

  it("aborts a pending credential lookup and refuses calls after disposal", async () => {
    let resolveToken: (token: string) => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = createRpcHttpTransport({
      url: "https://example.test",
      version: "a".repeat(64),
      getToken: () => {
        started();
        return new Promise<string>((resolve) => {
          resolveToken = resolve;
        });
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const pending = transport.link.call(["write"], {}, { context: {} });
      const rejected = expect(pending).rejects.toThrow();
      await ready;
      transport.dispose();
      resolveToken("secret");
      await rejected;
      await expect(transport.link.call(["write"], {}, { context: {} })).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      transport.dispose();
      fetchSpy.mockRestore();
    }
  });
});

it("never exposes a late HTTP mutation response after logout or replays the mutation", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    started.resolve();
    return response.promise;
  });
  const transport = createRpcHttpTransport({
    url: "https://example.test",
    version: "a".repeat(64),
    getToken: async () => "token",
  });
  try {
    const pending = transport.link.call(["write"], {}, { context: {} });
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    transport.dispose();
    response.resolve(Response.json({ json: { committed: true } }));
    await rejected;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    transport.dispose();
    fetchSpy.mockRestore();
  }
});

describe("native transport fetch options", () => {
  async function capture(options: { credentials?: "include" | "same-origin" } = {}) {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ json: { committed: true } }));
    const transport = createRpcHttpTransport({
      url: "https://example.test",
      version: "a".repeat(64),
      getToken: async () => "token",
      ...options,
    });
    try {
      await transport.link.call(["write"], {}, { context: {} });
      const [address, init] = fetchSpy.mock.calls[0] ?? [];
      return { address, init };
    } finally {
      transport.dispose();
      fetchSpy.mockRestore();
    }
  }

  it("omits credentials and bypasses the HTTP cache by default", async () => {
    const { init } = await capture();
    expect(init?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-store");
  });

  it("sends the configured credentials mode and still bypasses the HTTP cache", async () => {
    const { init } = await capture({ credentials: "include" });
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
  });

  it("refuses redirects instead of following them", async () => {
    const { init } = await capture();
    expect(init?.redirect).toBe("error");
  });

  // A followed 307/308 would hand the mutation body and idempotency key to another origin;
  // a followed 301/302/303 would turn the POST into a GET and accept the target's answer.
  it.each([307, 303])("fails a %i redirect without contacting the target", async (status) => {
    const target = { hits: 0 };
    const redirected = createServer((_request, response) => {
      target.hits += 1;
      response.writeHead(200, { "content-type": "application/json" }).end('{"json":{"committed":true}}');
    });
    const origin = createServer((_request, response) => {
      response
        .writeHead(status, { location: `http://127.0.0.1:${listeningPort(redirected)}/api/kello/rpc/write` })
        .end();
    });
    await Promise.all([
      new Promise<void>((resolve) => redirected.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve)),
    ]);
    const transport = createRpcHttpTransport({
      url: `http://127.0.0.1:${listeningPort(origin)}`,
      version: "a".repeat(64),
      getToken: async () => "token",
    });
    try {
      await expect(transport.link.call(["write"], { secret: "input" }, { context: {} })).rejects.toThrow();
      expect(target.hits).toBe(0);
    } finally {
      transport.dispose();
      await Promise.all([
        new Promise((resolve) => redirected.close(resolve)),
        new Promise((resolve) => origin.close(resolve)),
      ]);
    }
  });
});
