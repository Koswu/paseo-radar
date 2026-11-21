## Contributing to Paseo Radar

Use Node.js 22 (latest patch), Python 3.12 and `npm ci` in a clean checkout. No external accounts should be needed for tests; use fixtures and example URLs instead of live service data.

- Keep React Native views in `client/`, daemon I/O in `server/`, and platform-independent contracts in `shared/`. Check interface changes on narrow and wide layouts and update both languages.
- Edit bundled providers and their specification in `scripts/collectors/`, then run `npm run sync-seeds`. Commit the generated TypeScript seeds alongside their sources.
- Before submitting, run `npm run check-seeds && npm run typecheck && npm test` and `python3 -m py_compile scripts/collectors/*.py`. For packaging changes inspect `npm pack --dry-run`.
- Use focused Conventional Commits. Describe what changed and how to verify it; keep credentials, private tickets and machine-specific paths out of examples.
