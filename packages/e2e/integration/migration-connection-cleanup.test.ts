import { expect, spyOn, test } from "bun:test";
import pg from "pg";
import { withMigrationConnection } from "../../../apps/kello-cli/src/tooling/migrations/connection";

test("listener setup failure still ends the constructed migration client exactly once", async () => {
  for (const primary of [undefined, null, false, new Error("listener setup failed")]) {
    const listener = spyOn(pg.Client.prototype, "on").mockImplementation(() => {
      throw primary;
    });
    const connect = spyOn(pg.Client.prototype, "connect");
    const end = spyOn(pg.Client.prototype, "end").mockImplementation(() => Promise.resolve());
    let rejected = false;
    let delivered: unknown;
    let operationCalls = 0;
    try {
      try {
        await withMigrationConnection("postgresql://localhost/unused", async () => {
          operationCalls++;
        });
      } catch (error) {
        rejected = true;
        delivered = error;
      }
      expect(rejected).toBe(true);
      expect(delivered).toBe(primary);
      expect(connect).not.toHaveBeenCalled();
      expect(operationCalls).toBe(0);
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      listener.mockRestore();
      connect.mockRestore();
      end.mockRestore();
    }
  }
});

test("listener setup cleanup preserves the original failure when end also fails", async () => {
  const primary = new Error("listener setup failed");
  const secondary = new Error("end failed");
  const listener = spyOn(pg.Client.prototype, "on").mockImplementation(() => {
    throw primary;
  });
  const connect = spyOn(pg.Client.prototype, "connect");
  const end = spyOn(pg.Client.prototype, "end").mockImplementation(() => Promise.reject(secondary));
  try {
    await expect(withMigrationConnection("postgresql://localhost/unused", async () => {})).rejects.toBe(primary);
    expect(connect).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  } finally {
    listener.mockRestore();
    connect.mockRestore();
    end.mockRestore();
  }
});
