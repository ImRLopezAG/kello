import { expect, test, vi } from "vite-plus/test";

const startup = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("kello-cli", () => ({ startProjectDevelopment: startup.start }));
import { devCommand } from "../../../apps/kello-cli/src/commands/dev";

test("dev cancellation during setup aborts startup and exits cleanly", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let received: AbortSignal | undefined;
  startup.start.mockImplementationOnce(
    async (_root: string, _file: string, _provider: undefined, signal: AbortSignal) => {
      received = signal;
      process.emit("SIGINT");
      signal.throwIfAborted();
      throw new Error("startup ignored cancellation");
    },
  );
  const before = process.listenerCount("SIGINT");
  try {
    expect(await devCommand(process.cwd(), "kello.config.ts", true)).toBe(0);
    expect(received?.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(["stopped"]);
  } finally {
    log.mockRestore();
  }
});

test("dev cancellation after setup stops the watcher before reporting", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = vi.fn(async () => {});
  startup.start.mockImplementationOnce(async () => {
    setTimeout(() => process.emit("SIGTERM"), 20);
    return { watchError: null, failure: null, active: null, url: null, stop };
  });
  try {
    expect(await devCommand(process.cwd(), "kello.config.ts", true)).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(["watching", "stopped"]);
  } finally {
    log.mockRestore();
  }
});
