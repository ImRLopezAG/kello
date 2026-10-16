import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bundle the actual tarball exports, with only the browser dependencies available to the consumer. */
export async function browserBundle(
  fixture: "rpc-client.tsx" | "rpc-transport.tsx" | "search-client.tsx" | "search-finite.tsx" = "rpc-transport.tsx",
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "loom-react-consumer-"));
  try {
    const archive = join(directory, "kello.tgz");
    const packed = Bun.spawn([process.execPath, "pm", "pack", "--filename", archive, "--quiet", "--ignore-scripts"], {
      cwd: new URL("../../../apps/kello", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await packed.exited) !== 0) throw new Error("Kello packing failed");
    const target = join(directory, "node_modules", "kello");
    await mkdir(target, { recursive: true });
    const extracted = Bun.spawn(["tar", "-xzf", archive, "-C", target, "--strip-components", "1"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await extracted.exited) !== 0) throw new Error("Kello extraction failed");
    for (const dependency of [
      "react",
      "react-dom",
      "valibot",
      "@tanstack/react-query",
      "@tanstack/query-core",
      "@orpc/client",
      "@orpc/tanstack-query",
    ]) {
      await mkdir(join(directory, "node_modules", dependency, ".."), { recursive: true });
      await symlink(
        await realpath(
          new URL(
            dependency === "@tanstack/query-core"
              ? `../../../apps/kello/node_modules/${dependency}`
              : `../node_modules/${dependency}`,
            import.meta.url,
          ),
        ),
        join(directory, "node_modules", dependency),
      );
    }
    const entry = join(directory, "client.tsx");
    await cp(new URL(`./fixture/${fixture}`, import.meta.url), entry);
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    if (!result.success) throw new Error(`Browser build failed: ${result.logs.map((log) => log.message).join("; ")}`);
    const bundle = await result.outputs[0]?.text();
    if (!bundle) throw new Error("Missing browser bundle");
    return bundle;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
