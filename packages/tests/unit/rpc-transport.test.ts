import { describe, expect, it, vi } from "vite-plus/test";
import { createRpcHttpTransport } from "kello/client";
import { createNeonRpcApplication } from "kello/neon";
import { createProjectProcedures, defineSchema } from "kello/server";

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
