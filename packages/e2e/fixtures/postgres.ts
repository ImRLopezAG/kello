// Test-side PostgreSQL clients on Drizzle's bundled driver. The suites were written against
// node-postgres, so these keep its small surface: `new Client(...)`, `connect()`, `query(text, values)`
// returning object rows, `end()`, and `Pool#connect()` handing out clients with `release()`.
import { createPool } from "drizzle-orm/postgres/client/node";
import * as v from "valibot";
import type { Connection, Pool as DriverPool, PoolConfig as DriverPoolConfig } from "drizzle-orm/postgres/client/node";
import { createDatabaseSession, sessionTls } from "../../../apps/kello-cli/src/tooling/migrations/connection";
import type {
  DatabaseSession,
  SessionRow,
  SessionValue,
} from "../../../apps/kello-cli/src/tooling/migrations/connection";

export interface ClientConfig {
  readonly connectionString?: string | undefined;
  readonly connectionTimeoutMillis?: number;
  readonly statement_timeout?: number;
  readonly options?: string;
  readonly application_name?: string;
}
export interface PoolConfig extends ClientConfig {
  readonly max?: number;
}
export interface QueryConfig {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly rowMode?: "array";
  /** Prepares the statement server-side under this name, as node-postgres did. */
  readonly name?: string;
}
// node-postgres types every row as `any`; the suites read columns without declaring them.
// oxlint-disable-next-line typescript/no-explicit-any
export type QueryResultRow = any;
export interface QueryResult<R = QueryResultRow> {
  rows: R[];
  rowCount: number | null;
  command: string | null;
}

function driverConfig(config: string | ClientConfig, max: number, int8: "string" | "bigint"): DriverPoolConfig {
  const settings: ClientConfig = v.is(v.string(), config) ? { connectionString: config } : config;
  const url = settings.connectionString ?? process.env.KELLO_TEST_DATABASE_URL;
  if (!url) throw new Error("Missing PostgreSQL connection string");
  const driver: DriverPoolConfig = {
    url,
    max,
    ssl: sessionTls(new URL(url)),
    connectTimeout: settings.connectionTimeoutMillis ?? 15000,
    acquireTimeoutMillis: settings.connectionTimeoutMillis ?? 15000,
    reconnect: false,
    int8,
    txGuard: false,
  };
  if (settings.statement_timeout !== undefined) driver.statementTimeout = settings.statement_timeout;
  if (settings.options !== undefined) driver.options = settings.options;
  if (settings.application_name !== undefined) driver.applicationName = settings.application_name;
  return driver;
}

/** Splits a script on top-level semicolons. The driver sends every query as one prepared statement. */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  while (index < script.length) {
    const char = script[index]!;
    const next = script[index + 1];
    if (char === "-" && next === "-") {
      const end = script.indexOf("\n", index);
      index = end === -1 ? script.length : end + 1;
    } else if (char === "/" && next === "*") {
      const end = script.indexOf("*/", index + 2);
      index = end === -1 ? script.length : end + 2;
    } else if (char === "'" || char === '"') {
      // E'...' strings take backslash escapes; standard strings only double their quotes.
      const escapes = char === "'" && /(^|[^\w])[eE]$/.test(script.slice(Math.max(0, index - 2), index));
      index++;
      while (index < script.length) {
        if (script[index] === char) {
          if (script[index + 1] === char) index += 2;
          else break;
        } else if (escapes && script[index] === "\\") index += 2;
        else index++;
      }
      index++;
    } else if (char === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(index))?.[0];
      if (tag) {
        const end = script.indexOf(tag, index + tag.length);
        index = end === -1 ? script.length : end + tag.length;
      } else index++;
    } else if (char === ";") {
      statements.push(script.slice(start, index));
      start = ++index;
    } else index++;
  }
  statements.push(script.slice(start));
  return statements.filter((statement) => statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() !== "");
}

type Cell = SessionValue;
type DriverRow = readonly Cell[] | SessionRow;

// node-postgres returned int8 as text; the suites compare those strings.
function textCell(value: Cell): Cell {
  if (v.is(v.bigint(), value)) return String(value);
  if (Array.isArray(value)) return value.map(textCell);
  return value;
}
function textInt8(row: DriverRow): DriverRow {
  if (Array.isArray(row)) return row.map(textCell);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, textCell(value)]));
}

/** Per-statement driver options: object rows, optionally under a server-side statement name. */
interface StatementOptions {
  mode: "object";
  name?: string;
}

async function run<R>(
  connection: Connection<{ pooled: true }>,
  input: string | QueryConfig,
  values?: readonly unknown[],
): Promise<QueryResult<R>> {
  const query: QueryConfig = v.is(v.string(), input) ? { text: input } : input;
  const parameters = (v.is(v.string(), input) ? values : query.values) ?? [];
  const statements = parameters.length ? [query.text] : splitStatements(query.text);
  let result: QueryResult<R> = { rows: [], rowCount: null, command: null };
  for (const statement of statements.length ? statements : [query.text]) {
    const options: StatementOptions = { mode: "object" };
    if (query.name !== undefined) options.name = query.name;
    const response =
      query.rowMode === "array"
        ? await connection.query(statement, parameters, { ...options, mode: "array" })
        : await connection.query(statement, parameters, options);
    // SAFETY: the driver decodes every column into a Cell; callers name the columns they read,
    // as they did with node-postgres' untyped rows.
    const rows = (response.rows as DriverRow[]).map(textInt8) as R[];
    result = { rows, rowCount: response.rowCount, command: response.command };
  }
  return result;
}

function transactionStatus(connection: Connection | undefined): "I" | "T" | "E" {
  const status = connection?.txStatus;
  return status === "T" || status === "E" ? status : "I";
}

/** One dedicated session. `session` hands it to Kello tooling that takes a migration session. */
export class Client {
  readonly #pool: DriverPool;
  #connection: Connection<{ pooled: true }> | undefined;
  #session: DatabaseSession | undefined;
  constructor(config: string | ClientConfig = {}) {
    // A session for tooling, as Kello's migration session is: int8 arrives as text, like node-postgres.
    this.#pool = createPool(driverConfig(config, 1, "string"));
  }
  async connect(): Promise<void> {
    this.#connection = (await this.#pool.connect()).client;
  }
  get connection(): Connection<{ pooled: true }> {
    if (!this.#connection) throw new Error("Client is not connected");
    return this.#connection;
  }
  get session(): DatabaseSession {
    return (this.#session ??= createDatabaseSession(this.connection));
  }
  query<R = QueryResultRow>(input: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult<R>> {
    return run<R>(this.connection, input, values);
  }
  getTransactionStatus(): "I" | "T" | "E" {
    return transactionStatus(this.#connection);
  }
  async end(): Promise<void> {
    try {
      await this.#connection?.end();
    } finally {
      await this.#pool.end();
    }
  }
}

/** A client checked out of a {@link Pool}. `release(true)` closes it instead of returning it. */
export class PoolClient {
  readonly #connection: Connection<{ pooled: true }>;
  readonly #release: () => void;
  #session: DatabaseSession | undefined;
  constructor(connection: Connection<{ pooled: true }>, release: () => void) {
    this.#connection = connection;
    this.#release = release;
  }
  get connection(): Connection<{ pooled: true }> {
    return this.#connection;
  }
  get session(): DatabaseSession {
    return (this.#session ??= createDatabaseSession(this.#connection));
  }
  query<R = QueryResultRow>(input: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult<R>> {
    return run<R>(this.#connection, input, values);
  }
  getTransactionStatus(): "I" | "T" | "E" {
    return transactionStatus(this.#connection);
  }
  async release(destroy?: boolean | Error): Promise<void> {
    if (destroy) await this.#connection.end().catch(() => {});
    this.#release();
  }
}

export class Pool {
  readonly driver: DriverPool;
  constructor(config: string | PoolConfig = {}) {
    // Drizzle databases built on `driver` keep the driver's default bigint decoding.
    const max = v.is(v.string(), config) ? 10 : (config.max ?? 10);
    this.driver = createPool(driverConfig(config, max, "bigint"));
  }
  async connect(): Promise<PoolClient> {
    const { client, release } = await this.driver.connect();
    return new PoolClient(client, release);
  }
  async query<R = QueryResultRow>(input: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult<R>> {
    const client = await this.connect();
    try {
      return await client.query<R>(input, values);
    } finally {
      await client.release();
    }
  }
  end(): Promise<void> {
    return this.driver.end();
  }
}

/** node-postgres' literal quoting: doubles quotes, and switches to E'' when backslashes appear. */
export function escapeLiteral(value: string): string {
  const quoted = `'${value.replaceAll("'", "''").replaceAll("\\", "\\\\")}'`;
  return value.includes("\\") ? ` E${quoted}` : quoted;
}
