# Contributing

- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- **Code and comments** in English, no `any`, functions under 40 lines.
- **License header**: every source file starts with the MIT header. Add it with
  `node tools/license-headers.mjs --root . --license mit` (and verify with `--check`).
- **Boundaries**: public modules import only public modules. Run
  `node tools/check-boundaries.mjs --root . --stack-dirs nest,react --allowed tools/allowed.json`.
- **Tests**: add or update tests with your change; run `tools/ci-sandbox.sh anonymous` (and `anonymous-sqlite` when you touch the database engine, the wizard or `run.sh`, `anonymous-sqlite-desktop` when you touch the desktop option) before opening a pull request. The optional `databases` field of `module.json` lists the engines a module supports (absent = all).
- **Secrets**: never commit `.env*`, keys, certificates or database dumps.
- **Module README**: update the module's `README.md` in the same commit when its exposed behavior changes.
