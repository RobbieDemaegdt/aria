# Contributing

Issues are welcome: a bug, a rough edge, an idea. Pull requests are welcome for bug fixes and small changes. For anything bigger,
open an issue first and talk it through, so nobody builds something that can't be merged. This is a personal project: there is
no promised response time. A security problem goes through [`SECURITY.md`](SECURITY.md), not an issue.

## Before you open a pull request

You need Windows 11, Git and Node 24 or newer. Run the checks in the order CI runs them (after `npm ci`):

```powershell
npm run lint        # ESLint, no warnings allowed
npm run typecheck
npm test            # unit tests of every package
```

If you changed the window or the main process, also run `npm run build` and then `npm run e2e`: the scripted UI specs, which
start the built app, use no model and spend no credits.

To run one scripted spec: `cd apps\desktop` and `npx playwright test ui-pr`. Not `npm run e2e -- ui-pr`, which runs every
`ui-` spec, because the script is already `playwright test ui-` and Playwright treats several filters as "any of these".

**The real-runtime specs spend your AI credits.** `npm run e2e:real` (the `phase1`, `phase2` and `perf-` specs) drives the real
Copilot runtime, so every run is billed to your Copilot account. CI doesn't run them, and a pull request doesn't need them. Run
them only when you mean to.

## What is unusual here

- **Tests never reach the network.** `packages/core/test/no-network.ts` runs before every test file and refuses outside
  connections, and GitHub CLI never runs. A test that needs GitHub or a model uses a fake.
- **The Copilot SDK is pinned** to an exact version (no `^` or `~`), it is a technical preview, and only
  `packages/core/src/runtime/copilot.ts` and `packages/core/src/runtime/sdk-transcript.ts` import it. Bump it with
  [`docs/sdk-upgrade-checklist.md`](docs/sdk-upgrade-checklist.md), not alone.
- **No secrets in the repository**, in code, tests, fixtures or logs. At run time ARIA keeps tokens in the operating system's
  keychain (Electron `safeStorage`); a test that needs a token uses an obviously fake one.
- **Decisions are written down.** [`PLAN.md`](PLAN.md) §0.3 is the decision log. When a change decides something other people
  will rely on, add a row with the next free number (one more than the last row's), and cite it from the code it explains.
- **A release needs its own note.** Add an entry for it to `RELEASES` in `packages/core/src/releases/releases.ts`, with the
  version and date of its tag: a version with no entry shows no What's New.
- **Task tracker configs** follow [`docs/trackers.md`](docs/trackers.md). A new example config goes in its format, and a change to
  the format changes that page: `packages/core/test/trackers-doc.test.ts` fails when the page and the schema disagree.
- **Links are tested.** `packages/core/test/docs-links.test.ts` fails when a Markdown link, an anchor, or a `docs/` or `PLAN.md`
  path written in the code points at something that isn't there.

## Pull request

Say what the change does and why, and which of the checks above you ran. Keep a pull request to one change.
