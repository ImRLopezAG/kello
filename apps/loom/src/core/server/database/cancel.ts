import pg from "pg";
import * as v from "valibot";

const int32 = v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647));
const backendSchema = v.object({
  processID: int32,
  secretKey: int32,
  connection: v.object({
    // Preserve the original object, including pg's non-enumerable TLS key.
    ssl: v.custom<NonNullable<pg.ClientConfig["ssl"]>>((value) =>
      v.is(v.union([v.boolean(), v.looseObject({})]), value),
    ),
    sslNegotiation: v.picklist(["postgres", "direct"]),
  }),
});
const transportSchema = v.object({
  connect: v.custom<(portOrPath: number | string, host?: string) => void>((value) => v.is(v.function(), value)),
  requestSsl: v.custom<() => void>((value) => v.is(v.function(), value)),
  cancel: v.custom<(processID: number, secretKey: number) => void>((value) => v.is(v.function(), value)),
});

/** Cancel while the original socket still owns its pooler's backend mapping.
 * Internal callers may shorten the default 2000ms transport budget. */
export async function cancelDatabaseStatement(client: pg.Client, maxDurationMs = 2000): Promise<void> {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0)
    throw new Error("PostgreSQL cancellation transport failed");
  const deadline = performance.now() + Math.min(maxDurationMs, 2000);
  // These BackendKeyData fields are absent from @types/pg. Validate the pinned
  // driver's boundary rather than casting an unchecked client or using SQL PIDs.
  const parsed = v.safeParse(backendSchema, client);
  if (!parsed.success) throw new Error("Unsupported PostgreSQL cancellation transport");
  const { processID, secretKey, connection: settings } = parsed.output;
  const { ssl, sslNegotiation } = settings;
  // Connection uses camel-case sslNegotiation, unlike Client's config. Preserve
  // the acquired socket's effective certificates, verification and negotiation.
  const config = { ssl, sslNegotiation };
  const connection = new pg.Connection(config);
  // pg 8.23 exports these methods; its type declarations omit them. Validate
  // the callable boundary and retain the receiver required by the driver.
  const transport = v.safeParse(transportSchema, connection);
  if (!transport.success) throw new Error("Unsupported PostgreSQL cancellation transport");
  const connect = transport.output.connect.bind(connection);
  const requestSsl = transport.output.requestSsl.bind(connection);
  const cancel = transport.output.cancel.bind(connection);
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        connection.stream.destroy();
      } catch {
        // Settlement owns destruction too. Reentrant events see settled, while
        // a throwing transport cannot strand the caller or escape its timer.
        failed = true;
      }
      if (failed || performance.now() >= deadline) reject(new Error("PostgreSQL cancellation transport failed"));
      else resolve();
    };
    const timeout = setTimeout(() => finish(true), Math.max(0, deadline - performance.now()));
    const send = () => {
      if (settled) return;
      if (performance.now() >= deadline) {
        finish(true);
        return;
      }
      try {
        cancel(processID, secretKey);
        sent = true;
      } catch {
        finish(true);
      }
    };
    connection.on("error", () => finish(true));
    connection.on("end", () => finish(!sent));
    connection.on("sslconnect", send);
    connection.on("connect", () => {
      if (settled) return;
      if (!ssl) send();
      else if (sslNegotiation === "postgres") {
        try {
          requestSsl();
        } catch {
          finish(true);
        }
      }
    });
    try {
      if (client.host.startsWith("/")) connect(`${client.host}/.s.PGSQL.${client.port}`);
      else connect(client.port, client.host);
    } catch {
      finish(true);
    }
  });
}
