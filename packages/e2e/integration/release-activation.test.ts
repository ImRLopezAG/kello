import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.skipIf(!process.env.KELLO_TEST_DATABASE_URL)(
  "release health and activation recover with packed runtimes over HTTPS",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kello-release-activation-"));
    try {
      const config = join(root, "openssl.cnf");
      const certificate = join(root, "certificate.pem");
      const key = join(root, "key.pem");
      await writeFile(
        config,
        `[req]\ndistinguished_name = dn\nx509_extensions = extensions\nprompt = no\n[dn]\nCN = Kello temporary test CA\n[extensions]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectAltName = IP:127.0.0.1\n`,
      );
      const openssl = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-config",
          config,
          "-keyout",
          key,
          "-out",
          certificate,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const diagnostic = await new Response(openssl.stderr).text();
      assert.equal(await openssl.exited, 0, diagnostic);
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../fixtures/release-activation.ts", import.meta.url)),
          root,
          certificate,
          key,
        ],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 20000);
      try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        assert.equal(code, 0, stderr);
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
