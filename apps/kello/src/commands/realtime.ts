import {
  enableRealtime,
  loadProjectConfig,
  readRealtimeStatus,
  type DiscoveryProvider,
  type RealtimeProvider,
  type RealtimeStatus,
} from "kello/tooling";

function describe(status: RealtimeStatus): string {
  const target = `${status.branchName} (${status.branchId}) database ${status.databaseName}`;
  if (status.state === "ready") return `Realtime is ready on ${target} at ${status.realtimeUrl}.`;
  if (status.state === "pending")
    return `Realtime is still being applied on ${target}. Run kello realtime status later.`;
  return `Realtime is disabled on ${target}. Run kello realtime enable --origin <origin> to enable it.`;
}

export async function realtimeStatusCommand(
  root: string,
  structured: boolean,
  providers: { discovery?: DiscoveryProvider; realtime?: RealtimeProvider } = {},
): Promise<number> {
  const status = await readRealtimeStatus(
    root,
    (await loadProjectConfig(root, { readOnly: true })).config,
    {},
    providers.discovery,
    providers.realtime,
  );
  console.log(structured ? JSON.stringify({ ok: true, command: "realtime status", status }) : describe(status));
  return 0;
}

/** Success is reported only once Realtime is ready; an expired wait exits with the pending state. */
export async function realtimeEnableCommand(
  root: string,
  structured: boolean,
  options: { allowedOrigins: readonly string[]; allowProtected: boolean },
): Promise<number> {
  const status = await enableRealtime(root, (await loadProjectConfig(root)).config, {
    ...options,
    timeoutMs: 300_000,
  });
  const ok = status.state === "ready";
  const output = structured ? JSON.stringify({ ok, command: "realtime enable", status }) : describe(status);
  if (ok) console.log(output);
  else console.error(output);
  return ok ? 0 : 7;
}
