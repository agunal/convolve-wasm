import { expect, test, type Page } from "@playwright/test";

const longFilename = `${"long-source-name-".repeat(8)}.wav`;

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function selectLongNames(page: Page): Promise<void> {
  const file = {
    name: longFilename,
    mimeType: "audio/wav",
    buffer: Buffer.alloc(44),
  };
  await page.locator("#audio-a").setInputFiles(file);
  await page
    .locator("#audio-b")
    .setInputFiles({ ...file, name: `b-${longFilename}` });
}

function columnCount(value: string): number {
  return value.trim().split(/\s+/).length;
}

test("phone layout stays contained and stacks section headings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await selectLongNames(page);

  await expect(page.locator(".brand-mark")).toBeVisible();
  await expect(page.locator("#run")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const columns = await page
    .locator(".section-heading")
    .first()
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columnCount(columns)).toBe(1);
});

test("tablet layout stacks dense controls and result actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 1024 });
  await page.goto("/");
  await selectLongNames(page);

  await assertNoHorizontalOverflow(page);
  for (const selector of [".file-grid", ".controls-grid", ".result-actions"]) {
    const columns = await page
      .locator(selector)
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
    expect(columnCount(columns)).toBe(1);
  }
});
