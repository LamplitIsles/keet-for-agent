# Prepare the private Keet runtime

The public package contains TypeScript and DSH integration code only. It does
not redistribute the official Keet executable, worker bundle, or native
addons. An operator must obtain the official Linux x64 release privately and
prepare the fixed local read-only runtime directory beneath `$DSH_HOME`.

The admitted compatibility tuple is:

| Component | Required value |
| --- | --- |
| Keet desktop release | `4.21.0` |
| `@holepunchto/keet-core` | `4.21.5` |
| Keet ABI | `35` |
| Platform | Linux x86-64, glibc 2.34 or newer |
| Verified environment | Debian 12 with Node.js 22 |
| Official archive SHA-256 | `3737014d81be8536338ebfd38e301e912f5a328c2d5c1e28f978875b8b434cc7` |

The Integration Core fails closed when the tuple, platform, executable,
bundle, or native closure does not match. The numeric RPC map is private to
this exact release; do not substitute another release without a new verified
compatibility tuple.

## Prerequisites and extraction

Install `curl`, `ca-certificates`, `p7zip-full`, `libatomic1`, and Node.js 22.
The supplied executable is a glibc build; Alpine/musl is unsupported. Download
only from the official versioned location and verify the archive before
extraction:

```sh
set -eu

KEET_VERSION=4.21.0
KEET_ARCHIVE_SHA256=3737014d81be8536338ebfd38e301e912f5a328c2d5c1e28f978875b8b434cc7
KEET_PREPARE_DIR="$(mktemp -d)"
: "${DSH_HOME:?Set DSH_HOME to the home used by the target DSH profile}"
KEET_RUNTIME_DIR="$DSH_HOME/runtimes/keet/$KEET_VERSION-linux-x64"

curl -fsSL \
  "https://static.keet.io/downloads/$KEET_VERSION/Keet-x64.tar.gz" \
  -o "$KEET_PREPARE_DIR/keet.tar.gz"
echo "$KEET_ARCHIVE_SHA256  $KEET_PREPARE_DIR/keet.tar.gz" | sha256sum -c -

tar -xzf "$KEET_PREPARE_DIR/keet.tar.gz" -C "$KEET_PREPARE_DIR"
mkdir -p "$KEET_PREPARE_DIR/extracted"
7z x -y -o"$KEET_PREPARE_DIR/extracted" \
  "$KEET_PREPARE_DIR/Keet.AppImage" \
  resources/app/core-worker.bundle \
  resources/app/node_modules/bare-sidecar/prebuilds/linux-x64/bare

node -e '
  const fs = require("fs")
  const bundle = fs.readFileSync(process.argv[1])
  const newline = bundle.indexOf(10)
  const manifestSpan = Number(bundle.subarray(0, newline))
  const payloadStart = newline + manifestSpan
  const manifest = JSON.parse(bundle.subarray(newline + 1, payloadStart).toString().trimEnd())
  for (const addon of Object.values(manifest.addons)) process.stdout.write(`resources/app${addon}\n`)
' "$KEET_PREPARE_DIR/extracted/resources/app/core-worker.bundle" \
  > "$KEET_PREPARE_DIR/core-addons.txt"

xargs 7z x -y -o"$KEET_PREPARE_DIR/extracted" \
  "$KEET_PREPARE_DIR/Keet.AppImage" \
  < "$KEET_PREPARE_DIR/core-addons.txt"

mkdir -p "$KEET_RUNTIME_DIR"
mv "$KEET_PREPARE_DIR/extracted/resources/app/core-worker.bundle" "$KEET_RUNTIME_DIR/core-worker.bundle"
mv "$KEET_PREPARE_DIR/extracted/resources/app/node_modules/bare-sidecar/prebuilds/linux-x64/bare" "$KEET_RUNTIME_DIR/bare"
rm -rf "$KEET_PREPARE_DIR/extracted/resources/app/node_modules/bare-sidecar"
mv "$KEET_PREPARE_DIR/extracted/resources/app/node_modules" "$KEET_RUNTIME_DIR/node_modules"
chmod 0755 "$KEET_RUNTIME_DIR/bare"

echo "Runtime prepared at $KEET_RUNTIME_DIR"
```

The temporary preparation directory is intentionally retained on failure for
diagnosis. Remove it after inspecting a successful extraction. The resulting
directory contains `bare`, `core-worker.bundle`, and the 25 native addons
selected by the worker bundle manifest. Do not hand-maintain or copy that
closure into the source package.

Keep the runtime beneath the target DSH home. It contains proprietary assets
and must not be committed, packed, or published. There is no automatic
downloader or release workflow. The public npm-shaped plugin artifact contains
only source-derived integration code and discovers this fixed runtime path.

## Identity and onboarding

Choose the same DSH workspace in the plugin settings first. The Host and setup
CLI create `<workspace>/.dsh/dsh-keet/identity` automatically with private
directory permissions. One sidecar process owns it; concurrent use is rejected.
Run the human-only setup command from the root README:

```sh
printf '%s\n' "$INVITATION" | dsh-keet-setup join \
  --workspace /path/to/dsh-workspace
dsh-keet-setup profile \
  --workspace /path/to/dsh-workspace \
  --display-name "Keet Assistant"
```

The join command uses the official `getLinkInfo` and `startPairingRoom` flow,
waits within a bound, and prints one bounded success result without a room ID.
Invitation input is never accepted through argv or environment variables and
never appears in logs or DSH settings. Do not delete existing identity data on
a failed join. Restart DSH after joining so the next startup snapshot can
discover the new `Default` room. The human-only profile operation can also
prepare an avatar from a local PNG, JPEG, or WebP:

```sh
dsh-keet-setup profile \
  --workspace /path/to/dsh-workspace \
  --avatar /path/to/avatar.png
```

The input must be a readable image no larger than 8 MiB. Setup honors image
orientation, center-crops a square, and emits deterministic 64, 128, and 256
pixel PNG variants; each inline variant is bounded to 512 KiB. Official Keet
clients apply their normal circular avatar mask, so the input should remain a
square image rather than a pre-baked circle. Avatar-only updates preserve the
current non-empty display name, and profile setup does not expose avatar
removal.

Reserve the identity's globally searchable username separately from its
display name with the human-only setup command:

```sh
dsh-keet-setup username --workspace /path/to/dsh-workspace \
  --username agent_name1
```

After local syntax and availability checks, setup submits the native
registration or update and waits through the full 60-second lookup-convergence
budget. It prints the existing success JSON only after the exact username
resolves to this identity's Member ID. If the mutation was accepted but lookup
is still pending, it exits 1 with one bounded JSON line such as
`{"ok":false,"operation":"username","username":"agent_name1","status":"pending","submitted":true,"retryable":true}`.
Retry the exact same username; `submitted: false` identifies the idempotent
current-name verification path. Generic failures remain bounded and do not
print identity keys. No background polling or alternate-name selection is
created.

To authorize a direct message, list bounded pending sender identities and
accept one exact Member ID through the human-only setup commands. Acceptance
does not print a room ID; restart DSH afterward so the next canonical snapshot
discovers the accepted DM. Pending requests and unsupported room records remain
inactive.

## Managed DM image boundary

The bridge accepts live external PNG, JPEG, WebP, and GIF images in Managed
DMs. It streams every image in one message through the pinned
`readFileStream` RPC, then validates and saves the complete ordered batch with
DSH's durable attachment service before starting one Agent turn. The turn
contains the optional caption and durable image blocks; failed admission
creates no image session event or turn, sends at most one bounded failure
notice, and retains a non-triggering failure record for the next successful
turn in that DM. Startup snapshots, self-authored messages, Managed Groups,
historical reads, and `keet_read_recent_messages` never download image bytes.

The explicit `keet_send_image` tool is DM-only. It reads one image through the
bound DSH `ctx.fs` Active Conversation workspace filesystem, requires a path contained by that
workspace, detects the format from validated bytes, preserves the source for
the native `saveFileBlob`/`sendFile` lifecycle, and creates only a bounded
preview. An optional caption is sent as adjacent ordinary text. URLs, outside
workspace paths, unsupported or corrupt images, and oversized content fail
before delivery; a caption failure after image delivery is reported as a
bounded no-retry partial result. Images are never sent automatically after an
Agent turn.

These local fake-worker and Loader checks do not prove official-client image
interoperability. No official-runtime image smoke is run without explicit
authorization, so that compatibility and desktop/mobile rendering remain
unverified for this feature.

## Opt-in official checks

Normal checks use fakes and temporary directories. To run the disposable
single-sidecar Core smoke, provide fresh runtime inputs and opt in:

```sh
KEET_OFFICIAL_RUNTIME_SMOKE=1 \
KEET_EXECUTABLE_PATH=/path/to/runtime/bare \
KEET_BUNDLE_PATH=/path/to/runtime/core-worker.bundle \
bun run real-worker-smoke
```

The two-sidecar onboarding smoke additionally requires
`KEET_OFFICIAL_ONBOARDING_SMOKE=1`; it creates and removes only fresh
temporary identity directories and reports redacted counts. A skipped or fake
pass is not an official-client interoperability claim. The single-sidecar
real-worker smoke checks the official worker's Keet reply relation round-trip,
not desktop UI rendering.
