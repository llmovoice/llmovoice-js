# Contributing

Thank you for helping build llmovoice.js.

Before opening a change:

```bash
pnpm install
pnpm typecheck
pnpm test:coverage
pnpm build
```

Or run the same release gate used by CI:

```bash
make check
```

Public protocol changes should include:

- a concrete cross-provider use case;
- backwards-compatibility notes;
- an invariant or integration test;
- trace behavior for success and fallback paths.

Keep application-specific memory, billing, UI navigation, and tool policy outside the core runtime. Prefer adapters and extension directives to new hard-coded business concepts.

Security vulnerabilities should be reported privately as described in `SECURITY.md`, not opened as public issues.
