import { expect, test, vi } from "vite-plus/test";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { startDiagnostics } from "../../../apps/loom/src/tooling/diagnostics/session";
import { createFileOutput } from "../../../apps/loom/src/tooling/diagnostics/output";

const startup = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("kello/tooling", async () => ({
  startDiagnostics: (await import("../../../apps/loom/src/tooling/diagnostics/session")).startDiagnostics,
  startProjectDevelopment: startup.start,
}));
vi.mock("../../../apps/loom/src/tooling/dev/project", () => ({
  startProjectDevelopmentWithOwnedOutput: startup.start,
}));
import { devCommandWithOwnedOutput } from "../../../apps/loom/src/commands/dev";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const doubleFailure of [false, true]) {
    test(`dev command releases diagnostics and ${signal} handlers when stop rejects (${doubleFailure ? "work error wins" : "cleanup error surfaces"})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "kello-dev-stop-"));
      const path = join(root, "events.jsonl");
      const handle = await open(path, "wx", 0o600);
      const output = createFileOutput(handle);
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const workError = new Error("work-failure-canary");
      const stopError = new Error("stop-failure-canary");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let stops = 0;
      startup.start.mockImplementationOnce(async () => {
        channel("kello.runtime.metric").publish({
          type: "rpc.procedure",
          mode: "finite",
          status: "success",
          durationMs: 1,
        });
        const deadline = Date.now() + 1000;
        while (!(await readFile(path, "utf8")).includes("rpc.procedure")) {
          expect(Date.now()).toBeLessThan(deadline);
          await setTimeout(10);
        }
        if (!doubleFailure) process.emit(signal);
        return {
          watchError: null,
          get workerFailure() {
            if (doubleFailure) throw workError;
            return null;
          },
          cronFailure: null,
          failure: null,
          active: null,
          url: null,
          async stop() {
            stops++;
            process.emit(signal);
            throw stopError;
          },
        };
      });
      try {
        await expect(
          devCommandWithOwnedOutput(
            root,
            "session.json",
            true,
            {
              output: { format: "jsonl", write: output.write },
            },
            path,
          ),
        ).rejects.toBe(doubleFailure ? workError : stopError);
        expect(stops).toBe(1);
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
        expect(channel("kello.runtime.metric").hasSubscribers).toBe(false);
        expect(channel("kello.deployment.metric").hasSubscribers).toBe(false);
        expect(await readFile(path, "utf8")).toContain("rpc.procedure");
        await expect(handle.write("after-close")).rejects.toThrow();
        const replacement = await startDiagnostics({ output: { format: "text", write() {} } });
        await replacement.stop();
        expect(log.mock.calls.some(([line]) => String(line).includes('"event":"stopped"'))).toBe(false);
      } finally {
        log.mockRestore();
        startup.start.mockReset();
        await output.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
