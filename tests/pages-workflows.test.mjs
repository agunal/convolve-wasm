import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = (name) =>
  new URL(`../.github/workflows/${name}`, import.meta.url);

async function workflow(name) {
  return readFile(workflowUrl(name), "utf8");
}

function jobBlock(contents, name) {
  const marker = `\n  ${name}:\n`;
  const start = contents.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = contents.slice(start + marker.length);
  const nextJob = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

test("CI runs once for PR updates and once for main pushes", async () => {
  const ci = await workflow("ci.yml");

  assert.match(
    ci,
    /on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+pull_request:\s*\n\s+workflow_dispatch:/u,
  );
  await assert.rejects(access(workflowUrl("pages.yml")), { code: "ENOENT" });
});

test("CI blocks verification on a read-only, credential-isolated Pages preflight", async () => {
  const ci = await workflow("ci.yml");
  const preflight = jobBlock(ci, "pages-preflight");
  const verify = jobBlock(ci, "verify");

  assert.match(ci, /^permissions:\s*\n\s+contents:\s+read$/mu);
  assert.match(preflight, /pages:\s+read/u);
  assert.match(preflight, /timeout-minutes:\s+2/u);
  assert.match(preflight, /group:\s+ci-preflight-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}/u);
  assert.match(preflight, /cancel-in-progress:\s+true/u);
  assert.match(preflight, /timeout 20s gh api/u);
  assert.ok(
    preflight.indexOf("Collect GitHub Pages metadata") <
      preflight.indexOf("Check synchronized site URL"),
  );
  assert.match(verify, /needs:\s+pages-preflight/u);
  assert.match(ci, /persist-credentials:\s+false/u);
  assert.equal((ci.match(/GH_TOKEN:/gu) ?? []).length, 1);
  assert.match(preflight, /GH_TOKEN:\s+\$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(ci, /GITHUB_TOKEN:/u);
  assert.match(preflight, /PAGES_METADATA_PATH:/u);
  assert.match(preflight, /node scripts\/pages-preflight\.mjs/u);
});

test("CI uploads the tested Pages artifact only after complete trusted-main verification", async () => {
  const ci = await workflow("ci.yml");
  const verify = jobBlock(ci, "verify");

  assert.match(verify, /group:\s+ci-verify-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}/u);
  assert.match(verify, /cancel-in-progress:\s+true/u);
  assert.match(verify, /Build and validate GitHub Pages artifact/u);
  assert.match(verify, /Test GitHub Pages root and transfer paths in Chromium/u);
  assert.match(verify, /Verify prebuilt FFmpeg core is absent/u);
  assert.match(verify, /Upload verified GitHub Pages artifact/u);
  assert.match(verify, /uses:\s+actions\/upload-pages-artifact@v4/u);
  assert.match(verify, /path:\s+apps\/demo\/dist/u);
  assert.match(verify, /if:\s+\$\{\{ github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request' \}\}/u);
  assert.ok(
    verify.indexOf("Upload verified GitHub Pages artifact") >
      verify.indexOf("Verify prebuilt FFmpeg core is absent"),
  );
});

test("CI holds the non-canceling production lock through deployed SHA verification", async () => {
  const ci = await workflow("ci.yml");
  const deploy = jobBlock(ci, "deploy");

  assert.match(deploy, /needs:\s+verify/u);
  assert.match(deploy, /if:\s+\$\{\{ github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request' \}\}/u);
  assert.match(deploy, /group:\s+pages-production/u);
  assert.match(deploy, /cancel-in-progress:\s+false/u);
  assert.match(deploy, /contents:\s+read/u);
  assert.match(deploy, /pages:\s+write/u);
  assert.match(deploy, /id-token:\s+write/u);
  assert.doesNotMatch(deploy, /contents:\s+write/u);
  assert.match(deploy, /uses:\s+actions\/deploy-pages@v4/u);
  assert.match(deploy, /persist-credentials:\s+false/u);
  assert.match(deploy, /node scripts\/public-site-smoke\.mjs/u);
  assert.ok(
    deploy.indexOf("node scripts/public-site-smoke.mjs") >
      deploy.indexOf("uses: actions/deploy-pages@v4"),
  );
  assert.doesNotMatch(ci, /\n  smoke:\n/u);

  const checkouts = ci.match(/uses:\s+actions\/checkout@/gu) ?? [];
  const isolatedCheckouts = ci.match(/persist-credentials:\s+false/gu) ?? [];
  assert.equal(isolatedCheckouts.length, checkouts.length);
});
