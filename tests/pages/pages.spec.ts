import { expect, test, type Page } from "@playwright/test";

import { makeImpulseResponseWav, makeSourceAWav } from "../e2e/fixtures";

interface BrowserFailures {
  pageErrors: string[];
  consoleErrors: string[];
}

const expectedFooterUrls = [
  "https://github.com/agunal/convolve-wasm",
  "https://github.com/agunal/convolve-wasm/blob/main/packages/convolve-wasm/README.md",
  "https://github.com/agunal/convolve-wasm/blob/main/docs/browser-support.md",
  "https://github.com/agunal/convolve-wasm/issues",
];

function watchFailures(page: Page): BrowserFailures {
  const failures: BrowserFailures = { pageErrors: [], consoleErrors: [] };
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  return failures;
}

test(
  "loads the complete application site from the repository subpath",
  async ({ page }, testInfo) => {
    const failures = watchFailures(page);
    const runtimePaths: string[] = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.includes("convolve.worker") || pathname.endsWith(".wasm")) {
        runtimePaths.push(pathname);
      }
    });

    try {
      await page.goto("./");

      const logo = page.locator(".brand-mark");
      await expect(logo).toBeVisible();
      await expect
        .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
      await expect(page.locator("#audio-a")).toBeVisible();
      await expect(page.locator("#audio-b")).toBeVisible();
      await expect(page.locator("#run")).toBeVisible();
      await expect(page.locator("#about")).toBeVisible();
      await expect(page.locator("#about .resource-links")).toHaveCount(0);

      const footer = page.locator(".site-footer");
      await expect(footer).toContainText("never uploaded");
      await expect(footer).toContainText(
        "No uploads · No analytics · No server processing",
      );
      await expect(footer).toContainText("MIT licensed · Rust + WebAssembly");

      const footerLinks = page.locator(".site-footer .footer-links a");
      await expect(footerLinks).toHaveCount(expectedFooterUrls.length);
      await expect
        .poll(() => footerLinks.evaluateAll((links) => links.map((link) => link.href)))
        .toEqual(expectedFooterUrls);
      for (let index = 0; index < expectedFooterUrls.length; index += 1) {
        await expect(footerLinks.nth(index)).toHaveAttribute("target", "_blank");
        await expect(footerLinks.nth(index)).toHaveAttribute("rel", "noreferrer");
      }

      const ownerName = page.locator(".owner-name");
      await expect(ownerName).toHaveText("@takana.gg");
      expect(await ownerName.evaluate((element) => element.tagName)).toBe("SPAN");

      const bluesky = page.getByRole("link", {
        name: "@takana.gg on Bluesky",
      });
      await expect(bluesky).toHaveAttribute(
        "href",
        "https://bsky.app/profile/takana.gg",
      );
      await expect(bluesky).toHaveAttribute("target", "_blank");
      await expect(bluesky).toHaveAttribute("rel", "noreferrer");

      await page.locator("#audio-a").setInputFiles({
        name: "a.wav",
        mimeType: "audio/wav",
        buffer: makeSourceAWav(),
      });
      await page.locator("#audio-b").setInputFiles({
        name: "b.wav",
        mimeType: "audio/wav",
        buffer: makeImpulseResponseWav(),
      });
      await page.locator("#run").click();
      await expect(page.locator("#status")).toHaveAttribute("data-state", "done", {
        timeout: 90_000,
      });
      await expect(page.locator("#preview")).toHaveAttribute("src", /^blob:/);
      await expect(page.locator("#download")).toHaveAttribute("href", /^blob:/);

      expect(runtimePaths.some((path) => path.includes("convolve.worker"))).toBe(
        true,
      );
      expect(runtimePaths.some((path) => path.endsWith(".wasm"))).toBe(true);
      for (const path of runtimePaths) {
        expect(path.startsWith("/convolve-wasm/")).toBe(true);
      }
      expect(failures.pageErrors).toEqual([]);
      expect(failures.consoleErrors).toEqual([]);
    } finally {
      const statusText = await page
        .locator("#status")
        .textContent()
        .catch(() => null);
      await testInfo.attach("pages-runtime-diagnostics", {
        body: Buffer.from(
          JSON.stringify(
            {
              url: page.url(),
              statusText,
              runtimePaths,
              failures,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    }
  },
);
