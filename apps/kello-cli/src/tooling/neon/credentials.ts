import { readStoredKey, selectProfile } from "./store";

export type NeonCredentialCode =
  | "NEON_SESSION_REVOKED"
  | "NEON_LOGIN_REQUIRED"
  | "NEON_CREDENTIAL_UNAVAILABLE"
  | "NEON_PERMISSION_DENIED"
  | "KELLO_CREDENTIALS_UNSAFE"
  | "KELLO_CREDENTIALS_INVALID"
  | "KELLO_CREDENTIALS_BUSY";
const messages: Record<NeonCredentialCode, string> = {
  NEON_PERMISSION_DENIED:
    "The selected Neon identity does not have permission for this operation. Select an authorized profile.",
  NEON_LOGIN_REQUIRED: "Sign in with kello login, then retry the command.",
  NEON_SESSION_REVOKED:
    "The stored Kello API key was revoked or is invalid. Run kello login --force, then retry the command.",
  NEON_CREDENTIAL_UNAVAILABLE:
    "Neon credentials could not be resolved. Check connectivity and the selected profile before retrying.",
  KELLO_CREDENTIALS_UNSAFE: "The Kello credentials file is not private to the current user.",
  KELLO_CREDENTIALS_INVALID: "The Kello credentials file is invalid. Inspect it or run kello login --force.",
  KELLO_CREDENTIALS_BUSY: "Another kello login or logout is in progress. Wait for it to finish, then retry.",
};
/** Messages are fixed or path-only; provider text and key material never reach them. */
export class NeonCredentialError extends Error {
  constructor(
    readonly code: NeonCredentialCode,
    message: string = messages[code],
  ) {
    super(message);
    this.name = "NeonCredentialError";
  }
}
export interface NeonCredentialOptions {
  readonly profile?: string | undefined;
  readonly configDir?: string | undefined;
}

/**
 * Resolution order: `NEON_API_KEY` (unless `--profile` is explicit), then the key `kello login`
 * stored for the profile. Nothing else: no Neon CLI session is read, refreshed or spawned.
 * Each operation re-reads the store, so a key replaced by another `kello login --force` is adopted.
 */
export function createNeonCredentials(options: NeonCredentialOptions = {}) {
  const apiKey = options.profile ? undefined : process.env.NEON_API_KEY?.trim() || undefined;
  const configDir = options.configDir;
  let pending: Promise<string> | undefined;
  async function resolveCredential(): Promise<string> {
    if (apiKey) return apiKey;
    const stored = await readStoredKey(selectProfile(options.profile), configDir);
    if (!stored) throw new NeonCredentialError("NEON_LOGIN_REQUIRED");
    return stored.apiKey;
  }
  return {
    async resolve(): Promise<string> {
      pending ??= resolveCredential().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    /** The terminal error for a credential Neon rejected, naming where that credential came from. */
    rejected(): NeonCredentialError {
      return apiKey
        ? new NeonCredentialError(
            "NEON_SESSION_REVOKED",
            "Neon rejected NEON_API_KEY. Check that it holds an active API key, then retry the command.",
          )
        : new NeonCredentialError("NEON_SESSION_REVOKED");
    },
  };
}
