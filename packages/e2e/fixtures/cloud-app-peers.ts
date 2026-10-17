import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

/** Additional real-auth users and SDK clients of the deployed Function. */
export async function verifyCloudAppPeers(
  browser: Browser,
  first: Page,
  origin: URL,
  example: "tasks" | "jobs-storage",
) {
  const bob = await browser.newContext();
  let second: Page | undefined;
  const errors: string[] = [];
  try {
    const other = await bob.newPage();
    other.on("pageerror", (error) => errors.push(error.name));
    await other.goto(origin.href);
    await other.getByRole("button", { name: "Create an account", exact: true }).click();
    await other.getByLabel("Name", { exact: true }).fill("Other acceptance user");
    await other.getByLabel("Email", { exact: true }).fill(`kello-${crypto.randomUUID()}@example.test`);
    await other.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
    await other.getByRole("button", { name: "Create account", exact: true }).click();
    if (example === "tasks") {
      // Wait for a decoded empty live result, then prove the other user's own writes work.
      await other.getByText("Create your first project", { exact: true }).waitFor();
      await other.getByLabel("Project name", { exact: true }).fill("Other user's project");
      await other.getByRole("button", { name: "Create project", exact: true }).click();
      await other.getByRole("button", { name: "Other user's project", exact: true }).waitFor();
      assert.equal(await other.getByRole("button", { name: "Neon Auth workspace", exact: true }).count(), 0);
      assert.equal(await first.getByRole("button", { name: "Other user's project", exact: true }).count(), 0);

      second = await first.context().newPage();
      second.on("pageerror", (error) => errors.push(error.name));
      await second.goto(origin.href);
      await second.getByRole("button", { name: "Neon Auth workspace", exact: true }).click();
      await second.getByRole("checkbox", { name: "Real authenticated task", exact: true }).waitFor();
      await first.getByRole("checkbox", { name: "Real authenticated task", exact: true }).click();
      for (const page of [first, second]) {
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
          return input?.checked;
        });
      }
    } else {
      await other.getByText("No uploads yet", { exact: true }).waitFor();
      assert.equal(await other.getByRole("article").count(), 0);
      assert.equal(await first.getByRole("article").count(), 3);
    }
    await first.setViewportSize({ width: 390, height: 844 });
    assert(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
  } finally {
    try {
      await second?.close();
    } finally {
      await bob.close();
    }
  }
}
