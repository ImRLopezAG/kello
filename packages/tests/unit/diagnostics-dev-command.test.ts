import { expect, test, vi } from "vite-plus/test";
import { channel } from "node:diagnostics_channel";

const startup = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("kello/tooling", () => ({ startProjectDevelopment: startup.start }));
import { devCommand } from "../../../apps/kello/src/commands/dev";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const doubleFailure of [false, true]) {
    test(`dev command starts no diagnostics and releases ${signal} handlers when stop rejects (${doubleFailure ? "work error wins" : "cleanup error surfaces"})`, async () => {
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const workError = new Error("work-failure-canary");
      const stopError = new Error("stop-failure-canary");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let stops = 0;
      startup.start.mockImplementationOnce(async () => {
        if (!doubleFailure) process.emit(signal);
        return {
          watchError: null,
          get failure() {
            if (doubleFailure) throw workError;
            return null;
          },
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
        await expect(devCommand(process.cwd(), "kello.config.ts", true)).rejects.toBe(
          doubleFailure ? workError : stopError,
        );
        expect(stops).toBe(1);
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
        expect(channel("kello.runtime.metric").hasSubscribers).toBe(false);
        expect(channel("kello.deployment.metric").hasSubscribers).toBe(false);
        expect(log.mock.calls.some(([line]) => String(line).includes('"event":"stopped"'))).toBe(false);
      } finally {
        log.mockRestore();
        startup.start.mockReset();
      }
    });
  }
}
