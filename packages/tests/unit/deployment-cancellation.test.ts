import { expect, test, vi } from "vite-plus/test";
import pg from "pg";
import * as v from "valibot";
import { defineConfig } from "kello/tooling";
import { activateGrant, prepareGrant } from "../../../apps/kello/src/tooling/deploy/neon/activation";
import { inspectNeonFunctionHealth } from "../../../apps/kello/src/tooling/deploy/neon/health";

test("health preserves caller cancellation instead of replacing it with a health failure", async () => {
  const signal = AbortSignal.abort();
  await expect(
    inspectNeonFunctionHealth("/unused", {
      config: defineConfig({ project: "tasks" }),
      environment: "preview",
      artifactHash: "a".repeat(64),
      activationToken: "b".repeat(64),
      signal,
    }),
  ).rejects.toBe(signal.reason);
});

for (const rollbackFails of [false, true])
  test(`activation drains rollback before preserving cancellation (rollback fails: ${rollbackFails})`, async () => {
    const client = new pg.Client();
    const controller = new AbortController();
    const cancellation = new DOMException("Cancelled", "AbortError");
    const result = { rows: [], rowCount: 1, oid: 0, fields: [], command: "SELECT" };
    const queries = vi
      .spyOn(client, "query")
      .mockImplementationOnce(async () => result)
      .mockImplementationOnce(async () => ({ ...result, rows: [{ blocked: false }] }))
      .mockImplementationOnce(async () => result)
      .mockImplementationOnce(async () => {
        controller.abort(cancellation);
        return { ...result, rows: [{ state: "quarantined" }] };
      });
    if (rollbackFails) queries.mockRejectedValueOnce(new Error("rollback-private-message"));
    else queries.mockImplementationOnce(async () => result);
    try {
      const operation = prepareGrant(
        client,
        {
          metadataNamespace: "loom_meta",
          deployment: "preview",
          version: "a".repeat(64),
          projectId: "project",
          branchId: "br-preview",
          branchName: "preview",
          endpointHost: "ep-preview.example.test",
          databaseName: "neondb",
        },
        "b".repeat(64),
        controller.signal,
      );
      if (rollbackFails) await expect(operation).rejects.toThrow("Activation grant preparation failed");
      else await expect(operation).rejects.toBe(cancellation);
      expect(queries.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    } finally {
      queries.mockRestore();
    }
  });

const { withProcedureUpgrade } = await import("../../../apps/kello/src/tooling/migrations/procedure-upgrade");
const { createDevelopmentCoordinator } = await import("../../../apps/kello/src/tooling/dev/coordinator");

for (const rollback of ["success", "error", "falsey"] as const)
  for (const successor of [false, true])
    test(`outer activation rollback ${rollback}, successful successor ${successor}`, async () => {
      const client = new pg.Client();
      const binding = {
        metadataNamespace: "loom_meta",
        deployment: "preview",
        version: "a".repeat(64),
        projectId: "project",
        branchId: "br-preview",
        branchName: "preview",
        endpointHost: "ep-preview.example.test",
        databaseName: "neondb",
      };
      let enter = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const result = { rows: [], rowCount: 1, oid: 0, fields: [], command: "SELECT" };
      let rollbackCompleted = false;
      const queries = vi.spyOn(client, "query").mockImplementation(async (sql) => {
        if (v.is(v.string(), sql) && sql.includes(" AS blocked")) {
          enter();
          await pending;
          return { ...result, rows: [{ blocked: false }] };
        }
        if (sql === "ROLLBACK") {
          rollbackCompleted = true;
          if (rollback === "error") throw new Error("private-rollback-canary");
          if (rollback === "falsey") throw 0;
        }
        return result;
      });
      let successful = false;
      const coordinator = createDevelopmentCoordinator(
        async (revision) => {
          if (revision.number > 1) {
            successful = true;
            return;
          }
          await withProcedureUpgrade(
            client,
            {
              ...binding,
              protocol: "loom-legacy-1",
              procedures: [],
              migrations: [],
              signal: revision.signal,
            },
            async () => {
              await activateGrant(client, binding, "b".repeat(64), revision.signal);
            },
          );
        },
        { debounceMs: 60_000 },
      );
      try {
        coordinator.invalidate();
        const drained = coordinator.flush();
        await entered;
        if (successor) coordinator.invalidate();
        const latest = successor ? coordinator.flush() : undefined;
        const stopped = successor ? undefined : coordinator.stop();
        // Attach before releasing the pending query, including expected rejection.
        const outcome = successor
          ? undefined
          : stopped?.then(
              () => null,
              (cause: unknown) => cause,
            );
        finish();
        await drained;
        await latest;
        const failure = successor
          ? await coordinator.stop().then(
              () => null,
              (cause: unknown) => cause,
            )
          : await outcome;
        expect(rollbackCompleted).toBe(true);
        expect(successful).toBe(successor);
        if (rollback === "success") expect(failure).toBeNull();
        else
          expect(failure).toMatchObject({
            message: "Development update cleanup failed",
            cause: { message: "Procedure upgrade rollback failed" },
          });
      } finally {
        finish();
        await coordinator.stop().catch(() => {});
        queries.mockRestore();
      }
    });
