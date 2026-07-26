# Contributing to File Access Manager

Thanks for taking the time to contribute.

## Getting started

```bash
git clone https://github.com/marospekarik/paperclip-hermes-file-access-manager.git
cd paperclip-hermes-file-access-manager
bun install
bun run build
bun run typecheck
bun run test
```

The integration suite needs Docker:

```bash
bun run test:integration
```

## How to contribute

1. **Fork the repo** and create a branch for your change.
2. **Add tests** for bug fixes and new behavior. The real-Docker integration
   suite in `tests/integration/` is the source of truth for permission
   enforcement.
3. **Run the full check suite** before opening a PR:
   `bun run build && bun run typecheck && bun run test`
4. **Open a pull request** with a clear description of the problem and the
   fix. Link any relevant issue.

## Scope

This plugin translates a visual permission model into Docker bind mounts. We
keep the permission logic in `src/model.ts`, the Paperclip bridge in
`src/worker.ts`, and runtime application in `src/apply.ts`. If you are unsure
where a change belongs, open an issue first and we'll point you in the right
direction.

## Code of conduct

Be respectful, stay constructive, and assume good intent. Security-related
issues should be disclosed privately via a GitHub security advisory rather
than a public issue.
