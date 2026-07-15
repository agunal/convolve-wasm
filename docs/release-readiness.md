# v0.1.0 release readiness

**Status:** Draft release gate; not approved for tagging or publication.

**Verified baseline:** `main` at `a088b5bf57aa3f256da79de86a0de2d21a265684` on 2026-07-14.

This document makes the remaining release decisions and evidence requirements explicit. It does not authorize removal of `private: true`, creation of a tag or GitHub release, or publication to npm.

This documentation-only readiness change may merge while the package remains private. A separate final release pull request must contain the approved browser evidence, manifest metadata, and release notes. The final packed artifact must be built from the exact commit produced by merging that later release pull request.

## Current evidence

- Pull request #1 is merged and closed at the verified baseline commit.
- GitHub Actions run `29374482569` was the successful pre-merge PR integration run for the implementation that was subsequently squash-merged.
- The run passed Rust formatting, linting and tests; the WASM build and Chromium smoke tests; TypeScript/package tests; the library and demo build; Chromium and WebKit E2E; package inspection; and the `@ffmpeg/core` absence check.
- The package-consumer test creates an actual temporary npm tarball, confirms the package README and license are present, installs the tarball into a clean consumer, and verifies that the consumer build emits local worker and WASM assets.
- `packages/convolve-wasm/package.json` remains version `0.1.0` with `"private": true`.
- The manual desktop HE-AAC matrix is not complete and remains a release blocker.

Automated evidence is not a substitute for the manual M4A matrix. See [browser and codec support](browser-support.md) for the local-container record, GitHub Actions record, and the uncompleted Chrome/Edge/Safari table.

## Release decision record

The following defaults are recommendations for the first public release. Each owner decision must be approved explicitly before the corresponding repository or registry action is taken.

| Decision | Recommended v0.1.0 choice | Current state |
|---|---|---|
| Public version | Keep `0.1.0` as the first public version | Owner approval required |
| Package visibility | Remove `private: true` only in the separate final release pull request | Intentionally unchanged in this draft |
| npm access | Publish `@agunal/convolve-wasm` as a public scoped package | Owner approval required |
| Access enforcement | Add `"publishConfig": { "access": "public" }` and preserve an explicit public-access publish gate | Owner approval required |
| Provenance | Require verifiable registry provenance for the published artifact | Publishing workflow/auth method still to be approved |
| Registry authentication | Use an owner-controlled, least-privilege publication path | Not configured or exercised in this draft |
| Package description | `Browser-side stereo audio convolution powered by a Rust/WebAssembly DSP core.` | Owner approval required |
| Repository metadata | Add the GitHub repository URL and package directory `packages/convolve-wasm` | Owner approval required |
| Support metadata | Add GitHub issues as `bugs.url` and the repository README as `homepage` | Owner approval required |
| Package-level Node engines | Omit in v0.1.0 because the published runtime is browser-based; retain the root Node requirement for development tooling | Owner approval required |
| Tag name | `v0.1.0` | Owner approval required; do not create yet |
| GitHub release | First-public-release notes tied to the approved tag | Not drafted or created yet |
| Generated WASM | Keep `packages/convolve-wasm/src/wasm/` ignored; publish only built distribution assets | Confirmed project boundary |
| FFmpeg boundary | Keep `@ffmpeg/core` absent | Confirmed project boundary |

The recommended final manifest metadata is equivalent to:

```json
{
  "description": "Browser-side stereo audio convolution powered by a Rust/WebAssembly DSP core.",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/agunal/convolve-wasm.git",
    "directory": "packages/convolve-wasm"
  },
  "bugs": {
    "url": "https://github.com/agunal/convolve-wasm/issues"
  },
  "homepage": "https://github.com/agunal/convolve-wasm#readme",
  "publishConfig": {
    "access": "public"
  }
}
```

Approval checklist:

- [ ] Confirm that `0.1.0` is the intended first public version.
- [ ] Confirm public npm access and `publishConfig.access` for the scoped package.
- [ ] Approve the provenance and registry-authentication method.
- [ ] Approve the package description, repository, bugs, homepage, and package-level engines decision.
- [ ] Approve removal of `private: true` in the separate final release pull request.
- [ ] Approve tag name `v0.1.0` and the release-note text.
- [ ] Authorize tagging and npm publication only after every gate below passes.

## Manual HE-AAC blocker

Run the matrix in `docs/browser-support.md` with a known stereo 48 kHz HE-AAC `.m4a` and a WAV impulse on current desktop Chrome, Edge, and Safari.

Release acceptance requires, for every browser:

- exact browser and operating-system versions;
- exact M4A codec/profile identification and the named inspection tool used;
- passing plain convolution;
- passing `beatPan: "a"` with reverse append;
- successful playback and download of both outputs;
- stereo 48 kHz PCM24 metadata;
- expected output-frame formulas;
- finite, non-silent peak metadata;
- no clipping and no page errors.

Do not convert a blank row, a Playwright WebKit result, or an assumed native-codec capability into a manual pass.

## Final packed-tarball inspection

The existing package-consumer test proves that an implementation tarball can be installed and bundled. The final release artifact still needs a recorded inspection after the approved manifest changes.

Perform this inspection only after the separate final release pull request has merged. Use a fresh checkout of the exact resulting commit. Run `npm pack` once, retain that exact `.tgz`, and publish that same file after authorization. Do not rebuild or repack between inspection and publication.

```bash
source_commit=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"

release_pack_dir=${RELEASE_PACK_DIR:-"$(mktemp -d)"}
mkdir -p "$release_pack_dir"
test -z "$(find "$release_pack_dir" -mindepth 1 -maxdepth 1 -print -quit)"
printf 'Source commit: %s\n' "$source_commit"
printf 'Release artifact directory: %s\n' "$release_pack_dir"

npm ci
npm run build:wasm
npm run build -w @agunal/convolve-wasm
npm pack --json --pack-destination "$release_pack_dir" -w @agunal/convolve-wasm \
  > "$release_pack_dir/pack.json"

tarball=$(find "$release_pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)
test -n "$tarball"

cat "$release_pack_dir/pack.json"
tar -tzf "$tarball" | LC_ALL=C sort
sha256sum "$tarball" | tee "$release_pack_dir/SHA256SUMS"

mkdir "$release_pack_dir/unpacked"
tar -xzf "$tarball" -C "$release_pack_dir/unpacked"

if grep -R -n -F '@ffmpeg/core' "$release_pack_dir/unpacked/package"; then
  echo "@ffmpeg/core found in packed artifact" >&2
  exit 1
fi

set +e
ffmpeg_tree=$(npm ls @ffmpeg/core 2>&1)
ffmpeg_status=$?
set -e
printf '%s\n' "$ffmpeg_tree"
if [ "$ffmpeg_status" -eq 0 ] || grep -q '@ffmpeg/core@' <<<"$ffmpeg_tree"; then
  echo "@ffmpeg/core must be absent from the dependency tree" >&2
  exit 1
fi
```

Do not delete or overwrite `release_pack_dir` after inspection. Preserve it until the artifact is either published or the release is explicitly abandoned. In automation, upload the `.tgz`, `pack.json`, and `SHA256SUMS` before the workspace is cleaned up.

Record all of the following in the release approval record:

```text
source commit:
tarball filename:
package name/version:
packed size:
unpacked size:
file count:
SHA-256:
inspector:
inspection date:
```

Acceptance criteria:

- the source commit is the exact commit produced by merging the separate final release pull request;
- package name, version, access policy, provenance policy, and approved metadata match the release decisions;
- `private: true` is absent from the final publishable manifest;
- `package.json`, `README.md`, `LICENSE`, the root JavaScript entry, declarations, the module-worker asset, and the standalone WASM asset are present;
- source files, tests, demo files, repository-only documentation, private audio, and bootstrap transport artifacts are absent;
- `packages/convolve-wasm/src/wasm/` remains untracked in the repository;
- the packed tarball still passes the clean package-consumer build;
- `@ffmpeg/core` is absent from both the dependency tree and the extracted packed contents;
- the recorded SHA-256 corresponds to the exact `.tgz` approved and later supplied to the publish command.

If release automation uses separate verification and publication jobs, the verification job must upload this exact `.tgz` and its `SHA256SUMS`. The publication job must download both, verify the recorded hash, and publish the tarball without running `npm pack` again.

## Clean-room release verification

Run these gates from a fresh checkout of the exact commit produced by merging the separate final release pull request:

```bash
git status --short
git rev-parse HEAD
node --version
npm --version
rustc --version
cargo --version
wasm-pack --version

npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run build:wasm
npm run test:ts
npm run build
npx playwright install --with-deps chromium webkit
wasm-pack test --headless --chrome crates/convolve-core
npm run test:e2e
npm pack -w @agunal/convolve-wasm --dry-run
npm ls @ffmpeg/core
git diff --check
git status --short
```

Expected outcome:

- every validation command succeeds, except that the intentional `npm ls @ffmpeg/core` absence may produce a nonzero exit status;
- the working tree is clean after generated ignored artifacts are removed or ignored as designed;
- the actual tarball inspection above is complete and recorded;
- no private audio, generated source-tree WASM, or transport artifact is committed.

## Release sequence and stop points

1. Review and merge this documentation-only readiness pull request while `private: true` remains unchanged.
2. Complete and record the manual HE-AAC matrix.
3. Obtain explicit owner approval for version, npm access, manifest metadata, provenance/authentication, visibility, tag name, and release notes.
4. Open a separate final release pull request containing the approved browser evidence, manifest changes, and release notes; do not tag or publish from that pull request branch.
5. Run its full CI and review the complete release diff.
6. Merge the final release pull request through the approved merge method.
7. Check out the exact resulting commit in a fresh environment and run the clean-room gates.
8. Pack once from that exact commit, inspect the `.tgz`, record its complete metadata and SHA-256, and preserve that exact file.
9. Obtain a separate explicit authorization naming the source commit and tarball SHA-256.
10. Tag that exact source commit and publish the already inspected `.tgz` through the approved provenance/authentication path without rebuilding or repacking.
11. Create the GitHub release only if separately authorized.
12. Stop immediately if the source commit, tarball hash, manual matrix, approved decisions, or downloaded release artifact no longer match.

Until steps 1 through 11 are satisfied, the repository is release-prepared but not release-authorized.
