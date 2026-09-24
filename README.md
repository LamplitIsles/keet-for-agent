# Keet for Agent

Keet for Agent provides a persistent MCP gateway for Keet plus a private
Integration Core over the official Keet sidecar. The former DSH plugin has been
removed; agent integrations use MCP.

## Packages

- [`@lamplitisles/keet-mcp`](packages/keet-mcp) exposes destination discovery,
  history, text delivery, and arbitrary workspace-contained file delivery.
- `@lamplitisles/keet-integration-core` is the private typed sidecar boundary.
- [`@lamplitisles/impri-keet`](packages/impri-keet) is the separate private
  approval-channel adapter and owns a different Keet identity.

See the [MCP gateway guide](packages/keet-mcp/README.md) for configuration and
the [runtime guide](docs/runtime-extraction.md) for the operator-supplied pinned
Keet runtime.

## Development

Use Node.js with pnpm 11.22.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

Ordinary tests use fake workers and test-owned directories. Official-runtime
checks require explicit operator authorization and never establish desktop UI
rendering unless that exact behavior is observed in an official client.

## License

Apache-2.0. The public package notices are included in their package folders.
