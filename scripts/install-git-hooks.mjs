import { execFileSync, spawnSync } from "node:child_process";

if (!process.env.CI) {
  const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (current.error || ![0, 1].includes(current.status)) throw new Error("Cannot inspect Git hooks configuration.");
  if (current.stdout.trim() && current.stdout.trim() !== ".githooks") {
    throw new Error("Existing core.hooksPath must be reconciled before installing Kello hooks.");
  }
  execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"]);
}
