import assert from "node:assert/strict";
import type { Browser } from "playwright";

export async function verifyCloudComponentBrowser(browser: Browser, origin: URL, diagnostics: string[]) {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  try {
    const first = await alice.newPage();
    const second = await alice.newPage();
    const other = await bob.newPage();
    const errors: string[] = [];
    for (const page of [first, second, other]) {
      page.on("pageerror", (error) => errors.push(error.name));
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        const category = path.startsWith("/api/auth/") ? "auth" : path.startsWith("/api/kello/") ? "rpc" : undefined;
        if (category && response.status() >= 400) diagnostics.push(`${category}: ${response.status()}`);
      });
    }
    for (const page of [first, other]) {
      await page.goto(origin.href);
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).fill("Component acceptance");
      await page.getByLabel("Email", { exact: true }).fill(`kello-${crypto.randomUUID()}@example.test`);
      await page.getByLabel("Password", { exact: true }).fill(crypto.randomUUID());
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await page.getByText("Live updates active.", { exact: true }).waitFor();
    }
    // Prove the other account has a working live subscription before testing isolation.
    const otherEntry = `Other account ${crypto.randomUUID()}`;
    await other.getByLabel("New entry", { exact: true }).fill(otherEntry);
    await other.getByRole("button", { name: "Save entry", exact: true }).click();
    await other.getByText(otherEntry, { exact: true }).waitFor();
    await second.goto(origin.href);
    await second.getByText("Live updates active.", { exact: true }).waitFor();
    const entry = `Private entry ${crypto.randomUUID()}`;
    await first.getByLabel("New entry", { exact: true }).fill(entry);
    await first.getByRole("button", { name: "Save entry", exact: true }).click();
    await second.getByText(entry, { exact: true }).waitFor();
    assert.equal(await other.getByText(entry, { exact: true }).count(), 0);
    assert.equal(await first.getByText(otherEntry, { exact: true }).count(), 0);
    await second.getByRole("button", { name: "Pause live updates", exact: true }).click();
    await second.getByText("Live updates paused.", { exact: true }).waitFor();
    await second.getByText(entry, { exact: true }).waitFor();
    const later = `Arrived while paused ${crypto.randomUUID()}`;
    await first.getByLabel("New entry", { exact: true }).fill(later);
    await first.getByRole("button", { name: "Save entry", exact: true }).click();
    await first.getByText(later, { exact: true }).waitFor();
    assert.equal(await second.getByText(later, { exact: true }).count(), 0);
    await second.getByRole("button", { name: "Resume live updates", exact: true }).click();
    await second.getByText(later, { exact: true }).waitFor();
    // Bypass the HTML limit: the deployed contract must reject this request.
    await first.getByLabel("New entry", { exact: true }).evaluate((element) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("Expected entry textarea");
      element.value = "x".repeat(201);
    });
    await first.getByRole("button", { name: "Save entry", exact: true }).click();
    await first.getByRole("alert").waitFor();
    assert.equal(await first.getByLabel("New entry", { exact: true }).inputValue(), "x".repeat(201));
    await first.setViewportSize({ width: 390, height: 844 });
    assert(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
  } finally {
    try {
      await alice.close();
    } finally {
      await bob.close();
    }
  }
}
