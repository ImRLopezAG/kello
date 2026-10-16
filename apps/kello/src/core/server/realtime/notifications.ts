import { createHash } from "node:crypto";
import pg from "pg";
import * as v from "valibot";
import { publishRuntimeMetric } from "../observability";

export interface RevisionWakeups {
  /** Settles after LISTEN commits or the first failed attempt enters degraded mode. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}
export interface RevisionNotificationOptions {
  readonly connectionString: string;
  readonly runtimeRole: string;
  readonly metadataNamespace: string;
  readonly namespace: string;
  readonly componentNamespaces?: readonly string[];
}
const identifier = v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_]{0,62}$/));

/** A routing hint, never an authorization credential or source of row data. */
export function revisionNotificationChannel(metadataNamespace: string, namespace: string): string {
  v.parse(identifier, metadataNamespace);
  v.parse(identifier, namespace);
  return `loom_revision_${createHash("md5").update(`${metadataNamespace}.${namespace}`).digest("hex")}`;
}

/** One direct restricted-role connection per active coordinator. Polling remains
 * authoritative while this listener reconnects with bounded exponential backoff. */
export function listenForRevisions(options: RevisionNotificationOptions, wake: () => void): RevisionWakeups {
  const address = URL.parse(options.connectionString);
  const role = v.parse(identifier, options.runtimeRole);
  if (!address || !["postgres:", "postgresql:"].includes(address.protocol) || address.hostname.includes("-pooler"))
    throw new Error("Notifications require a direct runtime PostgreSQL URL");
  if (decodeURIComponent(address.username) !== role) throw new Error("Listener URL must use the runtime role");
  const channels = new Set(
    [options.namespace, ...(options.componentNamespaces ?? [])].map((namespace) =>
      revisionNotificationChannel(options.metadataNamespace, namespace),
    ),
  );
  let stopped = false;
  let client: pg.Client | undefined;
  let connecting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const closing = new Set<Promise<void>>();
  const retired = new WeakSet<pg.Client>();
  function close(connection: pg.Client) {
    if (retired.has(connection)) return;
    retired.add(connection);
    const work = connection
      .end()
      .catch(() => {})
      .finally(() => closing.delete(work));
    closing.add(work);
  }
  function reconnect() {
    if (stopped || retry) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        void start().catch(reconnect);
      },
      Math.min(30_000, 250 * 2 ** Math.min(failures++, 7)),
    );
    retry.unref?.();
  }
  function lost(connection: pg.Client) {
    if (connection !== client) return;
    client = undefined;
    close(connection);
    if (stopped) return;
    publishRuntimeMetric({ type: "realtime.listener", status: "degraded" });
    wake();
    reconnect();
  }
  function start(): Promise<void> {
    if (stopped || connecting || client) return connecting ?? Promise.resolve();
    connecting = Promise.resolve()
      .then(async () => {
        const connection = new pg.Client({
          connectionString: options.connectionString,
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        client = connection;
        connection.on("error", () => lost(connection));
        connection.on("end", () => lost(connection));
        connection.on("notification", (message) => {
          if (!stopped && connection === client && channels.has(message.channel)) wake();
        });
        try {
          await connection.connect();
          const authority = await connection.query<{ safe: boolean }>(
            `SELECT current_user = $1 AND session_user = $1
          AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2 AND nspowner = r.oid) AS safe
          FROM pg_roles r WHERE rolname = current_user`,
            [role, options.metadataNamespace],
          );
          if (authority.rows[0]?.safe !== true) throw new Error("Listener requires restricted runtime credentials");
          for (const channel of channels) await connection.query(`LISTEN "${channel}"`);
          if (stopped || connection !== client) {
            close(connection);
            return;
          }
          failures = 0;
          publishRuntimeMetric({ type: "realtime.listener", status: "connected" });
          wake();
        } catch {
          lost(connection);
        }
      })
      .finally(() => {
        connecting = undefined;
        if (!client) reconnect();
      });
    return connecting;
  }
  const ready = start();
  return {
    ready,
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      if (retry) clearTimeout(retry);
      if (client) {
        const previous = client;
        client = undefined;
        close(previous);
      }
      stopping = Promise.resolve().then(async () => {
        await connecting;
        await Promise.allSettled(closing);
        publishRuntimeMetric({ type: "realtime.listener", status: "idle" });
      });
      return stopping;
    },
  };
}
