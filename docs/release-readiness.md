# v0.1.0 final release readiness

**Status:** Final release candidate prepared for merge review. Package metadata and the real-browser HE-AAC evidence are prepared on `release/v0.1.0-final`. Merge requires final diff review and explicit owner authorization. Tagging, GitHub release creation, and npm publication remain separately prohibited until the exact-artifact and first-publication controls below are satisfied.

**Merged readiness baseline:** `main` at `60e79cf38174fc0d90df47cbee5f21d274821a43`.

**Final release branch:** `release/v0.1.0-final`.

The branded Chrome, branded Edge, and system Safari HE-AAC matrix passed on 2026-07-15 against the unchanged production build. The complete fixture, browser, formula, output, playback/download, and hash record is in [the hosted release-browser matrix report](testing/2026-07-15-hosted-release-browser-matrix.md).

## Approved preparation decisions

The owner authorized preparation of these release choices:

| Decision | Approved v0.1.0 choice |
|---|---|
| Public version | `0.1.0` |
| Package visibility | Remove `private: true` in the final release pull request |
| npm access | Public scoped package |
| Access enforcement | `publishConfig.access: "public"` |
| Provenance | Required |
| First-publication authentication | One-time short-lived granular npm token, scoped to the `@agunal` package scope, used only by the protected publish workflow and revoked immediately afterward |
| Future registry authentication | GitHub Actions trusted publishing with OIDC; no long-lived npm publish token |
| Package description | `Browser-side stereo audio convolution powered by a Rust/WebAssembly DSP core.` |
| Repository metadata | `agunal/convolve-wasm`, package directory `packages/convolve-wasm` |
| Support metadata | GitHub issues and repository README |
| Package-level Node engines | Omit because the published runtime target is browsers |
| Canonical logo | `docs/assets/convolve-wasm-logo.png`, also copied to `apps/demo/public/convolve-wasm-logo.png` for the demo favicon and hero |
| Logo surfaces | Root README, npm package README, v0.1.0 release notes, demo hero, and demo favicon |
| Tag name | `v0.1.0` |
| Release notes | `docs/releases/v0.1.0.md` |
| Generated WASM | Remains ignored in the source tree; only built distribution assets are packed |
| FFmpeg boundary | `@ffmpeg/core` remains absent |

These choices authorize preparation and review only. They do not authorize merge, tag creation, GitHub release creation, credential creation, registry changes, or publication. Current-head CI evidence is recorded in the final release pull-request description so updating that evidence does not change the release branch commit.

## Gate status before merge

### Completed browser gate

- [x] Generate and inspect a deterministic stereo 48 kHz HE-AAC M4A and WAV impulse without committing audio.
- [x] Record exact Chrome, Edge, Safari, and operating-system versions.
- [x] Record the exact Apple HE-AAC `aach` encoder identifier and the `afconvert` / `afinfo` inspection tools.
- [x] Pass the unchanged repository demo/package/worker/WASM path in branded Chrome, branded Edge, and system Safari.
- [x] Pass plain convolution in every browser.
- [x] Pass `beatPan: "a"` with reverse append in every browser.
- [x] Start playback and activate the download path for both outputs in every browser.
- [x] Confirm WAVE_FORMAT_EXTENSIBLE PCM24, stereo, 48 kHz metadata and browser-specific frame formulas.
- [x] Confirm finite non-silent peak metadata, no clipping, and no page errors.

Evidence: GitHub Actions run `29392630499`, where `fixture`, `windows-matrix`, and `safari-matrix` all completed successfully. The report records input hashes, output hashes, artifact IDs, and artifact digests.

### Completed npm bootstrap investigation

- [x] Query the public registry for `@agunal/convolve-wasm` and `@agunal/convolve-wasm@0.1.0`.
- [x] Confirm both returned registry `E404` on 2026-07-15 in GitHub Actions run `29393336600`.
- [x] Confirm the package is therefore brand-new rather than an existing package with an unpublished version.
- [x] Record that npm trusted publishing is configured from an existing package's settings and cannot be attached before that package exists.
- [x] Record that npm staged publishing cannot create a brand-new package.
- [x] Add a fail-closed one-time bootstrap path that publishes only the already inspected tarball with provenance.

### Remaining merge gates

- [x] Review and approve the complete final release pull-request diff.
- [ ] Obtain explicit owner authorization before merging the final release pull request.

The GitHub environment and npm credential are post-merge, pre-publication controls. They do not need to exist merely to merge code because the publish workflow is manual, requires a release tag, exact commit, exact candidate run, exact tarball hash, an explicit bootstrap acknowledgement, and an environment-scoped secret.

## Why v0.1.0 needs a bootstrap publish

npm trusted publishing is configured from the package settings page. The registry probe proved that `@agunal/convolve-wasm` does not yet exist, so no package settings page exists. npm staged publishing also requires an existing package and cannot create the first version.

Therefore v0.1.0 requires one tightly controlled traditional authentication event. That event must still occur on a GitHub-hosted runner with `id-token: write` and `--provenance`, so the first public version receives provenance. After publication, the token path must be removed operationally by revoking the credential and configuring trusted publishing.

Do not request, paste, commit, log, or transmit the npm token through chat, issues, pull requests, or repository files.

## Required post-merge GitHub and npm controls

Before running the publish workflow:

1. Create a GitHub Actions environment named exactly `npm`.
2. Add the owner as a required reviewer. Keep self-review behavior consistent with the chosen release operator.
3. Create a granular npm token with:
   - read/write package permission;
   - access limited to the `@agunal` scope needed for the first package;
   - bypass 2FA enabled for the non-interactive workflow;
   - the shortest practical expiration, with a one-day maximum target for this release operation.
4. Store it only as the `NPM_BOOTSTRAP_TOKEN` secret in the protected `npm` environment.
5. Do not add an `NPM_TOKEN` repository secret or any long-lived credential.

The available connector cannot administer GitHub deployment environments and has no authenticated npm account access, so these account-bound controls cannot be created from this project session.

## Release workflows

### Build Release Candidate

`.github/workflows/release-candidate.yml` is a manual, non-publishing workflow. It requires the full SHA of the exact current `main` commit and fails closed unless:

- the checked-out commit equals the workflow input and current `origin/main`;
- the package manifest is the approved public `0.1.0` manifest;
- the Chrome, Edge, and Safari HE-AAC rows each exist exactly once, contain no blank fields, and end in `Pass`;
- the full Rust, WASM, TypeScript, package-consumer, build, Chromium, WebKit, package, and FFmpeg-boundary gates pass.

The workflow then runs `npm pack` once, inspects the exact `.tgz`, writes `pack.json`, `CONTENTS.txt`, `SHA256SUMS`, and `RELEASE-METADATA.txt`, and uploads the evidence as the `npm-release-candidate` artifact. It does not tag or publish.

### Publish Inspected npm Artifact

`.github/workflows/publish.yml` is a manual, one-time v0.1.0 bootstrap workflow protected by the `npm` environment. It requires:

```text
source_commit:             exact tagged source SHA
artifact_run_id:           successful Build Release Candidate workflow run
tarball_sha256:            approved lowercase SHA-256
bootstrap_acknowledgement: BOOTSTRAP @agunal/convolve-wasm@0.1.0
```

It verifies:

- every input format and the exact bootstrap acknowledgement;
- the `v0.1.0` tag points to `source_commit`;
- the candidate run is the successful manual `Build Release Candidate` workflow;
- the downloaded tarball matches `SHA256SUMS` and the separately approved hash;
- `RELEASE-METADATA.txt` names the same source commit;
- the packed manifest is the approved public `0.1.0` manifest;
- `@ffmpeg/core` is absent;
- both the package and version are absent from npm, and a registry/network failure is not misread as absence;
- the protected environment contains a nonempty `NPM_BOOTSTRAP_TOKEN` secret.

Only after all checks pass does it publish the downloaded `.tgz` with `--access public --provenance`. It does not rebuild or repack. It then verifies that `0.1.0` is visible in the registry.

## Artifact-specific authorization and publication sequence

After the final release pull request is merged:

1. Run **Build Release Candidate** against the exact resulting `main` commit.
2. Download and review the uploaded tarball and all evidence files.
3. Record:

```text
source commit:
candidate workflow run ID:
tarball filename:
package name/version:
packed size:
unpacked size:
file count:
SHA-256:
inspector:
inspection date:
```

4. Obtain a new explicit authorization naming the exact source commit, candidate run ID, tarball filename, SHA-256, and one-time bootstrap mode.
5. Create `v0.1.0` on that exact source commit only after authorization.
6. Configure the protected `npm` environment and short-lived `NPM_BOOTSTRAP_TOKEN` secret.
7. Run **Publish Inspected npm Artifact** with the exact approved values and acknowledgement.
8. Verify the package and provenance on npm.
9. Immediately revoke the granular bootstrap token and delete the environment secret.
10. In the new package settings, configure trusted publishing with:

```text
provider:          GitHub Actions
GitHub user:       agunal
repository:        convolve-wasm
workflow:          publish.yml
environment:       npm
allowed action:    npm publish
```

11. Set package publishing access to require 2FA and disallow traditional tokens.
12. Create a GitHub release only if separately authorized.

Future versions must use OIDC trusted publishing, not the v0.1.0 bootstrap token path.

Any mismatch in commit, workflow run, filename, hash, package metadata, browser matrix, tag, registry state, bootstrap acknowledgement, environment, credential, or downloaded artifact voids the authorization and stops the release.

## Current prohibited actions

Until the relevant gate above is satisfied:

- do not merge without explicit merge authorization;
- do not create `v0.1.0` before exact-artifact authorization;
- do not create a GitHub release without separate authorization;
- do not run either release workflow against an unapproved commit;
- do not publish any rebuilt or repacked artifact;
- do not create or retain a long-lived npm publish token;
- do not disclose the bootstrap token outside the protected GitHub environment;
- do not commit private HE-AAC audio, deterministic browser fixtures, output audio, or generated source-tree WASM.
