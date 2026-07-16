import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing required file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function readJson(relativePath) {
  const source = read(relativePath);
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch (error) {
    failures.push(`invalid JSON in ${relativePath}: ${error.message}`);
    return {};
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const packageManifest = readJson("packages/convolve-wasm/package.json");
expectEqual(packageManifest.name, "@takana-labs/convolve-wasm", "package name");
expectEqual(
  packageManifest.repository?.url,
  "git+https://github.com/takana-labs/convolve-wasm.git",
  "package repository",
);
expectEqual(
  packageManifest.bugs?.url,
  "https://github.com/takana-labs/convolve-wasm/issues",
  "package issue tracker",
);
expectEqual(packageManifest.homepage, "https://convolve-wasm.app/", "package homepage");
if (packageManifest.publishConfig !== undefined) {
  failures.push("npm publishConfig must be absent for the JSR-first package");
}

const demoManifest = readJson("apps/demo/package.json");
expectEqual(demoManifest.name, "@takana-labs/convolve-demo", "demo workspace name");
expectEqual(
  demoManifest.dependencies?.["@takana-labs/convolve-wasm"],
  "0.1.0",
  "demo package dependency",
);
if (demoManifest.dependencies?.["@agunal/convolve-wasm"] !== undefined) {
  failures.push("demo still depends on @agunal/convolve-wasm");
}

const jsrManifest = readJson("packages/convolve-wasm/jsr.json");
expectEqual(jsrManifest.$schema, "https://jsr.io/schema/config-file.v1.json", "JSR schema");
expectEqual(jsrManifest.name, "@takana-labs/convolve-wasm", "JSR package name");
expectEqual(jsrManifest.version, "0.1.0", "JSR package version");
expectEqual(jsrManifest.exports, "./dist/index.js", "JSR default export");

const publishInclude = jsrManifest.publish?.include;
for (const requiredEntry of ["dist/**", "README.md", "LICENSE"]) {
  if (!Array.isArray(publishInclude) || !publishInclude.includes(requiredEntry)) {
    failures.push(`JSR publish.include must contain ${requiredEntry}`);
  }
}

const publishExclude = jsrManifest.publish?.exclude;
if (!Array.isArray(publishExclude) || !publishExclude.includes("!dist")) {
  failures.push("JSR publish.exclude must unignore dist with !dist");
}

if (fs.existsSync(path.join(root, ".github/workflows/publish.yml"))) {
  failures.push("legacy npm workflow .github/workflows/publish.yml must be removed");
}
read(".github/workflows/publish-jsr.yml");
read("packages/convolve-wasm/LICENSE");

const identityFiles = [
  "README.md",
  "package.json",
  "package-lock.json",
  "packages/convolve-wasm/package.json",
  "packages/convolve-wasm/README.md",
  "apps/demo/package.json",
  "apps/demo/src/main.ts",
  "apps/demo/index.html",
  "scripts/validate-doc-assets.mjs",
  "scripts/validate-repo-links.mjs",
  "scripts/validate-pages.mjs",
  "tests/pages/pages.spec.ts",
  "packages/convolve-wasm/tests/package-consumer.test.ts",
  "docs/architecture.md",
  "docs/browser-support.md",
  "docs/release-readiness.md",
  "docs/releases/v0.1.0.md",
  "crates/convolve-core/Cargo.toml",
  ".github/workflows/ci.yml",
  ".github/workflows/pages.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/publish-jsr.yml",
];

const forbidden = [
  "@agunal/convolve-wasm",
  "@agunal/convolve-demo",
  "github.com/agunal/convolve-wasm",
  "raw.githubusercontent.com/agunal/convolve-wasm",
  "agunal.github.io/convolve-wasm",
  "NPM_BOOTSTRAP_TOKEN",
  "npm publish",
];

for (const relativePath of identityFiles) {
  const content = read(relativePath);
  for (const token of forbidden) {
    if (content.includes(token)) {
      failures.push(`${relativePath} still contains forbidden identity token: ${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Project identity validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Project identity is aligned with takana-labs, JSR, and convolve-wasm.app.");
