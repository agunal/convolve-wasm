# v0.1.0 final release readiness

**Status:** Draft final release candidate. The package metadata is prepared on `release/v0.1.0-final`, but merge, tagging, GitHub release creation, and npm publication remain prohibited until every blocker and authorization gate below is satisfied.

**Merged readiness baseline:** `main` at `60e79cf38174fc0d90df47cbee5f21d274821a43`.

**Final release branch:** `release/v0.1.0-final`.

The manual desktop HE-AAC matrix is not available in the current execution environment and remains a hard release blocker. No blank row or automated WebKit result may be converted into a manual pass.

## Approved preparation decisions

The owner authorized preparation of these release choices:

| Decision | Approved v0.1.0 choice |
|---|---|
| Public version | `0.1.0` |
| Package visibility | Remove `private: true` in the final release pull request |
| npm access | Public scoped package |
| Access enforcement | `publishConfig.access: "public"` |
| Provenance | Required |
| Registry authentication | GitHub Actions trusted publishing with OIDC; do not use a long-lived npm publish token |
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

These choices authorize preparation and review only. They do not authorize merge, tag creation, GitHub release creation, registry changes, or publication. Current-head CI evidence is recorded in the final release pull-request description so updating that evidence does not change the release branch commit.

## Hard blockers before merge

- [ ] Complete and record the real stereo 48 kHz HE-AAC matrix in `docs/browser-support.md` on current desktop Chrome, Edge, and Safari.
- [ ] Record exact browser and operating-system versions.
- [ ] Record the exact AAC profile or object type and the inspection tool used.
- [ ] Pass plain convolution in every browser.
- [ ] Pass `beatPan: "a"` with reverse append in every browser.
- [ ] Play and download both outputs in every browser.
- [ ] Confirm stereo 48 kHz PCM24 metadata and expected frame formulas.
- [ ] Confirm finite non-silent peak metadata, no clipping, and no page errors.
- [ ] Configure npm trusted publishing for this repository and workflow.
- [ ] Configure a protected GitHub environment named `npm` with an owner approval gate.
- [ ] Confirm that npm trusted publishing supports this first publication path; if not, stop and separately review any bootstrap path.
- [ ] Review and approve the complete final release pull-request diff.
- [ ] Obtain explicit owner authorization before merging the final release pull request.

## Trusted-publisher configuration

Before publication, configure npm trusted publishing with these exact values:

```text
provider:          GitHub Actions
npm organization: agunal
repository:        convolve-wasm
workflow:          publish.yml
environment:       npm
allowed action:    npm publish
```

Configure a GitHub Actions environment named `npm` with required owner review. The publish workflow uses `id-token: write` and must not receive an `NPM_TOKEN` secret.

If npm does not allow a trusted publisher to be configured before the package's first publication, stop. Do not silently fall back to a long-lived token. Any bootstrap publication path needs a separate security review and explicit authorization.

## Release workflows

### Build Release Candidate

`.github/workflows/release-candidate.yml` is a manual, non-publishing workflow. It requires the full SHA of the exact current `main` commit and fails closed unless:

- the checked-out commit equals the workflow input and current `origin/main`;
- the package manifest is the approved public `0.1.0` manifest;
- the Chrome, Edge, and Safari HE-AAC rows each exist exactly once, contain no blank fields, and end in `Pass`;
- the full Rust, WASM, TypeScript, package-consumer, build, Chromium, WebKit, package, and FFmpeg-boundary gates pass.

The workflow then runs `npm pack` once, inspects the exact `.tgz`, writes `pack.json`, `CONTENTS.txt`, `SHA256SUMS`, and `RELEASE-METADATA.txt`, and uploads the evidence as the `npm-release-candidate` artifact. It does not tag or publish.

### Publish Inspected npm Artifact

`.github/workflows/publish.yml` is a separate manual workflow protected by the `npm` environment. It requires:

```text
source_commit:    exact tagged source SHA
artifact_run_id:  successful Build Release Candidate workflow run
tarball_sha256:   approved lowercase SHA-256
```

It verifies:

- the full input formats;
- the `v0.1.0` tag points to `source_commit`;
- the candidate run is the successful manual `Build Release Candidate` workflow;
- the downloaded tarball matches `SHA256SUMS` and the separately approved hash;
- `RELEASE-METADATA.txt` names the same source commit;
- the packed manifest is the approved public `0.1.0` manifest;
- `@ffmpeg/core` is absent;
- the version is not already present in the registry, and a registry/network failure is not misread as absence.

Only after all checks pass does it run `npm publish` on the downloaded `.tgz`. It does not rebuild or repack.

## Artifact-specific authorization

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

4. Obtain a new explicit authorization naming the exact source commit, candidate run ID, tarball filename, and SHA-256.
5. Create `v0.1.0` on that exact source commit only after authorization.
6. Run **Publish Inspected npm Artifact** with those exact approved values.
7. Create a GitHub release only if separately authorized.

Any mismatch in commit, workflow run, filename, hash, package metadata, manual matrix, tag, registry configuration, or downloaded artifact voids the authorization and stops the release.

## Current prohibited actions

Until every gate above is satisfied:

- do not merge the final release pull request;
- do not create `v0.1.0`;
- do not create a GitHub release;
- do not run either release workflow against an unapproved commit;
- do not publish to npm;
- do not add a long-lived npm publish token;
- do not commit private HE-AAC audio or generated source-tree WASM.
