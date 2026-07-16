# Conservative Visual Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair broken GitHub image references and make the existing Pages interface robust at phone and tablet widths without changing application behavior.

**Architecture:** Add one focused documentation-asset validator and one focused responsive-layout Playwright specification. Repair the package README reference, then adjust only the existing demo stylesheet to satisfy the responsive contract while preserving markup, JavaScript, WASM, and deployment paths.

**Tech Stack:** Node.js ESM, Playwright 1.61, Vite 8, CSS, GitHub Actions.

## Global Constraints

- Preserve `CONVOLVE()` signatures, errors, DSP order, output, worker loading, and WASM loading.
- Preserve local base `/` and Pages base `/convolve-wasm/`.
- Keep the existing cream, charcoal, and orange visual identity.
- Keep the approved logo files byte-for-byte unchanged.
- Keep audio browser-local and keep `@ffmpeg/core` absent.
- Do not add runtime dependencies, remote fonts, animations, analytics, uploads, or server behavior.
- Do not merge, tag, publish, or create a release.

---

### Task 1: Guard repository documentation images

**Files:**
- Create: `scripts/validate-doc-assets.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/convolve-wasm/README.md`

**Interfaces:**
- Produces root command `npm run validate:docs`.
- The validator exits `0` only when rendered repository-owned image references resolve to files in the checkout.

- [ ] **Step 1: Add the validator and command while retaining the known bad reference**

Create `scripts/validate-doc-assets.mjs` with this behavior:

```js
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = path.join(root, "docs");
const rawPrefix =
  "https://raw.githubusercontent.com/agunal/convolve-wasm/main/";
const ignoredDirectories = new Set(["superpowers"]);
const entryFiles = [
  path.join(root, "README.md"),
  path.join(root, "packages/convolve-wasm/README.md"),
];

async function collectMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectMarkdown(path.join(directory, entry.name))));
      }
    } else if (entry.name.endsWith(".md")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function imageReferences(source) {
  const references = [];
  for (const pattern of [
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

async function assertExists(file, reference, owner) {
  try {
    await access(file);
  } catch {
    throw new Error(`${owner}: missing image ${reference} -> ${file}`);
  }
}

const markdownFiles = [...entryFiles, ...(await collectMarkdown(docsRoot))];
let checked = 0;
for (const markdownFile of markdownFiles) {
  const source = await readFile(markdownFile, "utf8");
  for (const reference of imageReferences(source)) {
    if (reference.startsWith("data:") || reference.startsWith("#")) continue;

    const rawMatch = reference.match(
      /^https:\/\/raw\.githubusercontent\.com\/agunal\/convolve-wasm\/([^/]+)\/(.+)$/,
    );
    if (rawMatch) {
      if (!reference.startsWith(rawPrefix)) {
        throw new Error(
          `${path.relative(root, markdownFile)}: repository image must use main, not ${rawMatch[1]}`,
        );
      }
      await assertExists(
        path.join(root, rawMatch[2]),
        reference,
        path.relative(root, markdownFile),
      );
      checked += 1;
      continue;
    }

    if (/^https?:\/\//.test(reference)) continue;
    const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    const resolved = path.resolve(path.dirname(markdownFile), cleanReference);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${path.relative(root, markdownFile)}: image escapes repository: ${reference}`);
    }
    await assertExists(resolved, reference, path.relative(root, markdownFile));
    checked += 1;
  }
}

console.log(`Validated ${checked} repository documentation image reference(s).`);
```

Add to root `package.json`:

```json
"validate:docs": "node scripts/validate-doc-assets.mjs"
```

Add this CI step immediately after `npm ci`:

```yaml
- name: Validate documentation image assets
  run: npm run validate:docs
```

- [ ] **Step 2: Run the validator and confirm RED**

Run: `npm run validate:docs`

Expected: FAIL and name `packages/convolve-wasm/README.md`, the nonexistent `v0.1.0` ref, and the requirement to use `main`.

- [ ] **Step 3: Repair the package README reference**

Replace the package README logo URL with:

```html
<img src="https://raw.githubusercontent.com/agunal/convolve-wasm/main/docs/assets/convolve-wasm-logo.png" alt="convolve-wasm logo" width="192" />
```

- [ ] **Step 4: Run the validator and confirm GREEN**

Run: `npm run validate:docs`

Expected: PASS and report at least the root README, package README, and release-note logo references.

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-doc-assets.mjs package.json .github/workflows/ci.yml packages/convolve-wasm/README.md
git commit -m "fix: repair and validate documentation images"
```

---

### Task 2: Define responsive layout behavior

**Files:**
- Create: `tests/e2e/layout.spec.ts`

**Interfaces:**
- Consumes the existing Vite demo served by `tests/e2e/playwright.config.ts`.
- Produces explicit phone and tablet layout contracts without snapshot-pixel coupling.

- [ ] **Step 1: Add failing responsive tests**

Create `tests/e2e/layout.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const longFilename = `${"long-source-name-".repeat(8)}.wav`;

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function selectLongNames(page) {
  const file = { name: longFilename, mimeType: "audio/wav", buffer: Buffer.alloc(44) };
  await page.locator("#audio-a").setInputFiles(file);
  await page.locator("#audio-b").setInputFiles({ ...file, name: `b-${longFilename}` });
}

function columnCount(value: string): number {
  return value.trim().split(/\s+/).length;
}

test("phone layout stays contained and stacks section headings", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await selectLongNames(page);

  await expect(page.locator(".brand-mark")).toBeVisible();
  await expect(page.locator("#run")).toBeVisible();
  await assertNoHorizontalOverflow(page);

  const columns = await page.locator(".section-heading").first().evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );
  expect(columnCount(columns)).toBe(1);
});

test("tablet layout stacks dense controls and result actions", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1024 });
  await page.goto("/");
  await selectLongNames(page);

  await assertNoHorizontalOverflow(page);
  for (const selector of [".file-grid", ".controls-grid", ".result-actions"]) {
    const columns = await page.locator(selector).evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns,
    );
    expect(columnCount(columns)).toBe(1);
  }
});
```

Use `import type { Page } from "@playwright/test"` for helper typing before committing.

- [ ] **Step 2: Run the layout specification and confirm RED**

Run: `npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/layout.spec.ts --project=chromium`

Expected: FAIL because the current 360px section heading and 720px grids still use two columns.

- [ ] **Step 3: Commit the failing contract**

```bash
git add tests/e2e/layout.spec.ts
git commit -m "test: define responsive demo layout"
```

---

### Task 3: Apply the conservative CSS cleanup

**Files:**
- Modify: `apps/demo/src/styles.css`

**Interfaces:**
- Satisfies the layout contract from Task 2.
- Does not change HTML IDs/classes consumed by application code or existing tests.

- [ ] **Step 1: Make global and component dimensions fluid and overflow-safe**

Apply these targeted rules in the existing stylesheet:

```css
:root {
  color-scheme: light;
}

body {
  overflow-x: hidden;
}

.shell {
  width: min(920px, calc(100% - clamp(24px, 6vw, 48px)));
  padding: clamp(36px, 7vw, 64px) 0 clamp(48px, 9vw, 80px);
}

.hero {
  max-width: 700px;
  margin-bottom: clamp(28px, 5vw, 40px);
}

.brand-mark {
  width: clamp(128px, 20vw, 176px);
  height: auto;
  aspect-ratio: 1;
  object-fit: contain;
}

h1 {
  max-width: 100%;
  font-size: clamp(2.8rem, 10vw, 6.5rem);
  overflow-wrap: normal;
  text-wrap: balance;
}

.lede {
  max-width: 62ch;
}

.panel,
.about-panel {
  padding: clamp(20px, 4vw, 28px);
}

.section-heading,
.file-grid,
.controls-grid,
.about-grid,
.result-actions,
.run-panel > *,
label {
  min-width: 0;
}

.section-heading {
  column-gap: 12px;
}

input[type="file"] {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

#preview {
  min-width: 0;
}

.download,
.resource-links a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.resource-links a {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.panel,
.run-panel,
.result-panel,
.about-panel {
  -webkit-backdrop-filter: blur(16px);
}
```

Do not duplicate existing declarations; merge these values into the existing rule blocks.

- [ ] **Step 2: Replace the single breakpoint with tablet and phone behavior**

Use these responsive rules:

```css
@media (max-width: 760px) {
  .file-grid,
  .controls-grid,
  .about-grid,
  .result-actions {
    grid-template-columns: minmax(0, 1fr);
  }

  .run-panel {
    align-items: stretch;
    flex-direction: column;
  }

  #run,
  .download {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .section-heading {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .step {
    margin-bottom: 6px;
  }

  .run-panel,
  .result-panel {
    padding: 20px;
  }

  .resource-links {
    display: grid;
  }

  .resource-links a {
    width: 100%;
  }
}
```

Remove the superseded 680px declarations rather than leaving contradictory rules.

- [ ] **Step 3: Run the responsive tests and confirm GREEN**

Run: `npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/layout.spec.ts --project=chromium`

Expected: both phone and tablet cases PASS.

- [ ] **Step 4: Run the full local browser suite**

Run: `npm run test:e2e`

Expected: all existing convolution cases plus responsive cases pass in Chromium and WebKit.

- [ ] **Step 5: Commit**

```bash
git add apps/demo/src/styles.css
git commit -m "fix: polish responsive demo layout"
```

---

### Task 4: Verify Pages and release boundaries

**Files:**
- No production file changes expected.

**Interfaces:**
- Confirms the cleaned interface still emits the same deployable artifact and audio behavior.

- [ ] **Step 1: Run documentation and Pages validation**

```bash
npm run validate:docs
npm run build:pages
npm run validate:pages
npm run test:pages
```

Expected: all commands pass; the Pages smoke still observes worker and WASM requests under `/convolve-wasm/`.

- [ ] **Step 2: Run project gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run test:ts
npm run build
npm pack -w @agunal/convolve-wasm --dry-run
```

Expected: all commands pass.

- [ ] **Step 3: Verify the FFmpeg boundary**

Run: `npm ls @ffmpeg/core`

Expected: nonzero is acceptable only because the dependency is absent; output must not list an installed `@ffmpeg/core` package.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check main...HEAD` and `git status --short`.

Expected: no whitespace errors and a clean working tree.

- [ ] **Step 5: Open the pull request**

Open a PR from `fix/visual-cleanup` to `main` summarizing the proven broken image, responsive cleanup, new regression gates, exact CI evidence, and unchanged DSP/runtime boundaries. Stop before merge.