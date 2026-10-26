import { channel } from "node:diagnostics_channel";
import type { NeonReleaseStage } from "./neon/release-receipt";

/** Receipt acknowledgements are not proof of current provider health. */
export interface DeploymentMetric {
  readonly type: "release.acknowledgement";
  readonly stage: NeonReleaseStage["stage"];
  readonly status: "recorded" | "replayed" | "write-error";
}

const metrics = channel("kello.deployment.metric");

export function publishDeploymentMetric(metric: DeploymentMetric): void {
  metrics.publish(metric);
}
