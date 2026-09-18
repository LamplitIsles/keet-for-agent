---
name: keet-avatar-null-patch
description: Patch a new macOS Keet release for the known avatar-cache null crash in Core's config loader. Use when an official update reports `Cannot set properties of null (setting 'avatar')` from `_runLoadConfig`, or when preparing the version-specific local workaround; do not use for ordinary Keet updates or unrelated chat failures.
---

# Keet avatar null patch

Produce a version-specific local macOS workaround only after proving the
official worker still has the same null-avatar cache-hit defect. This is a
packed worker patch, not a source change to this repository and not evidence
that the official release is defective until the exact candidate is inspected.

Read the repository `AGENTS.md` and `HANDOFF.md` first. Keep patch work in
ignored `.scratch/`; do not alter tracked integration code, live identities,
DSH, or the official-runtime smoke state.

## Fresh provenance

Start from the newly installed, official `/Applications/Keet.app`, not a
previous local patch. Record before mutation:

- the app version/build, architecture, app/worker ownership, and all running
  Keet/Helper processes;
- SHA-256 and byte length of `Contents/Resources/app/core-worker.bundle`;
- outer-app, `bare`, Electron Framework, and distinct Helper signatures,
  Team IDs, runtime flags, and entitlements.

Require a complete untouched app-bundle rollback outside the live app, or an
exact official installer whose version and hashes have been verified. A
resource-only backup cannot recover the original Developer ID trust.

## Locate the candidate

Treat the raw, installed `core-worker.bundle` as the source of truth. First
search it as bytes for the known 4.22.x assignment:

```sh
rg --text --byte-offset --only-matching 's\.avatar=t\.config\.avatar' "$worker"
```

Proceed automatically only when it has exactly one match. Use `xxd` around
that byte offset and require the same cache-hit data flow:

1. `r` is the remote avatar value and is used in the nearby returned object as
   `avatar:r`.
2. The candidate is guarded by an avatar-hash cache comparison involving
   `t?.config?.avatar` and `r?.small?.hash`.
3. The write target `s` is the nullable config-derived object later spread into
   that returned result.

In that exact context, assigning the cached config avatar to `r` preserves the
returned avatar while avoiding a write through nullable `s`.

If the assignment has zero or multiple hits, minified names have changed, or
the three semantic facts are not visible, stop. Obtain matching Core source or
perform a fresh loader analysis before proposing a replacement. Do not infer a
patch point from the stack trace alone.

## Make the packed-worker edit

For the proven context above, the intended expression is:

```js
r=t.config.avatar
```

The packed worker contains byte offsets for later modules. The output must have
the **identical byte length** as the official worker. In the observed 4.22.x
form, the 24-byte original is replaced with the 24-byte expression
`r=t.config.avatar/*xxx*/`; the comment is padding only. Calculate the actual
lengths for the new release rather than assuming those numbers still apply.

Create a new output file, preserving the original input. Require exactly one
replacement, compare input/output byte lengths, record both SHA-256 values,
and search the output to prove the old form is absent and the new form occurs
once. Never use a shorter replacement: the earlier seven-byte shortening moved
later module offsets and made `bare` parse a `package.json` from the wrong byte
(`Unexpected token 'm'`).

## Sign and launch as an Electron code graph

Use the `macos-bundle-signing` skill for the signing and runtime phase. Stage a
complete app copy, replace only the proven worker, and verify it before an
atomic app swap. Hand the privileged `/Applications` mutation to the user in
an auditable `sudo` script; do not handle their password or drive their
terminal.

With no matching Apple signing identity, preserve every nested code object's
official signature and entitlements. Re-sign only the outer app ad hoc with
its own entitlement set. In the known local ad-hoc topology, the outer Keet
main process must additionally receive
`com.apple.security.cs.disable-library-validation=true` so it can load the
still-official Electron Framework. This is a narrow, local runtime-boundary
exception: add it only to the main app, disclose it, and retain the official
Framework, Helpers, and `bare` signatures unchanged. A proper matching signing
identity does not need this exception.

Static `codesign --verify --deep --strict` is necessary but insufficient. After
the user runs the installer, re-check the worker hash/length, nested code hashes
and Team IDs, final main entitlements, and the complete original rollback app.
Launch Keet normally, confirm its main process, Renderer, and `bare` survive,
then inspect logs for dyld Team-ID/library-validation, V8 CodeRange, or worker
errors before declaring it usable.

## Completion report

Report the official version/build, original and patched worker hashes and byte
lengths, candidate-match count plus the confirmed data-flow context, signing
topology/entitlement change, retained rollback paths, and launch evidence. The
functional completion check is a human send in the formerly failing DM; until
that is exercised, state that the avatar behavior remains unverified.
