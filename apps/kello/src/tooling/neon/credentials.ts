import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as v from "valibot";

const failureCode = v.picklist([
  "NEON_SESSION_REVOKED",
  "NEON_REFRESH_FAILED",
  "NEON_LOGIN_REQUIRED",
  "NEON_CREDENTIAL_UNAVAILABLE",
  "NEON_PERMISSION_DENIED",
]);
export class NeonCredentialError extends Error {
  constructor(readonly code: v.InferOutput<typeof failureCode>) {
    super(
      code === "NEON_PERMISSION_DENIED"
        ? "The selected Neon identity does not have permission for this operation. Select an authorized profile."
        : code === "NEON_LOGIN_REQUIRED" || code === "NEON_SESSION_REVOKED"
          ? "Sign in with kello login, then retry the command."
          : "Neon credentials could not be resolved. Check connectivity and the selected profile or keyring before retrying.",
    );
    this.name = "NeonCredentialError";
  }
}
export interface NeonCredentialOptions {
  readonly profile?: string | undefined;
  readonly configDir?: string | undefined;
}

/** One invocation retains its identity; each operation resolves current credentials. */
export function createNeonCredentials(options: NeonCredentialOptions = {}) {
  const apiKey = options.profile ? undefined : process.env.NEON_API_KEY?.trim();
  const profile = options.profile ?? (apiKey ? undefined : process.env.NEON_PROFILE?.trim());
  const configDir = options.configDir;
  const environment = { ...process.env };
  let pending: Promise<string> | undefined;
  async function resolveCredential(): Promise<string> {
    if (apiKey) return apiKey;
    const entry = join(dirname(fileURLToPath(import.meta.resolve("kello/tooling"))), "neon/credential-worker.js");
    const child = Bun.spawn([process.execPath, entry], {
      env: {
        ...environment,
        CI: "true",
        DEBUG: "",
        LOOM_NEON_CREDENTIAL_REQUEST: JSON.stringify({ profile, configDir }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 30_000,
    });
    const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (status !== 0) throw new NeonCredentialError("NEON_CREDENTIAL_UNAVAILABLE");
    let decoded: unknown;
    try {
      decoded = JSON.parse(output);
    } catch {
      throw new NeonCredentialError("NEON_CREDENTIAL_UNAVAILABLE");
    }
    const parsed = v.safeParse(
      v.union([v.strictObject({ token: v.pipe(v.string(), v.minLength(1)) }), v.strictObject({ code: failureCode })]),
      decoded,
    );
    if (!parsed.success) throw new NeonCredentialError("NEON_CREDENTIAL_UNAVAILABLE");
    if ("code" in parsed.output) throw new NeonCredentialError(parsed.output.code);
    return parsed.output.token;
  }
  return {
    async resolve(): Promise<string> {
      pending ??= resolveCredential().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
