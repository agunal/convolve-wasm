import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(
      `${relativePath}: file: expected "present", got "missing"`,
    );
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function expectEqual(relativePath, setting, actual, expected) {
  if (actual !== expected) {
    failures.push(
      `${relativePath}: ${setting}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function unquote(value) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const packageSource = read("package.json");
if (packageSource) {
  try {
    const packageManifest = JSON.parse(packageSource);
    expectEqual(
      "package.json",
      "engines.node",
      packageManifest.engines?.node,
      "^24.0.0",
    );
  } catch (error) {
    failures.push(
      `package.json: JSON: expected "valid", got ${JSON.stringify(error.message)}`,
    );
  }
}

const workflowsDirectory = path.join(root, ".github", "workflows");
let workflowFiles = [];
if (!fs.existsSync(workflowsDirectory)) {
  failures.push(
    `.github/workflows: directory: expected "present", got "missing"`,
  );
} else {
  workflowFiles = fs
    .readdirSync(workflowsDirectory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

let checkoutReferenceCount = 0;
let setupNodeReferenceCount = 0;

for (const relativePath of workflowFiles) {
  const source = read(relativePath);
  const checkoutReferences = [
    ...source.matchAll(/uses:\s*["']?actions\/checkout@([^"'\s#]+)["']?/g),
  ];
  const setupNodeReferences = [
    ...source.matchAll(/uses:\s*["']?actions\/setup-node@([^"'\s#]+)["']?/g),
  ];
  const nodeVersionDeclarations = [
    ...source.matchAll(/^[\t ]*node-version:[\t ]*([^#\r\n]+)(?:#.*)?$/gm),
  ];

  checkoutReferenceCount += checkoutReferences.length;
  setupNodeReferenceCount += setupNodeReferences.length;

  for (const reference of checkoutReferences) {
    expectEqual(relativePath, "actions/checkout", reference[1], "v6");
  }
  for (const reference of setupNodeReferences) {
    expectEqual(relativePath, "actions/setup-node", reference[1], "v6");
  }
  for (const declaration of nodeVersionDeclarations) {
    expectEqual(relativePath, "node-version", unquote(declaration[1]), "24");
  }
  expectEqual(
    relativePath,
    "node-version declaration count",
    nodeVersionDeclarations.length,
    setupNodeReferences.length,
  );
}

if (checkoutReferenceCount === 0) {
  failures.push(
    `.github/workflows: actions/checkout references: expected ">0", got 0`,
  );
}
if (setupNodeReferenceCount === 0) {
  failures.push(
    `.github/workflows: actions/setup-node references: expected ">0", got 0`,
  );
}

if (failures.length > 0) {
  console.error("Node toolchain validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Node toolchain is aligned with Node 24 and GitHub Actions v6.");
