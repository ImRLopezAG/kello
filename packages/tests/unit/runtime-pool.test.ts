import { afterEach, expect, test, vi } from "vite-plus/test";
import type { PoolConfig } from "drizzle-orm/postgres/client/node";
import type { NeonPoolConfig } from "drizzle-orm/postgres/client/neon-ws";
import { createRuntimePool } from "../../../apps/kello/src/core/server/database/pool";

const created = vi.hoisted(() => {
  const tcp: PoolConfig[] = [];
  const neon: NeonPoolConfig[] = [];
  return { tcp, neon };
});

vi.mock("drizzle-orm/postgres/client/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm/postgres/client/node")>()),
  createPool: (config: PoolConfig) => {
    created.tcp.push(config);
    return { acquire: async () => ({}) };
  },
}));

vi.mock("drizzle-orm/postgres/client/neon-ws", () => ({
  createPool: (config: NeonPoolConfig) => {
    created.neon.push(config);
    return { acquire: async () => ({}) };
  },
}));

afterEach(() => {
  created.tcp.length = 0;
  created.neon.length = 0;
});

function tcpConfig(url: string): PoolConfig {
  createRuntimePool({ address: new URL(url), max: 2 });
  expect(created.neon).toHaveLength(0);
  expect(created.tcp).toHaveLength(1);
  const [config] = created.tcp;
  if (!config) throw new Error("No TCP pool was created");
  return config;
}

test("plain PostgreSQL hosts keep node-postgres' sslmode reading over TCP", () => {
  const cases: ReadonlyArray<readonly [string, PoolConfig["ssl"]]> = [
    ["postgresql://app:secret@db.internal:5432/app", false],
    ["postgresql://app:secret@db.internal:5432/app?sslmode=disable", false],
    ["postgresql://app:secret@db.internal:5432/app?sslmode=no-verify", "require"],
    ["postgresql://app:secret@db.internal:5432/app?sslmode=require", "verify-full"],
    ["postgresql://app:secret@db.internal:5432/app?sslmode=verify-full", "verify-full"],
  ];
  for (const [url, ssl] of cases) {
    expect(tcpConfig(url).ssl).toBe(ssl);
    created.tcp.length = 0;
  }
});

test("Neon hosts use the secure WebSocket transport whatever the URL sslmode says", () => {
  createRuntimePool({
    address: new URL("postgresql://app:secret@ep-quiet-1.us-east-2.aws.neon.tech/app?sslmode=require"),
    max: 2,
  });
  expect(created.tcp).toHaveLength(0);
  expect(created.neon).toHaveLength(1);
  expect(created.neon[0]).toMatchObject({ secure: true });
  expect(created.neon[0]).not.toHaveProperty("wsProxy");
});
