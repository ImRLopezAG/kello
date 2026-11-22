import type { Connection, PoolConfig } from "drizzle-orm/postgres/client/node";
import { createDatabaseSession } from "../../../apps/kello-cli/src/tooling/migrations/connection";
import type { DatabaseSession, SessionRow } from "../../../apps/kello-cli/src/tooling/migrations/connection";

export interface FakeQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly signal: AbortSignal | undefined;
}
export type FakeResult = { rows: SessionRow[]; rowCount: number | null };
export type FakeHandler = (query: FakeQuery) => FakeResult | Promise<FakeResult>;

/** A driver connection that answers through `handler` and records every statement it receives. */
export class FakeConnection {
  readonly queries: FakeQuery[] = [];
  txStatus = "I";
  ended = 0;
  cancelSettled: Promise<void> | undefined;
  endFailure: unknown;
  savepoints = 0;
  constructor(public handler: FakeHandler = () => ({ rows: [], rowCount: 0 })) {}
  get inTransaction(): boolean {
    return this.txStatus === "T" || this.txStatus === "E";
  }
  async query(sql: string, values: readonly unknown[] = [], options: { signal?: AbortSignal; mode?: string } = {}) {
    const query = { sql, values, signal: options.signal };
    this.queries.push(query);
    const result = await this.handler(query);
    // Follow the server's transaction status the way ReadyForQuery reports it to the driver.
    const command = /^\s*(\w+)(\s+to\b)?/i.exec(sql);
    const word = command?.[1]?.toLowerCase();
    if (word === "begin") this.txStatus = "T";
    else if ((word === "commit" || word === "rollback") && !command?.[2]) this.txStatus = "I";
    return options.mode === "array" ? { ...result, rows: result.rows.map((row) => Object.values(row)) } : result;
  }
  /** Mirrors the driver: BEGIN, or a savepoint when already inside a transaction; rollback failures are dropped. */
  async transaction<T>(options: { readOnly?: boolean }, operation: (tx: this) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      const savepoint = `postgres_sp_${++this.savepoints}`;
      await this.query(`savepoint ${savepoint}`);
      try {
        const result = await operation(this);
        await this.query(`release savepoint ${savepoint}`);
        return result;
      } catch (error) {
        await this.query(`rollback to savepoint ${savepoint}`).catch(() => {});
        throw error;
      }
    }
    await this.query(options.readOnly ? "begin read only" : "begin read write");
    try {
      const result = await operation(this);
      await this.query("commit");
      return result;
    } catch (error) {
      await this.query("rollback").catch(() => {});
      this.txStatus = "I";
      throw error;
    }
  }
  async end(): Promise<void> {
    this.ended++;
    if (this.endFailure !== undefined) throw this.endFailure;
  }
}

/** Driver connections are structural to the code under test; the fake implements what it calls. */
export function fakeSession(connection = new FakeConnection()): DatabaseSession {
  // SAFETY: the code under test only calls query, transaction, end, inTransaction and cancelSettled.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a test double for a driver class.
  return createDatabaseSession(connection as unknown as Connection<{ pooled: true }>);
}

/** State behind a mocked `createPool`: the configs it received and the connection it hands out. */
export interface FakePoolState {
  configs: PoolConfig[];
  connection: FakeConnection;
  connect: () => Promise<void>;
  poolEnds: number;
}

export function fakePoolState(): FakePoolState {
  return { configs: [], connection: new FakeConnection(), connect: async () => {}, poolEnds: 0 };
}

export type FakePool = ReturnType<ReturnType<typeof fakeCreatePool>>;
/** Hoisted holder for a mocked `createPool`; each test installs its own fake. */
export interface DriverMock {
  createPool?: (config: PoolConfig) => FakePool;
}

export function fakeCreatePool(state: FakePoolState) {
  return (config: PoolConfig) => {
    state.configs.push(config);
    return {
      connect: async () => {
        await state.connect();
        return { client: state.connection, release: () => {} };
      },
      end: async () => {
        state.poolEnds++;
      },
    };
  };
}
