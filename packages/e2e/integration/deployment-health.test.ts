import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("deployment health verifies both HTTPS endpoints and refuses stale provider or build identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kello-health-"));
  try {
    const config = join(directory, "openssl.cnf");
    const certificate = join(directory, "certificate.pem");
    const key = join(directory, "key.pem");
    await writeFile(
      config,
      `[req]
distinguished_name = dn
x509_extensions = extensions
prompt = no
[dn]
CN = Kello temporary test CA
[extensions]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
subjectAltName = IP:127.0.0.1
`,
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
    for (const trusted of [false, true]) {
      const child = Bun.spawn(
        [
          "node",
          fileURLToPath(new URL("../fixtures/deployment-health.ts", import.meta.url)),
          certificate,
          key,
          trusted ? "trusted" : "untrusted",
          directory,
        ],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? certificate : "", NODE_TLS_REJECT_UNAUTHORIZED: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 15000);
      try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        assert.equal(code, 0, stderr);
      } finally {
        clearTimeout(timeout);
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
