import { expect, test, vi } from "vite-plus/test";
import { renderToString } from "react-dom/server";
import { createKelloNeonReact } from "../../../apps/kello/src/core/react/neon";

test("Neon bindings expose official SDK methods and render without opening authenticated connections", () => {
  const createClient = vi.fn(() => {
    throw new Error("Unexpected authenticated connection");
  });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const { auth, KelloProvider } = createKelloNeonReact(createClient, {
      authUrl: "https://auth.example.test/neondb/auth",
    });
    expect(auth.signIn.email).toBeInstanceOf(Function);
    expect(auth.signOut).toBeInstanceOf(Function);
    expect(
      renderToString(
        <KelloProvider url="https://functions.example.test" fallback={<p>Sign in</p>}>
          <p>Private</p>
        </KelloProvider>,
      ),
    ).toBe("");
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("Neon binding refuses credential-bearing or insecure provider URLs", () => {
  for (const authUrl of [
    "http://example.test",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
  ])
    expect(() =>
      createKelloNeonReact(
        () => {
          throw new Error("unused");
        },
        { authUrl },
      ),
    ).toThrow("HTTPS service URL");
});

test("Kello-hosted auth sends session requests to the service with credentials", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(null));
  try {
    const { auth } = createKelloNeonReact(
      () => {
        throw new Error("unused");
      },
      { serviceUrl: "https://kello.example.test" },
    );
    await auth.getSession();
    const [request, options] = fetchSpy.mock.calls[0]!;
    expect(request).toEqual(new URL("https://kello.example.test/api/auth/get-session"));
    expect(options?.credentials).toBe("include");
  } finally {
    fetchSpy.mockRestore();
  }
});
