import type { loadProject } from "../../project/load";
import type { NeonScheduleTriggerOptions } from "./triggers";

export function releaseResources(
  project: Pick<Awaited<ReturnType<typeof loadProject>>, "crons" | "storageBuckets">,
  workerSlug: string,
) {
  const wakeName = `kello:${workerSlug}:jobs`;
  const schedules: NeonScheduleTriggerOptions["schedules"] = [
    { name: wakeName, schedule: "* * * * *", binding: { kind: "wake", name: wakeName } },
    ...Object.entries(project.crons)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, cron]) => ({
        name: `kello:${workerSlug}:cron:${name}`,
        schedule: cron.schedule,
        binding: { kind: "cron" as const, name: `kello:${workerSlug}:cron:${name}`, cron: name },
      })),
  ];
  const buckets = [...project.storageBuckets];
  const storage = buckets.map((bucket) => ({ name: `kello:${workerSlug}:storage:${bucket}`, bucket }));
  const names = [...schedules.map((entry) => entry.name), ...storage.map((entry) => entry.name)];
  if (new Set(names).size !== names.length) throw new Error("Release trigger names conflict");
  return { schedules, buckets, storage };
}
