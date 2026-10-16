import pg from "pg";
import { publishRuntimeMetric } from "../observability";

type ConnectCallback = Parameters<pg.Pool["connect"]>[0];

/** Preserve both pg acquisition APIs, including the callback path used by pool.query. */
export class RuntimePool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const started = performance.now();
    const report = (status: "success" | "error") => {
      publishRuntimeMetric({
        type: "database.acquire",
        status,
        durationMs: performance.now() - started,
        total: this.totalCount,
        idle: this.idleCount,
        waiting: this.waitingCount,
      });
    };
    if (callback) {
      return super.connect((error, client, release) => {
        report(error ? "error" : "success");
        callback(error, client, release);
      });
    }
    return super.connect().then(
      (client) => {
        report("success");
        return client;
      },
      (error: Error) => {
        report("error");
        throw error;
      },
    );
  }
}
