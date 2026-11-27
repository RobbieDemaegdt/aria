# Phase 0 spike

Probes of the Copilot SDK and its runtime, run by hand before ARIA was built (Phase 0 of [`PLAN.md`](../PLAN.md)). The
scripts are a record of how the findings in [`docs/spike-notes.md`](../docs/spike-notes.md) were made, and the
maintainers' check for an SDK bump ([`docs/sdk-upgrade-checklist.md`](../docs/sdk-upgrade-checklist.md)). They are not
part of the app and not a workspace: this folder has its own `package.json` and lockfile.

- **They need a real Copilot CLI.** Every script but `00-selftest.ts` starts the runtime the SDK bundles, as the user
  who is signed in to the Copilot CLI, and reads that CLI's configuration (MCP servers, plugins). Without a signed-in
  CLI they stop at the first call.
- **Some spend AI credits.** `02`, `05`, `06`, `07`, `08`, `11` and `12` make model calls, and so do `10` (unless run
  with `--no-model`), `13` (with `--with-message`) and `15`. `00`, `01`, `03`, `14` and `16` make none (`16` needs a
  sign-in in the browser). They default to the cheapest model (`--model` and `--effort` change it); `docs/spike-notes.md`
  says what the runs cost.
- **`00-selftest.ts` is offline.** It replays known cases through the spike's permission policy, the "settled" rule and
  the redaction, and needs no runtime.
- **Setup:** `cd spike && npm install`. Then `npm run typecheck` checks every script against the SDK's typings (from the
  repository root, `npx tsc --noEmit -p spike/tsconfig.json` does the same with the root install), and `npm run selftest`
  runs `00`.
- Checks that name a task tracker's MCP server take it from `SPIKE_TRACKER_SERVER` (`03`; the default, `Acme`, is made up)
  or `--resume-server` (`15`).
- Raw run logs go to `spike/.out/`, which git ignores: they can hold work data. Results: `docs/spike-notes.md`.
