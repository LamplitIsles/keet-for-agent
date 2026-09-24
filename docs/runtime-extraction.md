# Prepare the private Keet runtime

The public packages do not redistribute the official Keet executable, worker
bundle, or native addons. An operator must obtain the official Linux x64
release privately and prepare a local read-only runtime directory.

The admitted tuple is Keet 4.22.0, `@holepunchto/keet-core` 4.22.20, ABI 35,
Linux x86-64 with glibc 2.34 or newer. The official archive SHA-256 is
`36808af4f31ff65f7a766fbd5ead0cab5255a61c737941e8c166cece6d4ac6a9`.
Core fails closed when this tuple or the native closure differs.

Install `curl`, `ca-certificates`, `p7zip-full`, and `libatomic1`, then run:

```sh
set -eu

KEET_VERSION=4.22.0
KEET_ARCHIVE_SHA256=36808af4f31ff65f7a766fbd5ead0cab5255a61c737941e8c166cece6d4ac6a9
KEET_PREPARE_DIR="$(mktemp -d)"
: "${KEET_RUNTIME_ROOT:?Set KEET_RUNTIME_ROOT to the private runtime parent}"
KEET_RUNTIME_DIR="$KEET_RUNTIME_ROOT/$KEET_VERSION-linux-x64"

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

The resulting directory contains `bare`, `core-worker.bundle`, and the 25
native addons selected by the bundle manifest. Keep it outside this repository
and package artifacts. Remove the temporary preparation directory only after a
successful inspection.

Pass the resulting absolute directory as `KEET_MCP_RUNTIME_DIR` to `keet-mcpd`
or as the corresponding runtime option to another Core owner. Each process
must also have its own writable identity directory; never share an identity
concurrently.
