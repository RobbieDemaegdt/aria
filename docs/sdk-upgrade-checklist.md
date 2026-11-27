# Copilot SDK Upgrade & Verification Checklist

**Scope:** `PLAN.md` (§4.2, §10 Phase 9, §12) and `docs/spike-notes.md` (Spikes 01–16)  
**Owner:** ARIA Maintainers  
**Isolation Boundary:** Only `packages/core/src/runtime/copilot.ts` and `packages/core/src/runtime/sdk-transcript.ts` may import `@github/copilot-sdk`.

---

## 1. Current Pinned Baseline

| Artifact | Pinned Version | Where Defined | Notes |
|---|---|---|---|
| `@github/copilot-sdk` | `1.0.22` (exact) | `packages/core/package.json`, `apps/desktop/package.json`, `spike/package.json` | Technical preview; **never** use `^` or `~` ranges. |
| `@github/copilot-sdk-win32-x64` | `1.0.98` | `package-lock.json` (`node_modules/@github/copilot-sdk-win32-x64`) | Bundled native CLI runtime (`copilot-runtime.exe`). |
| Wire protocol | JSON-RPC v3 | `@github/copilot-sdk` internal client handshake | Verified during `client.start()`. |

**When the CLI on PATH gets ahead of the SDK.** `findCopilotCli()` prefers `COPILOT_CLI_PATH`, then the Copilot CLI on PATH, which updates itself (winget). When that CLI speaks a wire protocol the pinned SDK doesn't, `client.start()` throws `SDK protocol version mismatch: …` and the CLI can't be used at all. `CopilotRuntime.start()` then starts the bundled runtime instead (`findBundledCopilotRuntime()`: `app.asar.unpacked` in the packaged app, `node_modules` in a checkout). The chat shows a `runtime_fallback` notice that names both programs and both protocols, and Doctor's "Copilot CLI binary" check turns to a warning. Every start tries the CLI on PATH first, so the fallback ends once the SDK is bumped to one that speaks the CLI's protocol. First seen on 2026-11-17: CLI 1.0.113 (protocol 4) against SDK 1.0.22 (protocol 3). The bundled 1.0.98 resumed the `aria-conductor` session that CLI 1.0.111 had last written, so the conversation carried on (if it can't, `openConductor` starts a fresh one with a `resume_failed` notice).

---

## 2. SDK Surface Inventory Used by ARIA

Before upgrading `@github/copilot-sdk`, verify that every class, method, RPC namespace, callback, hook, and event listed below still exists and preserves its semantics.

### 2.1 Client Lifecycle (`CopilotClient` & `RuntimeConnection`)
- `RuntimeConnection.forStdio({ path })` — launches a specific `copilot.exe` or unpacked `copilot-runtime.exe`.
- `new CopilotClient({ connection, env, logLevel: "warning", enableRemoteSessions: true, useLoggedInUser: true })`
- `client.start()`, `client.stop()`, `client.forceStop()`
- `client.listModels()`
- `client.getSessionMetadata(sessionId)` — used by `sessionExists(sessionId)` without opening the session.
- `client.deleteSession(sessionId)` — deletes helper and discarded worker sessions.
- `client.createSession(config)` and `client.resumeSession(sessionId, config)`.

### 2.2 Client RPC Endpoints (`client.rpc.*`)
- `client.rpc.sandbox.getHostSupport()` → `{ supported: boolean; reason?: string; capabilities: Array<{ name: "shell" | "network_filtering"; supported: boolean; reason?: string }> }`
- `client.rpc.models.list({})` → raw model catalog including `billing.tokenPrices.{inputPrice, outputPrice}`, `modelPickerCategory`, and `modelPickerPriceCategory`.
- `client.rpc.models.getBuiltInCatalog({})` → built-in model catalog IDs (used to surface catalog-only models such as Gemini).
- `client.rpc.mcp.config.list({})` and `client.rpc.plugins.list({})` → Copilot CLI MCP server and plugin directory discovery.

### 2.3 Session Methods (`CopilotSession`)
- `session.send({ prompt, mode?: "enqueue" | "immediate" })`
- `session.sendAndWait({ prompt }, timeoutMs)` — used by `runMcpAction`, `runTimekeeper`, and `runUtilitySummary`.
- `session.setModel(model, { reasoningEffort })`
- `session.setTools(tools)` — dynamically refreshes Conductor custom tools when profiles or policies change.
- `session.abort()`, `session.disconnect()`, `session.getEvents()`.

### 2.4 Session RPC Endpoints (`session.rpc.*`)
- `session.rpc.mode.set({ mode: "interactive" | "plan" | "autopilot" })`
- `session.rpc.model.setAllowedModels({ allowedModels: [model] })`
- `session.rpc.agent.list({ includeBuiltInAgents: true })`
- `session.rpc.tools.updateSubagentSettings({ subagents: { agents } })`
- `session.rpc.tools.initializeAndValidate()` and `session.rpc.tools.getCurrentMetadata()`
- `session.rpc.mcp.list()` and `session.rpc.mcp.listTools({ serverName })`
- `session.rpc.mcp.oauth.prepareLogin(...)`, `session.rpc.mcp.oauth.login(...)`, `session.rpc.mcp.oauth.cancelLogin(...)`
- `session.rpc.options.update({ sandboxConfig, sandboxConfigSource: "session_flag", shell })`
- `session.rpc.ui.handlePendingSessionLimitsExhausted({ requestId, response: { action: "add", additionalAiCredits } | { action: "cancel" } })`

### 2.5 Session Callbacks, Hooks & Events
- **Callbacks**: `onPermissionRequest`, `onUserInputRequest`, `onExitPlanModeRequest`, `onAutoModeSwitchRequest`, `onEvent`.
- **Hooks**: `hooks.onPreToolUse` (enforces exact-payload and single-call invariants in `runMcpAction` and tool-free execution in `runUtilitySummary`).
- **Events (`SessionEvent["type"]`)**:
  - `session.start`, `session.resume`, `session.idle`, `session.error`, `session.warning`, `session.info`, `session.model_change`, `session.task_complete`, `session.compaction_complete`, `session.mcp_server_status_changed`
  - `user.message`, `assistant.turn_start`, `assistant.intent`, `assistant.reasoning`, `assistant.message_delta`, `assistant.message`, `assistant.usage`
  - `tool.execution_start`, `tool.execution_complete`
  - `permission.requested`, `permission.completed`, `user_input.requested`, `exit_plan_mode.requested`, `exit_plan_mode.completed`, `subagent.started`, `subagent.completed`, `external_tool.requested`, `session_limits_exhausted.requested`.

---

## 3. 14 Empirical Breaking-Change Risk Areas (Phases 0–9)

When testing a candidate SDK upgrade, check each of these 14 areas explicitly:

1. **PowerShell `commands[]` vs `commandSegments[]` (`copilot.ts` `toAsk`)**:
   - On Windows PowerShell (`pwsh`), `request.commands[]` holds the unparsed full command line; `request.commandSegments[]` holds the parsed per-segment commands. Verify `request.commandSegments` is still populated for compound commands (`;`, `|`, `&&`).
2. **`allowedModels` silent model substitution**:
   - Calling `session.setModel()` to a model outside `allowedModels` silently substitutes another model unless `session.rpc.model.setAllowedModels({ allowedModels: [model] })` is called first.
3. **`mode` is a post-open RPC call, not a `SessionConfig` field**:
   - `session.rpc.mode.set({ mode })` must be called after `createSession` / `resumeSession`.
4. **Strict `availableTools` strips mode/handler built-ins**:
   - Passing `availableTools` removes `builtin:task_complete`, `builtin:ask_user`, and `builtin:exit_plan_mode` unless explicitly included in `availableTools`.
5. **Custom tools default to `defer: true`**:
   - `defineTool` must pass `defer: "never"`, or the model wastes a turn calling `tool_search_tool`.
6. **Built-in GitHub MCP server requires `githubMcpToolConfig: {}`**:
   - Without `githubMcpToolConfig: {}`, the runtime does not start the built-in GitHub MCP server.
7. **`ask_user` completion prefix (`sdk-transcript.ts` `askUserAnswer`)**:
   - `tool.execution_complete` for `ask_user` prefixes the user's answer with `"User selected: "` or `"User responded: "`. Verify `askUserAnswer()` still strips the exact prefix.
8. **MCP host lazy initialization on `signIn`**:
   - Calling `session.rpc.mcp.oauth.login` immediately after `createSession` fails with `"MCP host is not available on this session"` unless `session.rpc.mcp.list()` is polled until the server is no longer `"pending"`.
9. **Microsoft OAuth `client_session` length (`AADSTS901001`)**:
   - `helperId()` must stay between 20 and 50 characters (`44` chars: `aria-integrations-<24 hex>`).
10. **Cloud session `session.start` gate & `name` / `resumeSession` constraints**:
    - Cloud `createSession` rejects `name`, drops the first `send()` if sent before `session.start` (`producer === "copilot-agent"`), and `resumeSession` rejects `cloud`.
11. **Primary client `models.list` caching bug**:
    - Calling `listModels()` on the primary `CopilotClient` caches the server-side list and causes `createSession` to reject catalog-only models (such as Gemini); `CopilotRuntime.listModels()` must use a separate short-lived probe client.
12. **Sub-agent event filtering (`event.agentId`)**:
    - Root transcript and turn state ignore events where `event.agentId` is set, **except** `assistant.usage` (which counts sub-agent `totalNanoAiu` toward the task's budget).
13. **Sandbox `allowedHosts: []` semantics**:
    - Passing an empty `allowedHosts: []` with `allowOutbound: true` allows *all* hosts in the runtime; when `allowedHosts` is empty, ARIA must pass `{ allowOutbound: false }`.
14. **Packaged native binaries (`app.asar.unpacked`)**:
    - Verify that the upgraded `@github/copilot-sdk-win32-x64` binary layout (`prebuilds/win32-x64/copilot-runtime.exe`, `dpapi.node`, `msal-node-runtime.node`, `runtime.node`, `msalruntime.dll`, `koffi.node`) matches `apps/desktop/electron-builder.yml` `asarUnpack` globs and `findCopilotCli()`.

---

## 4. 5-Stage Verification Protocol

Run all 5 stages in order before merging any `@github/copilot-sdk` version bump:

### Stage 1 — Lockfile Sync & Typecheck
1. Update the exact version string in `packages/core/package.json`, `apps/desktop/package.json`, and `spike/package.json`.
2. Run `npm install` at the repository root and inside `spike/`.
3. Run `npm run typecheck` at the repository root and `cd spike && npm run typecheck`.

### Stage 2 — Offline Unit & Recorded Event-Stream Fixture Suite
1. Run `npm test` (including `packages/core/test/event-fixtures.test.ts` and `packages/core/test/runtime.test.ts`).
2. Verify all recorded `SessionEvent[]` fixtures (`spike15-events.json`, `autopilot-task-events.json`, `interactive-plan-events.json`, `crash-resume-events.json`, `cloud-budget-events.json`) replay cleanly through `CopilotRuntime` and `TranscriptMapper`.

### Stage 3 — Offline Spike Selftest
1. Run `cd spike && npm run selftest`.
2. Verify policy, command-parsing, and transcript selftests pass.

### Stage 4 — Live Runtime Smoke Probes
1. Run `cd spike && npx tsx src/01-inventory.ts` (verifies `listModels`, `sandbox.getHostSupport`, and MCP discovery).
2. Run `cd spike && npx tsx src/02-session-basics.ts` (verifies `createSession`, `resumeSession`, `setModel`, and `defineTool`).
3. Run `cd spike && npx tsx src/10-sandbox.ts --no-model` (verifies Windows AppContainer / sandbox enforcement).
4. Run `cd spike && npx tsx src/15-transcript.ts` (verifies `getEvents()` transcript parity and re-captures `spike15-events.json` if event schemas changed).
5. Run `npm run e2e:real` in `apps/desktop` (`phase1.spec.ts`, `phase2.spec.ts` and the `perf-` specs; they use the real runtime).

### Stage 5 — Packaged Build Verification
1. Run `npm --workspace @aria/desktop run pack`.
2. Launch `apps/desktop/dist/win-unpacked/ARIA.exe` and verify `findCopilotCli()` connects to the unpacked `copilot-runtime.exe`, loads models, and completes a turn.
