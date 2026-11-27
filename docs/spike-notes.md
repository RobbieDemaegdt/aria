# Phase 0 spike notes

Answers to the questions in [PLAN.md §11](../PLAN.md#11-things-to-verify-in-phase-0), found on 2026-10-16 with
`@github/copilot-sdk` **1.0.22** (bundled runtime **1.0.98**, protocol 3) on Windows 11, Node 24.19, PowerShell 7.
Every answer names the spike script that produced it (`spike/src/`; [`spike/README.md`](../spike/README.md) says how to
run them). Three scripts are not in the repository any more, because they needed a task tracker's real server or its
captured tool schemas: `04` (the exact-payload check against a mock of the tracker's time-log tools), `04a` (the dump of
the tracker's tool schemas that the mock was built from) and `09` (reads of the tracker and Work IQ). Their findings stay
as they were found, and an evidence cell says "(gone)" after their number. Raw run logs are in `spike/.out/` (gitignored:
they can contain work data).

## How to rerun

```powershell
cd spike
npm install
npm run typecheck                      # type-checks every script against the SDK typings
npm run selftest                       # offline: policy, "settled" rule and redaction against known cases
npx tsx src/01-inventory.ts            # no model calls
npx tsx src/03-scopes.ts               # no model calls
npx tsx src/02-session-basics.ts       # the rest make a few cheap model calls each
npx tsx src/05-parallel-worktrees.ts --workers 5
npx tsx src/06-requests.ts             # includes a 5-minute permission hold (--hold-seconds)
npx tsx src/07-resume.ts start; npx tsx src/07-resume.ts resume
npx tsx src/08-subagents.ts
npx tsx src/10-sandbox.ts              # Phase 3: worker sandbox (about 0.5 AI credits; --no-model for host support only; --aria-spec for ARIA's own spec)
npx tsx src/11-system-message.ts       # Phase 3: a changed system prompt on resume (two cheap calls)
npx tsx src/12-plan-sandbox.ts         # Phase 3: plan mode in a sandboxed worker (about 0.8 AI credits; --revise: 0.5)
npx tsx src/13-integrations.ts         # Part B checks: tool metadata, GitHub server, url per check (no model calls; step C needs --with-message)
npx tsx src/14-oauth-expiry.ts         # Part B checks: an expired sign-in, against a local mock OAuth server (no model calls)
npx tsx src/15-transcript.ts           # Part B checks: compaction, ask_user results, toolCallId, resume (about 0.27 AI credits)
npx tsx src/16-signin.ts --server workiq   # Part B checks: Sign in and where the token reaches (your sign-in in the browser)
```

Model for every spike session: the cheapest one (`claude-haiku-5.5`, effort `low`), unless `--model` / `--effort`
says otherwise.

**Safety, as run:** no real writes anywhere. Write paths went to a local mock MCP server (not kept in the repository),
with every real MCP server disabled and only the mock tool allowed. Worktree tests used a throwaway repo under
`C:\wt\_aria-spike` (removed afterwards). Real reads (a task tracker, Work IQ) used an exact read-only allowlist. Every
spike session was deleted from the session store at the end of its script.

## Summary

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | One client, 3–5 concurrent sessions? | **Yes, for small tasks** (3 runs of 5 parallel workers). 5 autopilot workers in parallel on one client: 13–23 s each. Runtime tree 84 MB idle, 380–601 MB peak with 5 busy workers (incl. their `pwsh`, `node`, `git`). CPU stayed low: ≤ 3 % of 20 cores in the run with per-process accounting (a lower bound). Heavy work (installs, builds, big test suites) wasn't measured. | 05 |
| 2 | `user_input.requested` payload, reply | `{requestId, question, choices?, allowFreeform, toolCallId}`. Handler gets `{question, choices, allowFreeform}`, returns `{answer, wasFreeform}`. | 06 `ask` |
| 3 | Permission pending for a long time? | **Yes**, at least 15 minutes on an awake PC with no timeout, error or warning; the call ran normally after approval. Hours, and sleep/wake in between, not tested. | 06 `hold` |
| 4 | Plan/autopilot from the SDK; answering plan approval | `session.rpc.mode.set({ mode: "plan" \| "autopilot" \| "interactive" })` after `createSession` (there is no `mode` in the session config). `onExitPlanModeRequest` gets `{summary, planContent, actions: ["autopilot","interactive","exit_only"], recommendedAction}`; returning `{approved: true, selectedAction}` continues the work in the same turn. | 06 `plan`, `autopilot` |
| 5 | Restrict the Conductor's built-in tools | By config: `availableTools` / `excludedTools` (e.g. `ToolSet().addBuiltIn(["view","glob","grep","web_fetch","skill"]).addMcp("*").addCustom("*")`). The tools are then not shown to the model at all. | 03 `C` |
| 6 | Per-task budget field | `sessionLimits: { maxAiCredits }` (experimental). **Minimum 30 AI credits**: lower values fail at `createSession`. Exhaustion raises the ephemeral `session_limits_exhausted.requested {requestId, maxAiCredits, usedAiCredits}`, answered with `session.rpc.ui.handlePendingSessionLimitsExhausted({ requestId, response: { action: "add"\|"set"\|"unset"\|"cancel", … } })`. Exhaustion itself was not triggered (it needs ≥ 30 credits of work). | 06 `budget`, typings |
| 7 | What a turn and a task cost | Billing is **token-based (AI credits)**. Billed premium requests (`totalPremiumRequestCost`) counted **one per user message**: `assistant.usage.cost` is 1 on every model call, but agent continuations weren't billed again, so never sum it. Measured on Haiku 5.5: Conductor-like turn with all 210 tools ≈ 0.27 AI credits; short-lived submit session 0.07–0.21; small worker task 0.25–0.49; Timekeeper gathering (a task tracker + Work IQ) 0.78. Per session: `session.rpc.usage.getMetrics()` → `totalNanoAiu`, `totalPremiumRequestCost`. | 02, 04 (gone), 05, 09 (gone) |
| 8 | Does `session.task_complete` fire reliably? | **In autopilot, yes**: 19/19 autopilot runs (4 in 06, 15 workers in 05) emitted it before the final `session.idle {mode:"autopilot"}`. It never fired in the interactive and plan-mode runs checked (3 in 06). But `success` is **not** trustworthy: it was `true` when the agent itself wrote "partially done, blocked". | 05, 06 |
| 9 | Windows: long paths, shell | A 337-character path inside a worktree under `C:\wt` was created and committed (`core.longpaths=true`). Commands run through the `powershell` tool, which starts **PowerShell 7** (`pwsh.exe`); permission requests say `shellType: "powershell"`. | 05 |
| 10 | Effort levels per model | `listModels()[].supportedReasoningEfforts`. Claude 5.x: `low…max`; GPT 6.x / 5.6: `none…max`; gpt-5.5: `none…xhigh`; gpt-5.3-codex: `low…xhigh`; mai-code-1.1-flash: `low…high`; kimi-k3: `low/high/max`. `defaultReasoningEffort` is never set. | 01 |
| 11 | `setModel(model, { reasoningEffort })` | Changes both; applies from the next turn; emits `session.model_change`. Effort alone: `session.rpc.model.setReasoningEffort()`. | 02 |
| 12 | Auto tier | Only exists for model `"auto"` (`setAutoTier` on any other model throws). Never select `auto` and it's off. Two other automatic switches exist: rate-limit → `onAutoModeSwitchRequest` (answer `"no"`), and `refusal_fallback` (no off switch found; detected via `session.model_change.cause`, accepted as detect + warning card: D15). | 02, typings, D15 |
| 13 | Pin sub-agent models | **Yes**, both ways: `customAgents[].model/reasoningEffort`, and `session.rpc.tools.updateSubagentSettings({ subagents: { agents: { explore: { model, effortLevel } } } })` for built-in agents. `subagent.started/completed` report the model and `configuredModelMatchesActual`. | 08 |
| 14 | `getEvents()` enough for a transcript? | **Yes.** It holds user/assistant messages, tool calls with arguments and results (including `ask_user` Q&A), and permission requests and decisions. Not persisted: usage, idle, deltas, `user_input.*`. After a crash, resume adds a failed result for the interrupted tool call plus `session.warning {warningType:"interrupted_tools"}`. | 07 |
| 15 | Cloud tasks: models and effort | **Not tested.** It would create a real cloud task in your GitHub account. Deferred to Phase 8 (agreed). | — |
| 16 | Hide ambient plugins/servers per session | `disabledMcpServers` (works for CLI servers **and** plugin-provided servers) plus `availableTools`/`excludedTools`. `COPILOT_PLUGIN_DIR_ONLY=true` had **no visible effect**. Plugin agents and personal skills only load with `enableConfigDiscovery: true`. | 03 |
| 17 | What an `mcp` permission request contains | `{kind:"mcp", serverName, toolName, toolTitle, args, readOnly, toolCallId}`. **`args` was present in every request**, for a local stdio server and for the real HTTP servers (a task tracker's, Work IQ). `toolName` is the runtime wire name `<server>-<tool>`. `readOnly` was `false` even for read tools (no MCP annotations). | 04 (gone), 09 (gone) |
| 18 | Work IQ: what the Timekeeper gets | Calendar: Graph events with `subject`, `start/end {dateTime, timeZone}` (to the second), `organizer`, `attendees`, `isOnlineMeeting`, `isCancelled`, `showAs`, `responseStatus`. Teams: chats with `topic`, `lastMessagePreview.createdDateTime` (UTC) and messages with `createdDateTime`, `from`, `body`. Mailbox settings: `timeZone`, `workingHours`. No tool for "calls I joined", and `responseStatus` is the reply to the invite, not attendance. | 09 (gone) |
| 19 | A tracker's create call: its shape | One **string** argument holding a JSON array of the entries to create, IDs as strings, times without an offset. Per-entry result and partial-failure shape: **not needed (D16)**; on a failed submit ARIA shows the server's full response. Auth: the runtime signs in to the tracker's server itself (OAuth; no token in the CLI config). | 04a (gone), D16 |
| 20 | CLI MCP servers in SDK sessions automatically? | **Yes.** All 7 servers from `~/.copilot/mcp-config.json` plus the Work IQ plugin's server load automatically, and the CLI's own disabled list is honored. Servers that need sign-in show `needs-auth`; `session.rpc.mcp.oauth.login({ serverName })` returns an `authorizationUrl` for the host to open. After one sign-in the token persisted across runtime restarts. | 02, 03, 09 (gone) |
| 21 | Short-lived session makes one exact call? | **Yes, in every run so far**: Haiku 5.5 (low) reproduced 1-, 5- and 20-row payloads **byte-exactly in 5/5 runs**; the permission handler compared the arguments and approved; the mock server received exactly the approved rows. A tampered payload was rejected with the exact differing row and nothing was sent. 3–8 s per call. Small sample on one model: the check compares the **parsed** rows (types and values, key order and whitespace don't matter), so it doesn't depend on byte-identity, and a deviation is blocked rather than sent. Repeat with the Conductor's model in Phase 3. | 04 (gone) |

## Details

### Environment and authentication (01)

- The runtime authenticates as the CLI's logged-in user (`getAuthStatus().authType === "user"`).
- When a dev shell runs inside the Copilot app, it inherits 17 variables (`COPILOT_*`, including a trampoline token
  and feature flags, plus `GH_TOKEN`/`GH_HOST`). With `GH_TOKEN` set, the runtime would authenticate from the
  environment instead. **ARIA should pass an explicit `env` to `CopilotClient`** (the spike strips those
  variables in `lib/runtime.ts`).
- `listModels()` returns 17 models plus `auto`. No Gemini models appear in SDK sessions, although the Copilot app
  offers them.
- SDK sessions share the CLI's session store (422 sessions already there) and show up in the user's session lists.
  ARIA should name its sessions (`name`, `clientName`) and clean up after itself.

### Cost (01, 02, 05; 04 and 09 are gone)

- `ModelInfo.billing.multiplier` is **empty for every model**. Pricing is in the raw `client.rpc.models.list()`:
  `billing.tokenPrices` (AI credits per 1M input/output/cache tokens, with a long-context tier) and
  `modelPickerPriceCategory` (`low` / `medium` / `high` / `very_high`). Cheapest: `claude-haiku-5.5` and `gpt-6-luna`
  (10/50); most expensive: `claude-fable-5.1` and `gpt-6-astra` (1000/5000).
- `assistant.usage` per model call: `model`, tokens, `cost` (1 on every call, also for agent continuations),
  `initiator` (`user`, `agent`, `sub-agent`) and `copilotUsage.tokenDetails` in nano-AI-credits. The billed
  `totalPremiumRequestCost` counted one per **user message** (2 messages / 4 calls → 2; 1 message / 3 calls → 1), so
  summing `cost` overcounts.
- `session.rpc.usage.getMetrics()`: `totalPremiumRequestCost`, `totalNanoAiu`, token totals. `session.shutdown`
  carries the same `accountingSnapshot`.
- Quota: `session.rpc.quota.get()` gives `unit: "ai_credits"`, `planTier: "business"`, entitlement 100,000,
  `resetDateEpochMs` (1 Nov). `client.rpc.account.getQuota()` returned an odd `resetDate` (today, 08:47 UTC).
  The account counter is shared with every other session of the user, so per-task cost must come from
  `getMetrics`/`assistant.usage`.
- The default system prompt plus 210 tool definitions is ~24k input tokens per call (cached after the first).
  Scoped sessions are far smaller (5–9k tokens for a one-tool session). Custom tools are **deferred** by default: the
  model first spent a call on `tool_search_tool`. Use `defer: "never"` for the Conductor's tools.

### Models and automatic switching (02, 08)

- `allowedModels` does **not** reject: `setModel()` to a model outside the list silently switched to an allowed model
  (`claude-haiku-5.5`). ARIA must validate profile models in its own code; `allowedModels` is only a backstop.
- `session.model_change` carries `newModel`, `previousModel`, `reasoningEffort`, `previousReasoningEffort`, `source`
  (`"sdk"`) and, for automatic switches, `cause` (`"rate_limit_auto_switch"` or `"refusal_fallback"`).
- `setAutoTier(null)` on a non-auto model: "Auto preference switching requires the selected model to be `auto`".
- Sub-agents: `subagent.started` reports `model`, `taskModelSource` (`custom_agent_definition` or
  `subagent_configuration`) and `modelSelectionSource`; `subagent.completed` reports `configuredModelMatchesActual`,
  `explicitModelOverride` and `modelOverrideReason`.

### Scopes, integrations and tool names (03)

- Baseline session: 210 tools. That's 18 built-ins (`powershell`, `read/stop/list_powershell`, `view`, `create`,
  `edit`, `web_fetch`, `skill`, `run_dynamic_workflow`, `dynamic_workflows_manage`, `sql`, `read/list/write_agent`,
  `grep`, `glob`, `task`) plus 192 MCP tools from the servers of that machine's CLI config. The built-in GitHub MCP
  server connects but contributed no tools. (Part B checks: without `githubMcpToolConfig` the runtime doesn't start it
  at all; with it, 19 or 102 tools.)
- Wire names are `<server>-<tool>`, with spaces in server names turned into hyphens (`Work-IQ-Calendar-ListEvents`).
  `namespacedName` is `<server>/<tool>`.
- `availableTools` and `excludedTools` match **exact names or a bare `*` only**: `mcp:Acme-get_*`
  and `mcp:Acme-*` matched nothing. ARIA must expand scopes into exact tool lists. It can get the list for free
  from `session.rpc.tools.initializeAndValidate()` + `getCurrentMetadata()` (no model call).
- `excludedTools: ["builtin:powershell"]` removes only `powershell`, not `read_/stop_/list_powershell`.
- The CLI config can have two entries for the same server, one with all its tools and one with an allowlist of some.
- Work IQ: in SDK sessions the Mail/Calendar/Teams servers and the `workiq` plugin start as `needs-auth`, because the
  Copilot app's sign-in isn't reused. Sign-in is per server and needs the browser once. Tokens then persist across
  restarts.

### Permissions (02, 05, 06; 04 and 09 are gone)

- Shell requests: `fullCommandText`, `shellType`, `intention`, `commands`, `commandSegments`, `possiblePaths`,
  `possibleUrls`, `hasWriteFileRedirection`, `resolvedWorkingDirectory`, `requestSandboxBypass`.
  - For PowerShell, `commands[]` held the **whole command line as one unparsed entry**. The parsed view is
    `commandSegments[]`: `identifier` is subcommand-qualified for git (`"git status"`) and `fullCommandText` is the
    segment.
  - `possiblePaths` was empty even for relative file arguments, so path confinement can't rely on it.
  - `shellType` is sent but missing from the 1.0.22 typings.
  - An allowlist must name exact operations (`git commit`, `npm test`), never a whole program: `git` alone allows
    pushes to any URL and `node` runs arbitrary code. Even then, arguments (`--prefix`, `--output`, `-C`), variables
    (`$env:…`) and script blocks (`ForEach-Object { … }` runs .NET code without a new segment) can reach outside the
    worktree, so rules must check arguments too. And an approved `npm test` runs whatever code the agent wrote:
    **an allowlist is not a sandbox**. These are policy-engine requirements for Phase 3, plus real isolation for
    unattended autopilot.
- Write requests carry `fileName`, `resolvedPath`, `diff` and `newFileContents`; read requests carry `path` and
  `resolvedPath`.
- A rejection shows up as `permission.completed {result:{kind:"denied-interactively-by-user", feedback}}`.
- `hooks.onPreToolUse` gets the wire name and the arguments, and `{permissionDecision:"deny"}` blocks the call before
  any permission request. `hooks.onPreMcpToolCall` also sees the arguments but **cannot block** (it can only edit
  `_meta`). D10's fallback therefore has to be `onPreToolUse`.
- **Never trust the model's reply about a write**: in one rejected case the model still answered "DONE". ARIA takes
  the outcome from `tool.execution_complete` (and the server's response), not from the text.

### Ending a task (05, 06)

- Autopilot: `session.task_complete {summary, success}` comes before `session.idle {mode:"autopilot"}`, and there is
  usually no final assistant message. The summary is the task's report.
- Interactive and plan modes end with `session.idle {mode:"interactive"}` and a final assistant message.
- The SDK's own `sendAndWait` ignores autopilot idles and sub-agent events, so it must not be used for autopilot
  tasks. ARIA needs its own "settled" rule (as in `spike/src/lib/wait.ts`).
- `task_complete.success` was `true` in runs where the agent wrote "Partially done; blocked on shell access" and had
  not committed. A Done card must be based on ARIA's own checks: tests run, a commit exists, the diff is non-empty.

### Persistence and crash recovery (07)

- After a hard kill of the host process, the runtime child exited by itself (no orphans). `listSessions()` showed the
  session with its summary and context.
- `resumeSession(id, config)` needs **all handlers again** (tools, permission, user input); they are not persisted.
- `session.resume` reports `selectedModel`, `reasoningEffort`, `context` (cwd, git root, branch, head commit),
  `eventCount` and `sessionWasActive`. About 160 ms later the runtime adds a failed `tool.execution_complete`
  ("interrupted before a result was recorded") and `session.warning {warningType:"interrupted_tools"}`.
- The resumed model knew the earlier answers and correctly said which call had been interrupted.

### Task tracker and Work IQ data

- A tracker's tools can differ from what the plan assumed. One tracker's date-range read took **ISO date strings**
  (`"2026-07-07"`) where the plan assumed epoch milliseconds, and its delete took the ids as one comma-separated string
  plus a `confirm` flag that defaults to false. Read each tool's schema; don't assume.
- A tracker's plain tools can return formatted **text**. For parsing, use a JSON variant of the tool when there is one.
- Work IQ results are Graph JSON inside `content`, sometimes after a one-line text prefix. Payloads are large
  (calendar view of 4 events ≈ 19k characters) and cost tokens.
- Teams has no "calls I joined" tool. Chat activity needs `ListChats` and then `ListChatMessages` per chat.
  `GetOnlineMeetingAttendanceReports` (not tested) may give real meeting attendance.

## Implications for the next phases

- **Budgets:** the 30-credit minimum on `sessionLimits` is far above what one small task costs (0.25–0.5 credits).
  ARIA needs its own per-task watcher (credits from `assistant.usage`, number of turns) that pauses a task with a
  budget card well before the runtime limit; `sessionLimits` stays as the hard backstop.
- **Conductor:** scope it from day one (exact `availableTools`, read-only built-ins, `defer: "never"` on its own
  tools). A full tool set costs ~24k tokens per call and an extra `tool_search_tool` call for deferred tools.
- **Policy engine (Phase 3):** match `commandSegments`, allowlist exact operations, never trust `readOnly` for MCP
  tools, decide MCP classes by name, and fail closed when a request lacks arguments.
- **Done card:** never "done" on the agent's word; show ARIA's own checks.
- **Timekeeper:** calendar blocks are planned time, not proof of attendance. Skip cancelled meetings and declined
  invites, and mark meetings without corroboration (attendance report, chat or git activity in that slot) as
  uncertain. Work IQ payloads are big, so trim them in code before the model sees them.

## Decisions taken after Phase 0 (2026-10-16)

- **D15:** the runtime's refusal fallback is accepted as **detect + warning card** (`session.model_change.cause`
  `refusal_fallback`, with Switch back). Pinning `allowedModels` to the profile's model stays a candidate
  improvement for Phase 2.
- **D16:** when a timesheet Submit fails, fully or partly, the card shows the server's **full response**. No test
  write is needed to learn the partial-failure shape.
- **#15** cloud tasks: deferred to Phase 8, agreed.

## Phase 3 probes

### Worker sandbox (10)

Six runs on 2026-10-16 (same SDK and runtime), 1.6 AI credits in total on Haiku 5.5 (low). The model ran a fixed list
of commands through its `powershell` tool in a throwaway repo under `C:\wt`. The permission handler approved exactly
those commands, so only the sandbox decided. Effects were checked on disk.

- **Host support:** `client.rpc.sandbox.getHostSupport()` → `supported: true` with every capability (`network`,
  `network_filtering`, `denied_paths`, `shell`, `filesystem_enumeration`). The Windows backend is ProcessContainer.
- **Turning it on:** `session.rpc.options.update({ sandboxConfig, sandboxConfigSource: "session_flag", shell })` after
  `createSession` and before the first message returned `{success: true}`. Every tool call then reported
  `tool.execution_complete.sandboxed: true`. `sandboxConfig` isn't in the public `createSession` config.
  `session.rpc.shell.exec` can't be used to test it: it ran nothing (not even an unsandboxed write) and emitted no
  events.
- **Files:** writes in the worktree work. Reads and writes anywhere else fail with "Access is denied", even without a
  `deniedPaths` entry: the base policy grants only the working directory, temp, system and tool folders. The built-in
  `create` tool is confined too ("Outside the sandbox's writable paths"). The runtime adds a note to failed commands
  telling the model not to work around the sandbox and to ask the user.
- **Temp:** the sandbox grants the runtime's own temp folder. With the default, a task could read and write the user's
  real `%TEMP%`. With the runtime started with `TEMP`/`TMP` in a folder of its own, the real one was denied and the
  own one worked.
- **Shell:** the sandboxed shell here is **Windows PowerShell 5.1**, not pwsh 7 as outside the sandbox (pwsh 7 is a
  Microsoft Store install on this PC). Its execution policy is Restricted, which refuses `npm.ps1`.
  - `shell.processFlags: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned"]` fixes that (RemoteSigned is
    pwsh 7's default).
  - `Get-ExecutionPolicy` itself can't load in the sandbox.
  - Every output starts with "Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem'
    provider failed." It's harmless.
- **git:** the sandboxed shell runs the runtime's bundled git (`%LOCALAPPDATA%\github-copilot-git-<version>`), which
  stops when it can't read its own `etc/gitconfig`. With that folder and `~/.gitconfig` read-only, `git status` and
  `git commit` work, with the user's identity.
- **The repo's `.git`:** with all of it read-write (runs 1–5), a task could write `.git/hooks` or `.git/config` (for
  example `core.fsmonitor`), which run code on the PC the next time anyone uses git in that repo. Grants nest, and
  the most specific path wins. Run 6 used read-write only for `objects`, the task's `worktrees/<name>`,
  `refs/heads/aria` and `logs/refs/heads/aria`, with the rest of `.git` read-only, as well as `commondir` and
  `gitdir` inside the worktree's folder and the worktree's own `.git` link. Results:
  - the commit worked;
  - writing a hook, `git config core.fsmonitor …`, rewriting `commondir`, the main `HEAD` or the `.git` link, and
    `git branch other` were all denied.

  The commit printed a harmless "Unable to create '…/packed-refs.lock': Permission denied". `git stash` (which writes
  `refs/stash` in the shared `.git`) would fail the same way.
- **Installs:** the user's npm cache and NuGet folders aren't writable in the sandbox. A shell init script
  (`shell.initScripts`; sourced before every command and must itself be readable in the sandbox) sets
  `npm_config_cache`, `NUGET_PACKAGES`, `NUGET_HTTP_CACHE_PATH` and `NUGET_PLUGINS_CACHE_PATH` to ARIA's folders
  and `NUGET_FALLBACK_PACKAGES` to the user's NuGet cache. With it:
  - `npm ci` worked;
  - `dotnet restore` used the user's cached Newtonsoft.Json from the fallback (without copying it) and downloaded
    Dapper into ARIA's cache, leaving the user's cache untouched.
- **Network:** `allowedHosts` works through the sandbox's proxy (`HTTPS_PROXY` is set):
  - registry.npmjs.org → 200; example.com → `CONNECT tunnel failed, response 403`; direct connections are blocked.
  - On Windows, host filtering also needs `allowLocalNetwork: true`, and loopback was then reachable through the proxy
    (127.0.0.1, not in `allowedHosts`, still got through). `blockedHosts: ["localhost", "127.0.0.1", "::1"]` closed
    that (403).
  - Other LAN addresses stay reachable: there are no address-range rules.
  - Windows PowerShell's `Invoke-WebRequest` ignores the proxy variables, so it can't reach even allowed hosts.
  - curl.exe (schannel) needs `--ssl-no-revoke`, because the revocation servers aren't allowed. npm and NuGet need
    neither.
- **Private feeds:** the user's NuGet config includes a private package feed. Blocked, it turned every
  restore that needed a download into error NU1301. `RestoreIgnoreFailedSources=true` as an environment variable
  (MSBuild reads those as properties) makes it warning NU1801. Packages only on that feed then come from the user's
  cache or fail as "not found".
- **Readable configuration:** `allowDevToolAccess` makes developer-tool configuration readable (for example
  `%APPDATA%\NuGet\NuGet.Config`). A registry publish token there could be used against the allowed registries. This
  PC has none (no `~/.npmrc`, no NuGet credentials or API keys).
- **Without the automatic dev-tool grants** (rerun after the Phase 3 review, `--aria-spec`, 0.67 AI credits):
  `allowDevToolAccess` also makes some user caches writable (Cargo's registry and git store, scratch caches), where a
  task could plant code for the user's next build. With it off and ARIA's own read-only grants instead (the folders
  on PATH and their install folders, toolchain variables, the user's NuGet cache, NuGet config and `.npmrc`), node,
  `npm ci`, `npm test`, `dotnet restore` and `dotnet build` (a package from the user's cache, another downloaded into
  ARIA's) and git commits all worked, and writing to the user's NuGet cache or the worktree's `config.worktree` was
  denied. The .NET CLI keeps its first-run state under ARIA's cache (`DOTNET_CLI_HOME`). npm warns about the
  `npm_config_store_dir` variable meant for pnpm (harmless).
- **Not tested:** pnpm and yarn in the sandbox, MCP servers (`sandboxMcpServers`, default true, would send remote MCP
  traffic through the same network rules), LSP servers.
- **Known limits:** a task can rewrite or delete objects in the repo's shared object store and move other `aria/`
  branches (harm to the repo's integrity, not code on the PC), and tasks share ARIA's caches and temp folder.

The configuration ARIA uses for workers (D20) is `--aria-spec`: the spec from `packages/core/src/policy/sandbox.ts`.

### Conductor prompt on resume (11)

Customize › Prompts edits ARIA's system prompt. `resumeSession` sends the session config's `systemMessage` again, and
the runtime applies it: a session created with "your codename is ALPHA" answered ALPHA, and after resuming with
"BRAVO" it answered BRAVO (two Haiku calls, 0.08 AI credits). So an edited prompt takes effect by reopening the same
conversation, which keeps its history. `session.rpc.options.update` has no system message field.

### Plan mode in a sandboxed worker (12)

Two Haiku sessions in plan mode, sandboxed to a throwaway worktree, with ARIA's worker allowlist (0.83 AI credits):

- **`exit_plan_mode` has to be in `availableTools`.** Without it, the worker wrote its plan, said so and went idle in
  plan mode: no review request, and ARIA would have counted the task as done. With it, the worker called
  `exit_plan_mode`; approving with `autopilot` switched the session to autopilot and it did the work in the same turn
  (created the file, checked it, `task_complete`).
- The plan goes to `plan.md` in the session's own folder (`session.workspacePath`, under `~\.copilot\session-state`),
  outside the worktree. The runtime writes it without a permission request and the sandbox doesn't stop it, so the
  "files outside the worktree" rule never sees it. The request carries the full plan (`planContent`) and the summary.
- **Revise** (`--revise`, 0.47 AI credits): answering the first plan with `{approved: false, feedback}` doesn't end
  the turn. The worker edited its plan to match the feedback and asked again (a second `exit_plan_mode`, still in plan
  mode, no idle between them). Approving that one switched to autopilot, and the file had both lines. So ARIA's
  Revise keeps the task running and waits for the next plan.
- ARIA's worker allowlist includes `exit_plan_mode` since then (`WORKER_BUILTINS`).

## Phase 3 Part B checks

The questions in [PLAN.md §10 Phase 9](../PLAN.md#phase-9-hardening-ongoing) ("Needs a check with the real runtime"),
checked on 2026-10-19 with the same SDK and runtime (1.0.22 / 1.0.98). Part B was built and tested on the scripted
runtime only; these are the real runtime's answers. Model calls: only spike 15, **0.267 AI credits** (two Haiku turns
and a compaction). The rest made none. No tool of a real server was called, and nothing was written anywhere.

| Question | Answer | Evidence |
|---|---|---|
| Inspector: `getEvents()` after a compaction | **Everything before it stays.** All 42 earlier events (messages, tool calls, permission requests and decisions) are still there, plus `session.compaction_start` and `session.compaction_complete`. The same after a restart and a resume (41 of 42: one of two `system.message` events is replaced on resume; the transcript doesn't use them). | 15 |
| Inspector: `PermissionRequest.toolCallId` | **Always there, and equal to the tool call's id** (`tool.execution_start`), for approved and refused requests alike; `permission.completed` carries the same id. 2 live requests in spike 15 (also after a restart), and all 117 recorded in Phase 0's runs (custom tool, MCP, shell, read, write). ARIA's mapper folds a refusal into its tool's row by it, as designed. | 15, Phase 0 logs |
| "Save as memory": the `ask_user` result | **Not the raw answer.** `result.content` is `"User selected: <choice>"` for a picked choice and `"User responded: <answer>"` for your own words (also when choices were offered), then your answer byte for byte (spaces and line breaks kept). **Bug in ARIA**, see below. | 15, Phase 0 logs |
| Integrations 1: `getCurrentMetadata()` | **Yes**: all 192 MCP tools have `mcpServerName`, `mcpToolName` and a description, and the wire name is always `<server with hyphens>-<mcpToolName>` (`namespacedName` is `<server>/<tool>`). | 13 A |
| Integrations 2: Sign in from a session of its own | **Works, but not right after `createSession`**: `mcp.oauth.login` then fails with "MCP host is not available on this session" (twice, with your 8 servers). Once the session's servers have loaded (0.4 s), it returns the sign-in page, and the sign-in for `workiq` (plugin-provided) finished: connected, 12 tools. **Bug in ARIA** (its Sign in calls login at once), see below. No server here is an owned installation, so `prepareLogin` wasn't tried. **In the app** (Customize › Integrations → Work IQ Mail → Sign in, real runtime, throwaway data folder): first it failed with that same message; with fix 2, Microsoft's page refused the request (AADSTS901001, bug 5); with fix 5 too, **Work IQ Mail connected, with its tools listed** (2026-10-19). | 16, the app |
| Integrations 3: the status event, and the token elsewhere | `session.mcp_server_status_changed` **arrives on the sign-in session** (… → pending → connected). The token reaches **a new session** and **a new runtime process** (connected, without a sign-in), but **not a session that was already open**: it stays `needs-auth` (checked 10 s later; no event). **Bug in ARIA**, see below. | 16 |
| Integrations 4: a resumed session's new `availableTools` / `disabledMcpServers` | **Yes.** Created with `[powershell, ask_user]` and every server disabled, resumed in a new runtime with `[view, ask_user, Acme-get_current_user]` and only the Acme server enabled (Acme stands for the tracker's real server): the resumed session had exactly the new tools, and that server connected. | 15 |
| Integrations 5: the built-in GitHub server | **Not there at all** in ARIA's sessions: without `githubMcpToolConfig` the runtime doesn't start it (no `mcp.list` entry, no events, no tools), also with a model set or in a GitHub clone's folder. With `githubMcpToolConfig: {}` it's `github-mcp-server` (`api.business.githubcopilot.com`) with **19 tools**, all reads; with `enableAllTools: true`, **102**. Names below. **Gap against the plan**, see below. | 13 B |
| Integrations 6: an expired token | **`needs-auth`, without an error**, never `failed`: an access token the server rejects, or one past its lifetime, with the refresh token refused. With a working refresh token the runtime refreshes on its own and stays connected. ARIA's Sign in (login without `forceReauth`) then gets a sign-in page again, and connects; a login without a page only happens when a refresh worked and the server is connected. | 14 (mock) |
| Integrations 7: `url` on every check | **Yes**, on every `mcp.list` check for every remote server, in every status seen: pending, connected, needs-auth, disabled and failed (21 checks of 8 servers from the start of a session, a failed session-only server, and the mock's needs-auth). | 13 A, D; 14 |

**How these were checked**

- **13** ([13-integrations.ts](../spike/src/13-integrations.ts), no model calls): ARIA's inventory session checked
  from its start, the GitHub server in eight configurations, and a failed session-only HTTP server at a closed loopback
  port. Its step C (a resume) needs `--with-message`, because a session is stored only from its first message: one
  that was only created can't be resumed ("Session not found"), not even after `session.log` and `sessions.save`.
  Spike 15 answered the resume question instead, at no extra cost.
- **14** ([14-oauth-expiry.ts](../spike/src/14-oauth-expiry.ts), no model calls, no real servers): an MCP server
  behind OAuth on 127.0.0.1 ([lib/mock-oauth-mcp.ts](../spike/src/lib/mock-oauth-mcp.ts)) with dynamic client
  registration, PKCE, an authorize endpoint that approves at once, and switches to reject access tokens and refuse
  refreshes. Tokens stay in memory, so nothing reaches the keychain. The runtime reconnects a server after
  `mcp.restartServer`; with an OAuth server that call itself fails with "requires authentication" while the runtime
  goes on refreshing in the background. A mock is not Microsoft's sign-in: the statuses are the runtime's, but how
  long Work IQ's refresh tokens last is not known.
- **15** ([15-transcript.ts](../spike/src/15-transcript.ts), 0.267 AI credits): three `ask_user` questions with
  made-up answers, two shell commands (one approved, one refused), a manual compaction (`session.rpc.history.compact`,
  13 messages removed), then a new runtime and a resume with other tools. ARIA's own transcript mapper, run over the
  resumed session's events, showed the answers as `User selected: Green` and `User responded: Teal`, and offered
  "Save as memory" on none of them; the refused command's permission row matched its tool row.
- **16** ([16-signin.ts](../spike/src/16-signin.ts), no model calls, one sign-in in the browser): ARIA's Sign in
  for `workiq`, then the server's status in a session that was already open, a new one, and one in a new runtime.

**The GitHub server's tools** (from 13 B; ARIA's classifier and D31 run over them):

- Default (`githubMcpToolConfig: {}`), 19, all reads: `actions_get`, `actions_list`, `get_commit`, `get_copilot_space`,
  `get_file_contents`, `get_job_logs`, `issue_read`, `list_branches`, `list_commits`, `list_copilot_spaces`,
  `list_issues`, `list_pull_requests`, `pull_request_read`, `search_code`, `search_issues`, `search_pull_requests`,
  `search_repositories`, `search_users`, `web_search`.
- All 102 (`enableAllTools`): ARIA's classifier calls 50 reads, 51 writes and 1 destructive (`delete_file`). **No
  write passes as a read.** D31 holds: every tool that merges, pushes, or writes branches, files or rulesets, forks,
  stars, and every Copilot hand-off (`assign_copilot_to_issue[_with_intent]`, `create_pull_request_with_copilot`,
  `request_copilot_review`) is a fixed Never for tasks (33 in all); the other 19 writes (issues, comments, reviews,
  pull requests' details, labels, gists, notifications, and `create_pull_request`) follow D30.
- Failing closed costs reads: GitHub names some reads `<thing>_read` or `<thing>_get`, which ARIA counts as
  writes. From the default set: `issue_read`, `pull_request_read`, `actions_get`, `actions_list` and `web_search`.
  From the rest: `projects_get`, `projects_list`, `repository_ruleset_read`, `custom_properties_read`, `ui_get`,
  `get_latest_release` and `get_release_by_tag` (a noun-verb past the object), `github_support_docs_search`,
  `semantic_issue_similarity_search`, `summarize_job_log_failures` and `summarize_run_log_failures`.

**Bugs and gaps found**, all fixed on 2026-10-19 with your OK (not committed yet; gap 6 is under "Attention on real
Windows" below):

1. **The `ask_user` answer kept the runtime's prefix.** The session view showed "User selected: Green" as a task's
   answer, and never offered "Save as memory" on an answered question, because `yourWordsIn` compares your recorded
   words with the whole result (`flow.ts`). The scripted runtime puts the raw answer in the entry, which is why the
   UI tests passed. *Fixed:* `sdk-transcript.ts` takes off exactly one leading `User selected: ` or
   `User responded: ` (the rest is your answer as you gave it). Test: ARIA's mapper over spike 15's recorded events
   (`packages/core/test/fixtures/spike15-events.json`).
2. **Sign in called `login` too early.** `runtime.signIn` created its session and called `mcp.oauth.login` at once,
   which fails with "MCP host is not available on this session"; Customize › Integrations' Sign in for Work IQ Mail
   failed with it in the app. A session's MCP host starts only when its servers are first asked for (`mcp.list` or
   `tools.initializeAndValidate`); a 2 s pause alone didn't help (`16-signin.ts --timing`). *Fixed:* Sign in asks
   `mcp.list` until the server is out of `pending`, then logs in, and counts the server's status changes only from the
   login on (during the load it only says where it was).
3. **ARIA's open conversation didn't get a new sign-in.** A session that's already open keeps the server
   `needs-auth`. ARIA reopened its conversation only when its tools changed, and a server that needs signing in
   still lists its tools from before (the runtime keeps them: Work IQ Mail listed 22 tools while `needs-auth`), so
   after a Sign in nothing changed and ARIA's Work IQ calls would keep failing until a restart. *Fixed:* after a
   Sign in connects a server ARIA's session uses, the conversation reopens before your next message, as for a
   changed scope. Tasks get the server when their session opens (only if you allowed it for tasks, D32).
4. **No GitHub tools at all.** ARIA's inventory, ARIA's session and the tasks' sessions passed no
   `githubMcpToolConfig`, so the GitHub server wasn't started, and tasks had none of GitHub's read tools, which §4.13
   and D33 expect. *Fixed (D35):* all three pass `githubMcpToolConfig: {}` (the default toolset, 19 tools; not
   `enableAllTools`), and GitHub's reads named `<thing>_read`, `_get` or `_list` (`issue_read`, `pull_request_read`,
   `actions_get`, `actions_list`, `projects_get`, `projects_list`, `repository_ruleset_read`,
   `custom_properties_read`) are whole-name reads, like `GetUserDateAndTimeZoneSettings`. Of the default 19, all but
   `web_search` now read; of the 102, 58. Test: the 102 real names and the reviewed reads
   (`packages/core/test/fixtures/github-tools.json`). Still writes, failing closed: `web_search`, `ui_get`,
   `get_latest_release` and `get_release_by_tag`, `github_support_docs_search`, `semantic_issue_similarity_search`,
   and the two `summarize_*` tools.
5. **Microsoft refused ARIA's sign-in page** (found when retrying the in-app Sign in with fix 2): "AADSTS901001: …
   The client_session value is invalid. It must be 20-50 characters and contain only alphanumeric characters,
   hyphens, underscores, periods, and tildes." The runtime puts the session's id in the page's `client_session`
   (`16-signin.ts --url-check`: equal for a 29- and a 56-character id), and ARIA's helper sessions were
   `aria-integrations-<uuid>`, 56 characters. Probe 16's 29-character id is why its own sign-in worked. *Fixed:*
   helper ids are `aria-integrations-` and 24 hex characters (44), with a test of the length and characters. Other
   sessions don't sign in, but `aria-conductor` (16 characters) would be too short for that page.

**Attention on real Windows** (2026-10-19, guided, with you at the PC): the built app on the scripted runtime (no
model calls) **without** the test hooks, so toasts were real Windows notifications and presence came from the real
window, `powerMonitor` and the idle poll. A Playwright driver started the tasks through the window's API on cue (never
by clicking the window), and recorded in the main process every notification shown, closed and clicked, the window's
focus, `powerMonitor`'s events and the system idle time. What you saw matched the log:

- **Toasts while away, and none while there (D25):** with ARIA behind another window, a question toasted at once
  ("… needs you"). A task that finished while ARIA was in front and focused didn't toast; one that finished half a
  second after you left it did. Windows shows a toast for about 6 s, then keeps it in the notification panel
  (`close` with reason `timedOut`).
- **Coalescing and `replaces` (D24):** the first Done toasted at once; the second, 2 s later, was held, and 30 s
  after the first ARIA closed the first (already in the notification panel) and showed "2 tasks finished". In the
  panel: the question and "2 tasks finished", not the closed one. So `close()` takes a timed-out toast out of the
  notification panel.
- **Clicking a toast** brought ARIA to the front, focused, at the question's card. (Clicking one inside the
  notification panel wasn't tried.)
- **Lock:** Windows reports `lock-screen` and `unlock-screen` (each event arrives twice; harmless). A question 10 s
  into the lock **toasted, but Windows dismissed it 50 ms later and didn't keep it** in the notification panel, and
  nothing showed on the lock screen. So something that needs you while the PC is locked only showed in ARIA (its
  card and the "needs you" badge) until you looked. **Gap 6**, fixed below.
- **Idle:** with ARIA in front and focused and no input, `getSystemIdleState(300)` said `idle` at 300 s; a question
  that came then toasted 8 s later, at ARIA's next 10-second check (presence going away is dated back to the start
  of the idle time). Back after about 30 minutes, the chat had a "while you were away" card.
- Sleep and the packaged build's switches were checked afterwards (below). The driver (`attention-windows.mjs`) was
  a one-off script outside the repo.

**Gap 6, fixed** (2026-10-19, with your OK; not committed): the presence controller reports the lock with presence
(also a lock while you were already away from ARIA), and while the screen is locked the attention engine toasts
nothing (Windows would drop it). When you unlock and are still away from ARIA, it toasts what still needs you (a
question, permission or plan not answered meanwhile, a failure not retried), as it does for idle time it dates back;
an unlock that brings you back to ARIA toasts nothing (its cards show it). A Done while locked is in its card and
the away card, and no combined Done toast shows while locked. Tests: the attention engine's and the presence
controller's unit tests, and `ui-away` (no toast while locked, the question's toast on an unlock that leaves you
away).

**Rechecked on real Windows** (2026-10-19, after the commit; the same guided driver):

- Locked with ARIA behind another window: the question that came while locked didn't toast; at the unlock it did,
  and stayed in the notification panel.
- Locked with ARIA in front: Windows reports `unlock-screen` **0.15–0.2 s before** it gives the window its focus
  back (seen three times), so in that moment ARIA still counted you as away and toasted. *Fixed:* after an unlock,
  what waited for it toasts only if you're still away 1.5 s later (`UNLOCK_SETTLE_MS`), with unit tests for the race
  and for a lock again within that time, and `ui-away` advancing its clock past it. Rechecked: no toast on an unlock
  back at ARIA (focus 155 ms after the unlock).

**A packaged build ignores the test switches** (2026-10-19): Electron's `app.isPackaged` is true when the executable
isn't named `electron.exe`, which is all ARIA's gating reads (`devBuild = !app.isPackaged`). The built app was
launched with `ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_E2E_HOOKS=1` and `ARIA_FAKE_CONDUCTOR_DELAY_MS=3000` through
`electron.exe` and through a copy of Electron renamed `ARIA.exe`. Through `electron.exe`: `isPackaged` false, title
"ARIA (fake runtime, test hooks)", the hooks there, the scripted runtime's models and servers. Through `ARIA.exe`:
`isPackaged` **true**, title **"ARIA"**, **no hooks**, the **real runtime** (your models and servers, among them
`github-mcp-server`: fix 4 on the real runtime). An installer build (Phase 9) packs the app differently (asar), but
the gating doesn't depend on that.

**Sleep** (2026-10-19): this PC has Modern Standby only (`powercfg /a`: S0 Low Power Idle; no S3), where Sleep locks
the screen first. Electron reported `lock-screen`, then `suspend` and `resume` (and the unlock), so presence goes away
with the lock either way. ARIA started directly through Electron **survived a 30 s sleep**: the same main, GPU and
renderer processes before and after, the window still there. (An app launched by Playwright closed after a sleep:
Playwright's DevTools connection drops in standby and it then shuts the app it launched. The test setup, not ARIA.)

**The Phase 1 and Phase 2 E2E against the real runtime** (after fixes 1–5, before gap 6's): `phase1` (chat about
your repos, restart, the same conversation, change the model) and `phase2` (a task in a throwaway repo: a committed
branch and a Done card with a diff, chatting meanwhile, every step readable) **passed**. `phase1`'s MCP test was
skipped, as it is without `ARIA_E2E_MCP=1` (it calls your real task tracker's read tools). The account's AI-credit counter
showed 72,200 used before and after, so its cost isn't known from it (Phase 0's costs suggest about one AI credit).

**Smaller observations**

- `mcp.list` gives `source` only for plugin servers (`plugin`); servers from your CLI config have none (`discover`
  says `user`), so Customize › Integrations shows no source for them.
- A server that needs signing in lists the tools it had before (from the runtime's cache), so "a server that needs
  signing in lists no tools" (PLAN.md, Part B known limits) holds only for one that never connected.
- `workiq` was `connected` in one check and `needs-auth` in a check 90 s later, with nothing in between. Seen once;
  not explained.

## Open items (later phases)

None of these blocks Phase 1 (shell, Conductor chat, repo registry, model picker).

1. **A start time without an offset** (Phase 5): whether a tracker reads it as local time. This can be checked without
   writing, by comparing an existing entry's raw start time with the time the tracker's formatted read shows for it.
2. **#6 exhaustion flow**: needs a session that really spends 30 AI credits. Can be checked during Phase 2 with a
   real worker task.
3. **#15 cloud tasks**: deferred to Phase 8.
4. **#3 for hours**: 15 minutes verified. A longer hold can run in the background at any time
   (`06-requests.ts --only hold --hold-seconds 7200`).
5. ~~**Work IQ Mail** (and the `workiq` plugin server) are still signed out in the SDK runtime.~~ Both signed in on
   2026-10-19 (Part B checks: `workiq` through spike 16, Work IQ Mail through ARIA's own Sign in).
