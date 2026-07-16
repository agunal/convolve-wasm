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

async function gridColumnCount(page: Page, selector: string): Promise<number> {
  const columns = await page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  return columnCount(columns);
}

async function expectTouchTarget(page: Page, selector: string): Promise<void> {
  const height = await page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
}

test("desktop presents the embossed stone visual system", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/");

  const theme = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const hero = getComputedStyle(document.querySelector(".hero") as HTMLElement);
    return {
      colorScheme: root.colorScheme,
      stoneBase: root.getPropertyValue("--stone-0").trim(),
      metalAccent: root.getPropertyValue("--metal-accent").trim(),
      heroDisplay: hero.display,
      heroColumns: hero.gridTemplateColumns,
    };
  });

  expect(theme.colorScheme).toContain("dark");
  expect(theme.stoneBase).not.toBe("");
  expect(theme.metalAccent).not.toBe("");
  expect(theme.heroDisplay).toBe("grid");
  expect(columnCount(theme.heroColumns)).toBe(2);
  await expect(page.locator(".brand-plaque")).toBeVisible();
  await expect(page.locator(".hero-relief")).toBeVisible();
  await expect(page.locator(".icon-sprite")).toHaveCount(1);
  await expect(page.locator("#run .ui-icon")).toHaveCount(1);
  await expect(page.locator(".download .ui-icon")).toHaveCount(1);
  await expect(page.locator(".control-label .ui-icon")).toHaveCount(4);
  await expect(page.locator(".site-footer .ui-icon")).toHaveCount(5);
  await expectTouchTarget(page, "#run");
  await expectTouchTarget(page, ".footer-links a");
  await expectTouchTarget(page, ".bluesky-link");
  await assertNoHorizontalOverflow(page);
});

test("phone layout stays contained and stacks section headings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await selectLongNames(page);

  await expect(page.locator(".brand-mark")).toBeVisible();
  await expect(page.locator("#run")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  expect(await gridColumnCount(page, ".hero")).toBe(1);
  expect(await gridColumnCount(page, ".section-heading")).toBe(1);
  expect(await gridColumnCount(page, ".footer-grid")).toBe(1);
  await expectTouchTarget(page, "#run");
  await expectTouchTarget(page, "input[type=file]");
  await expectTouchTarget(page, ".footer-links a");
  await expectTouchTarget(page, ".bluesky-link");
});

test("tablet layout stacks dense controls and result actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 1024 });
  await page.goto("/");
  await selectLongNames(page);

  await assertNoHorizontalOverflow(page);
  for (const selector of [".file-grid", ".controls-grid", ".result-actions"]) {
    expect(await gridColumnCount(page, selector)).toBe(1);
  }
  await expectTouchTarget(page, ".download");
  await expectTouchTarget(page, ".footer-links a");
});
