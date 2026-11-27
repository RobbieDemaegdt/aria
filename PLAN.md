# ARIA — a single-chat assistant on top of Copilot CLI

> Status: plan v15 · 2026-11-27 · built on the GitHub Copilot SDK (technical preview).
> v15 starts Phase 10: sandbox blocks become actionable permission cards with one-time,
> task/session or persistent **narrow** grants instead of requiring users to turn the sandbox off.
> v2 added a sessions sidebar for looking inside background sessions, and full control over the
> model and reasoning effort used by every part of ARIA.
> v3 structures that sidebar like the Copilot app's: per project (repo), with its sessions
> underneath.
> v4 adds integrations (plugins, MCP servers, skills) with per-session scopes, and work tracking
> across Outlook, Teams and GitHub to register your time through your task tracker's MCP server.
> v5 makes MCP native to ARIA (its own config, imported from Copilot CLI, plus a built-in MCP
> client for exact calls), adds rules for all of the task tracker's tools, and bases time registration on
> the tracker's tasks. Work IQ is confirmed for Outlook and Teams.
> v6: the first draft has no native MCP. It uses the MCP servers and plugins configured in
> Copilot CLI, enforces scopes when a tool is called, and checks every approved write against its
> exact payload. Native MCP moves to Phase 7.
> v7: self-contained handover. Adds a decisions log, ground rules for the
> implementing agent, and appendices with everything researched while planning.
> v8: Phase 0 done (answers in `docs/spike-notes.md`). Applied here: billing is token-based (AI credits),
> per-session tool scoping already works in the first draft, mode is set after `createSession`,
> `task_complete` only fires in autopilot and its `success` flag isn't trustworthy, the task tracker's date-range
> tool takes ISO dates, and Work IQ needs a one-time sign-in in the SDK runtime. New decisions D15 and D16.
> v9: Phase 1 done (the one chat). SQLite through the built-in `node:sqlite` instead of better-sqlite3 + Drizzle
> (§6), build and run commands in §0.6, and §7/§8 updated to what was built.
> v10: Phase 2 done (background tasks). New decisions D17 (worker questions on a card) and D18 (lockfile installs);
> `availableTools` must name `task_complete` and `ask_user` (§4.4).
> v11: Phase 3 Part A done (ARIA in the loop: waiting items with short ids, the policy engine, the sandbox, grants,
> the digest, proposals, Customize › Prompts and Permissions), with decisions D19–D21. Part B is on hold at your
> request; what's done and what's open is summed up at the top of §10.
> v12: Phase 3 done. Part B (flow tuning) built its four items: the Conductor inspector, attention (priorities, Focus
> mode, coalesced toasts, the away card), "Always allow this" and "Save as memory", and the first draft of
> Customize › Integrations, with decisions D22–D34. It's committed locally as "Phase 3 Part B: flow tuning"; how it
> was checked is under Phase 3, its known limits are in one list there, the test switches
> and the five scripted UI specs are in §0.6, and what still needs a check with the real runtime is under Phase 9.
> v13: Phase 4 done (GitHub awareness), with decisions D36–D53:
> - GitHub's client and its watchers (runs, PRs, default-branch health, the inbox);
> - My work and the watch rows;
> - `open_pr` with its confirm card, ARIA's own push and the PR;
> - CI and PR cards with Fix it and Address comments.
>
> Nothing ran against the real GitHub: tests use a local mock, and pushes go to local bare repositories. What that
> leaves to check is a list under Phase 9. How Phase 4 was checked, and its known limits, are under Phase 4. The nine
> scripted specs and the test-only variables are in §0.6. Phase 4 is
> committed locally as "Phase 4: GitHub awareness".
> v14: Splits Phases 5–8 into smaller sub-phases (5A–5D, 6A–6D, 7A–7B, 8A–8B), each with its own scope and done-when,
> and moves automated timesheet reminders to Phase 6B alongside the scheduler and morning brief. Phase 5A done
> (approved writes, exact-payload check, Action-request cards, and unlocking ARIA `Ask` write rules). Phase 5B done
> (activity collectors for ARIA tasks, GitHub and local git, explicit tracker task linking, and mapping rules). Phase
> 5C done (Timekeeper model slot and session, plain-code time-zone/rounding/overlap/duplicate/gap checks, Timesheet
> draft card, inline & conversational edits, and "Always map X to task Y?" learning offers). Phase 5D done (Time view
> in the sidebar with Monday–Sunday week strip, day entries, activities, and mapping rules editor; Submit, Update and
> ID-confirmed Delete through the task tracker's MCP tools). Phase
> 6A done (`remember` and `forget` tools with prompt-injection grounding guards, global and project memory in ARIA's
> own system prompt, `session_transcripts` SQLite index, and the sidebar **Search** view across session transcripts,
> tasks, projects, and memories). Phase 6B done (`croner` scheduler, `routines` and `reminders` tables, `remind_me` and
> `schedule_routine` tools with prompt-injection and automated-turn guards, **Reminder** card, **Utility model** slot in
> Customize › Models, **Morning brief** and **Friday week time overview** cards, and the sidebar **Automations** view).
> Phase 6C done (global `Ctrl+Space` Spotlight-style **Quick prompt bar**, **Start at login**, deterministic `/status`,
> `/tasks`, `/watch`, `/focus`, `/pause-all` and `/budget` slash commands, and **"Rerun with…"** with a side-by-side
> **Compare runs** bar). Phase 6D done (opt-in spoken announcements via Windows `speechSynthesis` or cloud TTS, and
> push-to-talk voice transcription in the chat composer and Quick prompt bar via local `whisper.cpp` or cloud STT).

---

## 0. Read this first (handover)

This plan was written in a planning conversation with the user on 2026-10-16. The agent that
implements it has **no access to that conversation**. Everything relevant from it is in this file:
the decisions in §0.3, the research in Appendices A–D, and the open questions in §11.

Throughout the plan, **"you" means the user**: the person ARIA works for. The agent building
ARIA is called "the implementing agent".

### 0.1 What the user asked for

> A full assistant based on the Copilot CLI: one single chat to
> control everything, which handles work in the background and tells the user when sessions are
> done, waiting for input, or when GitHub Actions runs complete. The feel of the GitHub Copilot app,
> but acting as an assistant, so the user doesn't have to monitor and switch between sessions.

Later in the conversation the user added:

- call the app **ARIA**, a short name that is easy to say and to remember (the app started under another working name)
- still have a **sidebar like the Copilot app's**, structured per repo, to look inside a
  session's conversation and improve the flow
- **full control over models and reasoning effort** for every part, instead of automatic picks
- ARIA should **track work across Outlook, Teams, GitHub and a task tracker**, so the user can
  **register their time through the task tracker's MCP server**
- for the first draft, **no native MCP**: use the MCP servers configured in Copilot CLI

### 0.3 Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | Name: **ARIA** | The user's choice for the public release; short, and easy to say and to remember. |
| D2 | **One chat** as the main surface; background work reports back as cards | The core idea: an assistant, not a session manager. |
| D3 | **Sidebar like the Copilot app's**: New session, ARIA, My work, Automations, Time, Customize, Search, then **Projects** (one per repo) with their sessions underneath (§5.2) | The user wants to look inside sessions and improve the flow, without having to. |
| D4 | **Model and reasoning effort chosen by the user** for each part: Conductor, worker profiles, Timekeeper, utility. Profile policy defaults to "Me". Automatic model switching off (§4.12). | The user wants full control over models and effort. |
| D5 | Engine: **GitHub Copilot SDK (Node, `@github/copilot-sdk`)**. Not ACP, not wrapping the terminal. | Official; bundles the CLI; gives typed events, permission hooks and custom tools. ACP stays a later option (§13). |
| D6 | Desktop shell: **Electron + React + TypeScript** | Electron's main process is Node, so the SDK runs directly (Tauri would need a Node sidecar). |
| D7 | Plain code for events, watchers, routing and arithmetic; the model only for understanding, delegating, mapping and writing | Cost, reliability, predictability. |
| D8 | **First draft: no native MCP.** Use the MCP servers and plugins configured in Copilot CLI. Native MCP comes in Phase 7. | The user's choice, to keep the first draft simple. |
| D9 | CLI MCP servers reach sessions **automatically** (CLI stays the only place to configure). Fallback only if that fails: read the CLI's MCP config file and pass it through `mcpServers`. | Agreed with the user. **Confirmed in Phase 0**: no fallback needed. |
| D10 | Scopes and the **exact-payload check** for approved writes live in the **permission handler**. Fallback only if permission requests lack full arguments: an SDK pre-tool hook. | Agreed with the user. One mechanism for both. **Confirmed in Phase 0**: `mcp` permission requests carry the full arguments. |
| D11 | Outlook and Teams through **Work IQ** (Copilot CLI plugin), not a Graph app registration | License and access confirmed. |
| D12 | Time registration through the **task tracker's MCP server**: every time log hangs on a tracker **task** (task, start, end, comment, and a project and customer when the tracker asks for them). Submit only after the user's click. The tracker's raw request tools that write (a generic POST, PATCH or DELETE) are never allowed. | Matches the tracker's API; keeps the user in control of what's registered. |
| D13 | No tracking of active windows or apps on the PC | Too invasive for too little gain. |
| D14 | Every task in its own **git worktree** under a short root (`C:\wt`) with `core.longpaths` on | Isolation and parallel work; Windows path limits. |
| D15 | The runtime's **refusal fallback** (switching to another model when a model refuses a request) is accepted as **detect + warning card**: ARIA shows the switch through `session.model_change.cause` and offers to switch back. | Phase 0 found no setting to turn it off; the user accepted this limitation of D4 (2026-10-16). Pinning `allowedModels` to the profile's model stays a candidate improvement for Phase 2. |
| D16 | When a timesheet **Submit** fails, fully or partly, the result card shows the server's **full response**. ARIA doesn't model the partial-failure shape. | The user's choice (2026-10-16); avoids a real test write just to learn the error format. |
| D17 | A worker's **question** (`ask_user`) shows in Phase 2 as its task's Question card in the chat (§5.4, moved forward from Phase 3), with the offered choices and a reply box. Its task card says **Needs you**, its session view can answer it too, and the task waits for the answer. Permission and plan cards stay in Phase 3. | The user's choice (2026-10-16): being told when a session waits for input is part of the original request (§0.1). |
| D18 | Workers may install dependencies **from the lockfile only**, inside their worktree, without asking: `npm ci`, `npm install` with no package names, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `dotnet restore`. Adding packages still needs approval. | The user's choice (2026-10-16): a fresh worktree has no dependencies, so tests can't run otherwise. It reaches the network and runs install scripts, which is no worse than an allowed `npm test`. |
| D19 | **Action-request cards** (writes to mail, Teams, meetings and the task tracker's tasks, carried out by a short-lived session with the exact-payload check) move from Phase 3 to **Phase 5A**, which builds the same short-lived session for Submit. Until then the Conductor stays read-only. Built in Phase 5A (2026-10-22). | The user's choice (2026-10-16): Phase 3 is about the attention loop, and real writes can only be tested with a per-action OK (§0.4). |
| D20 | Workers run in the runtime's **sandbox** when the host supports it (`client.rpc.sandbox.getHostSupport()`), set with `session.rpc.options.update({ sandboxConfig, shell })` each time a worker session opens. Read-write: the worktree, ARIA's own package caches and temp folder (`<worktree root>\.aria`), and only the parts of the repo's `.git` a commit needs (`objects`, the task's `worktrees/<name>`, `refs/heads/aria` and its reflogs). Read-only: the rest of `.git`, the task's own worktree config (`config.worktree`), the worktree's `.git` link, `~/.gitconfig`, the runtime's bundled git, the toolchains on PATH and the user's NuGet cache, NuGet config and `.npmrc`. The runtime's automatic dev-tool grants are off: they'd also make some of the user's caches writable (Cargo's among them). Network: package registries only (editable; an empty list means no network), loopback blocked. Sandbox bypass requests are never implicit: Phase 10 routes each blocked operation through ARIA's exact, scoped approval handler (D79). A shell init script points npm, pnpm, yarn, NuGet, the .NET CLI, pip, Cargo and Go at ARIA's caches (the user's NuGet cache as a read-only fallback). ARIA's own git calls on a worktree run with fsmonitor and text conversion off. Where the host can't sandbox, workers stay policy-only and say **not sandboxed**. | The user's choice (2026-10-16): enable it if git and lockfile installs work in it, which the probe showed (spike 10, [spike notes](docs/spike-notes.md#worker-sandbox-10)). An allowlist isn't a sandbox (§4.8). Hooks and config in `.git` would run code on the PC the next time anyone uses git in that repo (worktree config too: a `core.fsmonitor` there runs when git looks at the worktree), and the `.git` link, `commondir` and `gitdir` would point git at another folder, so they stay read-only. The user's own caches stay read-only because a task that could write them could plant code in the user's own builds. |
| D21 | **Approve for this task** on a permission card covers the **same operation on the same target** for the rest of that task, not the whole tool: for a command, the same command text, character for character, run in the same folder; for a web address, any page on that host; for files, that folder. ARIA keeps the grant, shows it in the session view and lets you revoke it; it isn't the runtime's approve-for-session. | The user's choice (2026-10-16). Narrowed for commands after the Phase 3 review: an option's value can't be told from another argument without knowing each program's options, so `-Path a -Exclude b` and `-Exclude a -Path b` (which delete different things) must not match; what looks like a path can be code (`node -e "…//../…"`); `node` isn't a `.\node.cmd` the task wrote; `'$(x)'` is text where `"$(x)"` runs x; a line break can end a comment where a space doesn't; and a command approved in the worktree must not be approved in another folder. |
| D22 | In Customize › Integrations, an **ARIA (Conductor) write tool** can only be set to **Ask or Never**, never Auto. Ask means "needs an action card" (until Phase 5A it worked like Never; since Phase 5A ARIA discovers Ask tools with `list_action_tools` and proposes them with `request_action`). | The user's choice (2026-10-17). The Conductor stays read-only until the action cards (D19); a write needs the exact-payload check and your click. |
| D23 | **"Save as memory"** facts go into **task briefs only**: a project's facts into that project's briefs, global facts into every brief. ARIA's own prompt gets memory in Phase 6, with `remember` / `forget`. | The user's choice (2026-10-17). Changing ARIA's prompt reopens the conversation (spike 11), so that waits for the memory tools. |
| D24 | **Coalescing** groups **only the toasts** ("3 tasks finished"). Each Done card in the chat keeps its own buttons. | The user's choice (2026-10-17). One grouped card would hide each task's View diff, Continue and Discard. |
| D25 | While ARIA's window is in front and focused (and you're not idle), **nothing toasts**, at any priority: the card and the "needs you" badge show it. Blocking events toast whenever you're away, also in Focus mode; milestones only when you're away and Focus mode is off. | The user's choice (2026-10-18). It's how toasts already worked (§2: "toasts appear when the window isn't focused"); a toast for a card you're looking at is noise. |
| D26 | **Save checks for Auto rules**, the same in Customize › Permissions and in the "Always allow this" form: an Auto rule that isn't **exact** (only that command: its arguments in that order, letter case included) is allowed only for commands that test, build, lint, format or type-check (an allowlist of program and first words: `npm test`, `npm run build`, `dotnet test`, `cargo clippy`, `eslint`, …); anything else (`git`, `node`, `npm <x>`, `npm run deploy`, and `make`, where each further word is another goal) has to be exact, and a word in angle brackets counts as broad. An Auto rule for a destructive command (D28), or one that names its program by its folder, can't be saved. A stored rule that didn't change (same id, match, effect, exactness and scope) is kept and shown with its warnings, so an old rule never blocks an unrelated save. | The user's choice (2026-10-18). A broad Auto rule lets a whole program run on its own (`git` pushes anywhere, `node` runs anything); one check everywhere means neither page can be used to get around the other. |
| D27 | Rules get a **scope**: all tasks (as before, and for every rule saved before) or **sandboxed tasks only**. "Always allow this" from a sandboxed task saves a sandboxed-only rule, from an unsandboxed one a rule for all tasks; the engine takes the scope from the offer it stored when it decided the command, not from the window. | The user's choice (2026-10-18). A command that's fine in the sandbox (files and network confined) isn't necessarily fine with your own access to the PC. |
| D28 | **Destructive commands are a fixed Ask**, decided by one function (`policy/destructive.ts`): `Remove-Item` and its aliases with `-Recurse` (by any prefix), `-rf` or `/s` (so also cmd's `del /s`, `rd /s`); `git reset --hard`; `git clean` without `-n` / `--dry-run`; force pushes (`--force`, `-f`, `--force-with-lease`, `--force-if-includes`, a `+refspec`); `git branch -D` (and `--delete --force`). Added after the first review: `git checkout -f`, `git switch -f` / `--discard-changes`, `git stash clear` / `drop`, `git branch -M`, a `Remove-Item` in the same line as a recursive `Get-ChildItem` (`gci -r | rm`), `rimraf` (also through `npx`, `npm exec`, `pnpm dlx`, `yarn`), and `robocopy` with `/MIR` or `/PURGE`. After the fixed refusals and before your rules, such a command asks, sandboxed or not, whatever an Auto rule says (a Never rule still refuses). git aliases and the command line a shell is given (`cmd /c`, `pwsh -Command`, `bash -c`) are read too. No "Always allow this" for them. | The user's choice (2026-10-18). §4.8 always said these ask every time; with Auto rules and the sandbox (where a command without a rule runs on its own) that wasn't true anymore. |
| D29 | **No per-task grants for destructive commands**: their card offers Approve once and Reject, not "Approve for this task"; every run asks, and an earlier "Approve for this task" grant (D21) never covers one. Only the single-file forms, `git restore <file>` and `git checkout -- <file>`, aren't destructive and keep running on their own where they did. Their **whole-worktree forms are destructive** and ask every time, like `git reset --hard`: `git checkout .` and `git restore .`, and any pathspec for the whole worktree (`git restore` without a path, `.`, `:/`, `*`, `:(top)`). `git restore --staged` without `--worktree` only changes the index and isn't destructive. | The user's choice (2026-10-18; the whole-worktree forms after the first review). "Every time" means every time. A single file's restore only undoes the task's own edit, which tasks do often; the whole worktree throws away all its uncommitted work at once. |
| D30 | A **task's MCP tool that changes things** (write, destructive or unrestricted) can be set to **Ask or Never**, never Auto. Ask shows a permission card with the tool and its exact arguments, offering Approve once and Reject only: no grant, no "Always allow". A read tool set to Ask may be approved for the task (by tool name). After the first review: the card shows all of the arguments in a box that scrolls, never cut; a call whose arguments are longer than 20,000 characters is refused, and the task is told to send less in one call; after the second, so is a call whose arguments can't be written out as JSON (nested too deep, circular), rather than shown as something else. | The user's choice (2026-10-18). MCP servers run outside the sandbox (D20), so a task's write through one leaves its worktree; as with D29, each one needs your click. |
| D31 | **GitHub writes that are always refused for tasks**: a GitHub MCP tool that merges, pushes, or writes branches, refs, files, commits, trees, blobs or tags is a fixed Never, whatever the rules say. Decided from the tool's name and failing closed: one of those words in it (also contents, fork, repository, release, workflow, tag…), or a GitHub write ARIA can't place (anything but issues, comments, reviews, pull requests' details, notifications, gists). Other GitHub writes (`create_issue`, `add_issue_comment`) follow D30. After the first review: a server is GitHub's by its name (it has "github" in it) or by its address, noted when your setup is checked and before the address is dropped (`api.githubcopilot.com`, `github.com`, `*.ghe.com`), and once noted it stays (after the second review); and handing work to GitHub's coding agent (`assign_copilot_to_issue`, `create_pull_request_with_copilot`: any GitHub write with copilot, agent or delegate in its name, so also `request_copilot_review`) counts as a branch write. | The user's choice (2026-10-18). The fixed rules (no push to a default branch, no merging) must also hold through MCP. Phase 0's GitHub server listed no tools, so the words are checked against GitHub's own MCP server's tool names. |
| D32 | **Tasks reading Work IQ and the task tracker**: off by default, but you may set those read tools to Auto or Ask for tasks; the page warns when you do (a repository's instructions could steer a task to read your mail or tasks). | The user's choice (2026-10-18). §4.13 had "No Work IQ or task tracker" for workers; it's now a default you can change knowingly. |
| D33 | **New servers**: a server that appears in your Copilot CLI setup gives ARIA its read tools by default (as before), and a notice in the chat says it appeared; for tasks it stays Never. The name classifier fails closed: a tool reads only when its name starts with a read verb and has no word anywhere that changes something. After the first review: a second action after the read verb makes it a write too, joined (`and`, `or`, `then`: `search_and_book_flight`) or as one of a few verb pairs (`check_in`, `check_out`, `check_off`; after the second review only those pairs, so `search_in_files` reads); `test` isn't a read verb (`test_webhook` writes; only a connection test and the like read); and spending, claiming and provisioning verbs count (`book`, `buy`, `pay`, `charge`, `claim`, `provision`, `scale`, `store`, `cache`, `init`, `ack`, `fix`, `sign`, `like`, …). One whole-name exception keeps Phase 0's tools in their classes: Work IQ Calendar's `GetUserDateAndTimeZoneSettings` reads. | The user's choice (2026-10-18). It keeps the first draft's behaviour; the notice makes it visible, and the stricter classifier keeps a misnamed write out. |
| D34 | **Overrides only make things stricter**: you can't relabel a tool's class, and per scope you pick only among the rules its class allows. The page says why a tool can't be set to Auto. | The user's choice (2026-10-18). A class override would let a rule weaken the Conductor's read-only backstop. |
| D35 | **GitHub's MCP server is on, with its default toolset**: the inventory, ARIA's session and the tasks' sessions pass `githubMcpToolConfig: {}` (19 tools that only read; not `enableAllTools`, 102), and GitHub's reads named `<thing>_read`, `_get` or `_list` (`issue_read`, `pull_request_read`, `actions_get`, `actions_list`, `projects_get`, `projects_list`, `repository_ruleset_read`, `custom_properties_read`) are whole-name reads, like D33's exception. Their rules then follow D33: Auto for ARIA and for tasks, until you change them. Of the 19, only `web_search` still counts as a write. **How far that reaches:** a task's GitHub reads (`get_file_contents`, `search_code`, `search_repositories`, `list_issues`, `issue_read` and the rest) aren't limited to the task's own repository: they read every repository your GitHub account can see, private ones and other organisations' included, on their own. A repository's instructions could steer a task to read another one and copy it into its work. Customize › Integrations says so on each of them for Tasks, where they can be set to Ask or Never. | The user's choice (2026-10-19). Keeping GitHub's reads on for tasks by default, with that warning, is also the user's choice (2026-10-19), made after the review pointed out how far they reach. The real runtime starts its GitHub server only for a session that asks for it, so ARIA and tasks had no GitHub tools at all (spike 13), against §4.13. GitHub names its main issue and PR readers `issue_read` and `pull_request_read`, which D33's rule counted as writes. |
| D36 | **A failed CI run is a milestone**, not blocking: it always gets a card in the chat, and a toast when you're away and Focus mode is off. It doesn't count as "needs you": no red dot, and no `<pending>` line. | The user's choice (2026-10-20). §4.5 lists "CI finished" among the milestones; a red run waits for your decision but doesn't hold up a task. |
| D37 | **The notifications inbox watch is on by default**: it starts on the first run, with one notice, and turns off in Customize › Notifications or with `unwatch` (the choice is kept). Only review requests toast. Inbox titles, which anyone can write, stay out of ARIA's own context: its digest and tools name the repository and number only, and the title is shown to you on the card. | The user's choice (2026-10-20). The inbox is GitHub's own catch-all (§4.6); a title is a stranger's words, so it never reaches the model that acts for you. |
| D38 | **My work shows only your projects** (the registered repositories, a fork's `upstream` included), not an account-wide search: a review request on a repository that isn't one of your projects doesn't show. Its three searches are scoped with `repo:` qualifiers, batched to keep each query within 256 characters, and the fetch guard lets only those queries out. | The user's choice (2026-10-20). §5.2 says "across your projects"; batching gives exact counts at a bounded number of searches (filtering an account-wide page could miss your items without a sign). |
| D39 | **A watch row's click opens its newest card**; with no card, My work opens scrolled to that watch's item. Open on GitHub stays a hover button. | The user's choice (2026-10-20). The chat is where news is (D2); My work is where a watch without news lives. |
| D40 | **No count on the sidebar's My work entry**: My work searches only while it's open (and the window is visible), on open, every 5 minutes and on Refresh. | The user's choice (2026-10-20). Review requests already reach you through the inbox watch (D37); a count would mean searching in the background. |
| D41 | **Uncommitted changes don't stop a PR**: ARIA warns and pushes the commits; the PR card says how many changes are left uncommitted (they aren't pushed). | The user's choice (2026-10-21). A worker often leaves a scratch file; Continue commits what belongs in the PR. |
| D42 | **A fork's PR goes to the fork itself by default**; the card can switch it to the `upstream` repository. The head's owner is the fork's owner (origin's), not GitHub CLI's login. One exception: when the fork's base branch lacks the commit the task started from and the upstream's has it, the card opens on the upstream with a note saying why, and switching it back to the fork is refused at the click. | The user's choice (2026-10-21). Opening on someone else's repository is a step you take on purpose; the fork is the remote the task's branch was pushed to. |
| D43 | **Workflow changes need their own tick**: commits that change `.github/workflows/**` list those files on the PR card, and Push and open waits for "I've checked these workflow changes". Other `.github/**` files, build scripts and `.gitmodules` are flagged (listed, no tick). | The user's choice (2026-10-21). A workflow runs with the repository's secrets as soon as it's pushed; the rest runs in builds and CI too. |
| D44 | **A task in autopilot never opens a PR by itself**: every PR goes through the PR card and your click, whoever proposed it (the Done card's Open PR, or ARIA's `open_pr`, which only proposes). | The user's choice (2026-10-21). §4.8's "auto in autopilot only if you allow it" stays Ask for v1: a push and a PR are public. |
| D45 | **Fix it only on ARIA's own PR branches and on the default branch**: a red CI card for another branch or someone else's PR has no Fix it in v1. | The user's choice (2026-10-21). ARIA only commits on its own `aria/` branches; a fix for the default branch goes on a new one. |
| D46 | **Fix it continues the task that owns the branch.** If its worktree is gone, or the task is held at its budget, a new task adopts the branch (a new worktree on it, the same PR). The card shows the task's profile, model and budget. | The user's choice (2026-10-21). The task's session knows the change; adopting keeps one branch, one PR. |
| D47 | **The CI fix profile is seeded for new installs only**; existing installs keep Default until you pick one (Customize › Models, "Fix it uses"). It applies to adopted and default-branch tasks; Continue keeps the task's own profile. | The user's choice (2026-10-21). No profile appears in an existing setup by itself. |
| D48 | **ARIA only proposes Fix it and Address comments**, as a card; the task starts only on your Start. | The user's choice (2026-10-21). Both feed strangers' text (a CI log, a review) into a worker that runs commands; that's yours to decide. |
| D49 | **An expired or missing log still starts the fix**, with "no log" shown prominently on the card and in the worker's message. | The user's choice (2026-10-21). The failed step's name and the code are often enough. |
| D50 | **Address comments covers one review**: its text and its inline comments. The card says the PR's conversation comments aren't included. | The user's choice (2026-10-21). One review is one request with a known author. |
| D51 | **Whose reviews work with one click**: owners, members and collaborators (`author_association`). A review from someone without write access, or a bot (`user.type`), is labelled so and needs an extra tick. Dismissed reviews, and closed or merged PRs, are refused. | The user's choice (2026-10-21). Anyone can comment on a public PR; only people with write access can make it worth one click. |
| D52 | **The extended tick**: for a task started from someone else's text (a CI log or a review), the PR card's tick also covers anything under `.github/**`, package manifests and lockfiles, build scripts, and deleted or weakened tests, besides workflows (D43). Tasks you started yourself keep D43 as it is. The task records what it was started from. | The user's choice (2026-10-21). Injected text aims at what runs in CI or ships in builds, and at the tests that would catch it. |
| D53 | **A red default branch's commit is fetched if it isn't local**: just that commit, from GitHub, with the same locked-down git as ARIA's pushes (a scratch repository, gh's helper, https only, no hooks, none of the project's config); then the fix starts from it. ARIA warns when the default branch has moved on since (the pinned `branches/{b}` read). | The user's choice (2026-10-21). "Pull first" would be a step ARIA can take safely itself. |
| D54 | **The tracker's time-log write tools are reserved for the Timesheet flow (Phase 5D)**: its tools that create, update and delete time logs (the config's `timeLogs` tools) are refused in `request_action` and `list_action_tools`, alongside `unrestricted` tools and D31 GitHub fixed tools. | Phase 5A (2026-10-22). §4.3 and §4.14 require plain-code checks (times, rounding, overlaps, duplicates, and task → project/customer lookup) before any time log is sent; `ActionRunner.executeApprovedMcpCall` exposes `allowTimeLogTools` for Phase 5D's Timesheet runner only. |
| D55 | **Destructive action confirmation and `confirm=true`**: `request_action` refuses `confirm=true` (in any letter case) from the model (§0.4 #5), and strips any `confirm` / `confirmed` flag from stored or edited card JSON. Destructive cards require a confirmation checkbox bound to the exact JSON text (editing the JSON unchecks it), and only that tick injects `confirm: true` into the approved payload. | Phase 5A (2026-10-22; edited-JSON re-tick from review round 1). Ensures `confirm=true` is never set by the model or carried over across payload edits. |
| D56 | **Lossless JSON numbers and no disguise characters in action payloads or tool names**: `*Json` string arguments (a top-level argument whose name ends in `Json` and holds a JSON string, which a tracker config's templates write with `$json`) and edited card JSON reject duplicate/forbidden keys and any number literal that loses precision in IEEE-754 double (`checkJsonRawTokens`), and action arguments and tool identifiers reject control, bidi and invisible format characters (`DISGUISE_CHARS`; `classifyTool` fails closed on invisible characters in tool names, and `Cards.tsx` renders any control/format character as `\uXXXX`). | Phase 5A (2026-10-22, review rounds 1 and 2). Prevents V8 float rounding or duplicate-key differences from passing the check when a C#/Python MCP server parses the raw JSON string, and prevents bidi/invisible characters from disguising payloads or tool names. |
| D57 | **Per-stretch task activities and `manual_link` protection**: each run stretch of an ARIA task is stored in `activities` as `task:<taskId>:run:<stretch>` (so continuing a task on another day never creates a multi-day block), and `manual_link = 1` prevents automatic collectors from overwriting a tracker task link you manually set or cleared. | Phase 5B (2026-10-23, duck round). Keeps multi-day tasks segmented by actual work stretches and preserves manual link edits/clearances across background re-scans. |
| D58 | **Single-pass local git collector (`git log --branches --source --no-show-signature`)**: local git commits are scanned with `%at` (author timestamp) and `%S` (`--source` ref) with `-c core.fsmonitor=false -c log.showSignature=false -c log.mailmap=false --no-replace-objects`, filtered to your configured git identity / GitHub login / `aria/*` branches, with commit bodies kept out of stored metadata and Conductor context. | Phase 5B (2026-10-23, duck round and review rounds 1–2). Resolves branch names on non-tip commits without $N+1$ git spawns, prevents `gpg.program` execution on signed commits, and avoids attributing teammates' commits on `main` to you. |
| D59 | **Timekeeper scope, calendar eligibility filtering, and two-pass IANA/Windows time-zone math**: the Timekeeper session receives only the task tracker's read tools (excluding its raw request tool), Work IQ Calendar (`GetUserDateAndTimeZoneSettings`, `ListCalendarView`, `ListEvents`) and Work IQ Teams (`ListChats`, `ListChatMessages`) read tools (excluding `Work IQ Mail` and generic `workiq-*` plugin tools), plus `propose_timesheet`. Calendar events with `isCancelled`, `isAllDay`, `declined` or `showAs` in `free`/`tentative`/`workingElsewhere`/`oof` are filtered out in plain code, and Graph `{ dateTime, timeZone }` timestamps are parsed across DST transitions with a host-independent two-pass `Intl.DateTimeFormat` solver. | Phase 5C (2026-10-23, duck round and review rounds 1–2). Keeps mail and the tracker's raw request tool out of the Timekeeper, prevents all-day/cancelled/declined events from wiping out work hours, and avoids external time-zone library dependencies while staying DST-exact. |
| D60 | **Plain-code timesheet provenance and re-prepare preservation**: model proposals from `propose_timesheet` always start as `mappedBy: "suggestion"` (uncertain) and can only be promoted to `mappedBy: "link"` or `"rule"` when verified against a stored activity in `activities` and your `time_rules`; `trackerProjectId` and `trackerCustomerId` come from `tracker_tasks_cache` (never from a model guess); and re-preparing a date preserves all user-edited (`mappedBy: "you"`) and non-draft rows. | Phase 5C (2026-10-23, duck round and review rounds 1–2). Prevents a model from self-certifying mappings or project/customer IDs and ensures re-running `prepare_timesheet` never overwrites your manual edits. |
| D61 | **Safe batch correlation and `needsReconcile` gate on ambiguous tracker writes**: `submit()` only marks rows `submitted` when unambiguously correlated by `index`, `(start, end, task)`, or an exact $N$-for-$N$ success response; any partial or full failure preserves the complete `rawResponse` on `time_registered` (D16), and any interrupted or uncorrelated transport outcome marks affected rows `"unknown"` with `needsReconcile: true`, blocking further writes on that date until a refresh reconciles against the tracker's date-range read. | Phase 5D (2026-10-23, duck round and review rounds 1–2). Prevents positional guessing or blind retries from registering duplicate time logs in the tracker when a write's outcome was ambiguous. |
| D62 | **Persistent `submitted` rows in SQLite reconciled with tracker snapshots**: `recomputeAndSaveCard` partitions `state === "submitted"` rows from `draft`/`failed` rows, preserving submitted rows and their `tracker_entry_id`s in `timesheet_entries` across restarts and reconciling them against fresh date-range snapshots. | Phase 5D (2026-10-23, duck round and review rounds 1–2). Ensures registered hours, tracker entry IDs, and duplicate checks survive app restarts and stay in sync with the tracker's edits/deletions. |
| D63 | **Prompt-injection grounding on `remember` and `forget` (`assertMemoryGrounded`, `assertForgetGrounded`)**: `remember` and `forget` validate against `lastConductorUserMessage` (never task-directed messages), requiring an explicit non-negated save or removal cue and proportional content-token overlap with the user's own message, and every memory write/deletion posts a visible timeline notice (`memory_remembered` / `memory_forgotten`). | Phase 6A (2026-10-23, duck round and review rounds 1–2). Prevents untrusted emails, issues, files, or tool results from poisoning ARIA's system prompt or future worker briefs. |
| D64 | **Indexed `session_transcripts` table in SQLite with lazy historical backfill**: worker and Conductor transcript entries are indexed in `session_transcripts` (`search_text`) as they arrive live and on `getTranscript()`, lazily backfilled once for pre-6A sessions (releasing temporary worker handles), flushed before `cleanup_task` removes a worktree, and queried with parameterized SQLite `LIKE` clauses. | Phase 6A (2026-10-23, duck round and review rounds 1–2). Keeps Search fast and zero-model-cost without deserializing every transcript in Node.js or losing transcripts when worktrees are cleaned up. |
| D65 | **Prompt-injection grounding on `remind_me` / `schedule_routine` and isolated automated routine turns (`activeRoutineTurn`)**: `remind_me` and `schedule_routine` require affirmative non-negated intent and proportional token/timing grounding in `lastConductorUserMessage`, enforce 5-field CRONs with a 15-minute minimum interval, and run scheduled `"prompt"` turns under `activeRoutineTurn` (which blocks all user-gated tools: approvals, `remember`/`forget`, and `remind_me`/`schedule_routine`). | Phase 6B (2026-10-23, duck round and review rounds 1–2). Prevents untrusted content from planting recurring routines or reminders, and prevents scheduled routines from self-authorizing user-gated actions. |
| D66 | **Capped `Clock`-driven `croner` scheduler and tool-free Utility summary session**: `Scheduler` validates and computes timezone-normalized next runs with `croner` while scheduling wakeups through `Clock` (capped at 24h to avoid 32-bit timer overflow), and `runUtilitySummary` runs in a short-lived session with `availableTools: []` and `<untrusted_data>` fencing, falling back to the plain-code headline when disabled or on error. | Phase 6B (2026-10-23, duck round and review rounds 1–2). Keeps scheduled routines and reminders deterministically testable with `ManualClock` and ensures the optional Utility model can never call tools or block the Morning brief. |
| D67 | **Root-canonicalized `rerunOf` (`source.rerunOf ?? source.id`) and `baseCommit` inheritance for "Rerun with…"**: rerunning a finished, failed, cancelled or interrupted task creates a fresh worktree branched off `source.baseCommit` (unless you pick a different base branch) and canonicalizes `rerunOf` to the original root task ID so multi-generation reruns group into a single **Compare runs** switcher (`Run #1`, `Run #2`, …) in the session view. | Phase 6C (2026-10-23, duck round and review rounds 1–2). Ensures side-by-side reruns compare against the exact same starting commit even if the base branch moved on, and keeps 3+ reruns in one comparison family. |
| D68 | **Zero-model deterministic slash commands (`/status`, `/tasks`, `/watch`, `/focus`, `/pause-all`, `/budget`)**: deterministic slash commands execute in plain code (`conductor/slash.ts`) without acquiring `turnLock` or overwriting `lastUserMessage` / `lastConductorUserMessage`, while natural-language `/watch <target>` rewrites to a Conductor prompt; `/budget +N` accepts either argument order (`/budget +N [@task|B-n]` or `/budget [@task|B-n] +N`) and refuses to guess when multiple tasks are paused at their budget. | Phase 6C (2026-10-23, duck round and review rounds 1–2). Keeps status, focus, pause-all and budget top-ups instant and free even while ARIA is busy or offline, without risking prompt-injection grounding or profile-policy state. |
| D69 | **Sanitized, lock-aware, bounded spoken announcements (`formatSpokenText`, `MAX_SPEECH_QUEUE = 3`)**: `Attention` emits `{ type: "speak" }` when `spokenAnnouncements` is `"blocking"` or `"all"` (respecting Focus mode for milestones) and the PC is unlocked (`!this.locked`), speaking held blocking items on unlock without repeating on idle backfill (`leave(at)`); `formatSpokenText` strips control/invisible characters, markdown and URLs, caps announcements at 180 characters, and omits raw stack traces (`failed`) and external GitHub review bodies (`review`, `review_request`, `pr_closed`), while the renderer serializes playback with a max queue of 3. | Phase 6D (2026-10-26, design and review rounds 1–2). Prevents untrusted text or stack traces from being read aloud or sent to cloud TTS, avoids speaking to a locked room, and prevents stale announcement backlogs. |
| D70 | **Validated 16 kHz mono WAV push-to-talk, `execFile`-only `whisper.cpp`, and `safeStorage`-encrypted cloud voice keys**: push-to-talk encodes 16 kHz 16-bit mono PCM WAV in the renderer (`RIFF`/`WAVE` header and 10 MB cap verified in core before writing to `os.tmpdir()`, always unlinked in `finally`), executes local `whisper.cpp` via `execFile` (`shell: false`, `windowsHide: true`, validated absolute regular file paths), and stores optional cloud STT/TTS API keys encrypted via Electron's `safeStorage` (`VoiceSecretStore`), allowing only `https://` or loopback `http://127.0.0.1` / `http://localhost` endpoints without credentials. | Phase 6D (2026-10-26, design and review rounds 1–2). Works with both `whisper.cpp` and OpenAI-compatible STT without `ffmpeg`, keeps secrets in the OS keychain (§0.4 #6), and cleans up microphone streams on release, blur or `Escape`. |
| D71 | **Cloud tasks run on Mission Control without a local worktree or sandbox, wait up to 60 s for `session.start` before first prompt, and don't consume local concurrency slots**: `createSession({ cloud: { repository: { owner, name, branch } }, streaming: true })` runs on GitHub-hosted compute; local git worktrees and process sandboxes are skipped, and early prompt drops are prevented by awaiting `session.start` with `producer === "copilot-agent"`. | Phase 8A (2026-10-26, design and review rounds 1–2). Allows long-running tasks to keep working on Mission Control while the PC sleeps without blocking local worktree concurrency. |
| D72 | **Local tasks with `remote: true` export to Mission Control while preserving local worktree isolation**: setting `enableRemoteSessions: true` on `CopilotClient` and `remoteSession: "on"` on the session exports local sessions to GitHub web and mobile through Mission Control, capturing `session.info` (`infoType === "remote"`) to surface Mission Control URLs in ARIA. | Phase 8A (2026-10-26, design and review rounds 1–2). Keeps local worktree isolation and sandbox policies while allowing remote inspection and steering from mobile. |
| D73 | **Phone push notifications fire only while away/locked, coalesce milestones over 30 s, and scrub untrusted external text**: `PhoneNotifier` dispatches push notifications via ntfy or Pushover when `presence === "away"` (including while the PC screen is locked), sanitizes titles and bodies to plain text with short IDs (`Q-n`, `P-n`, `B-n`), and buffers milestones in 30 s batches. | Phase 8B (2026-10-26, design and review rounds 1–2). Prevents phone notification spam while working at the desk, ensures timely delivery when away, and keeps untrusted review/CI text off push services. |
| D74 | **Two-way Telegram relay with strict chat authorization, baseline offset fast-forwarding, and desktop confirmation gates**: long-polls `getUpdates` with strict `telegramChatId` matching (`chat.type === "private"`), fast-forwards the update offset on startup to prevent replaying stale messages, routes inbound commands into the ARIA chat (`engine.sendMessage`), and preserves desktop button confirmation for high-stakes writes. | Phase 8B (2026-10-26, design and review rounds 1–2). Enables hands-free task steering and Q&A from Telegram while keeping destructive writes locked behind desktop card clicks. |
| D75 | **Plain-code 80% budget warnings, daily AI-credit budgets, and dynamic `session_limits_exhausted` credit top-up**: warns at 80% of task budget before pausing at 100% (`waiting_budget`, card `task_budget` with `B-n`), tracks daily AI-credit spend across tasks and Conductor sessions, and answers SDK `session_limits_exhausted.requested` dynamically with `{ action: "add" }` when budget headroom exists instead of permanently cancelling. | Phase 9 (2026-10-27, design and review rounds 1–2). Prevents runaway spend and allows tasks to be resumed cleanly with `/budget +N` without unrecoverable SDK session cancellation loops. |
| D76 | **Rotated JSONL file logging (5 MB × 5 files) with deep circular-safe secret redaction**: writes structured diagnostic logs to `dataDir/logs/aria.log` with size-based rotation and Windows file-lock retry backoff, running all messages and data through recursive `redact()` that scrubs tokens, keys, auth headers, URL query secrets, and CLI flags. | Phase 9 (2026-10-27, design and review rounds 1–2). Provides diagnostic auditability while ensuring credentials and tokens never land in disk logs. |
| D77 | **Hardened Git 2.53+ and `gh` subcommand policy rules failing closed on credential leaks and default-branch mutation**: blocks `gh api` repository mutations (`repos/:owner/:repo`), treats `gh api -X DELETE` and `gh` aliases as destructive, forbids `git update-ref` and `git branch -f` targeting the default branch, and prevents `--global`/`--system`/`--file` Git config manipulation. | Phase 9 (2026-10-27, design and review rounds 1–2). Closes subtle policy bypass vectors introduced by modern Git and GitHub CLI features. |
| D78 | **Recorded SDK `SessionEvent[]` fixtures for deterministic state-machine and transcript regression testing**: tests replay raw recorded SDK event streams through `CopilotRuntime` and `TranscriptMapper` to verify subagent accounting, plan approvals, mid-tool crashes, and cloud budget exhaustion against actual runtime event contracts. | Phase 9 (2026-10-27, design and review rounds 1–2). Prevents regression drift against the Copilot SDK event schema. |
| D79 | **Sandbox bypasses are request-scoped ARIA decisions, never runtime-wide approvals**: `requestSandboxBypass` keeps the original permission payload, hard/ordinary policy runs first, and each SDK result is `approve-once`. One-time, exact task, and safe persistent path/host scopes are owned and revocable by ARIA; fixed refusals, destructive every-time rules and user `Never` rules win. | Phase 10 initial implementation (2026-11-27). Makes boundary recovery usable without turning the sandbox off or weakening existing policy. |

### 0.4 Ground rules for the implementing agent

1. **Start with Phase 0** (§10) and nothing else. Answer every item in §11, record the answers in
   `docs/spike-notes.md`, and update this plan wherever a finding contradicts it. Check with the
   user before moving to the next phase.
2. **The SDK is in technical preview.** Names in this plan (fields, events, methods) were checked
   against the docs on 2026-10-16 but may have changed. Read the current docs (links in §14)
   before writing code against them.
3. **Keep the decisions in §0.3** unless the user changes them. If a finding makes one impossible,
   stop and ask the user.
4. **No real writes during development without the user's explicit OK for that specific action.**
   That covers creating, updating or deleting the task tracker's time logs or tasks, sending mail, posting in
   Teams, pushing branches or opening PRs. Use recorded fixtures or a mock MCP server for tests.
   Read-only calls against the user's real accounts are fine once the user has agreed to Phase 0
   testing.
5. **Never set `confirm=true`** on a destructive task tracker tool on your own initiative (the server
   itself demands explicit user confirmation).
6. **Secrets** (tokens, keys) never go in the repo or in plain-text config. Use the OS keychain
   (Electron `safeStorage`).
7. **Windows first:** test commands, paths with spaces, long paths and worktrees on Windows early.

### 0.5 Prerequisites to confirm in Phase 0

- Node.js LTS and Git installed; Copilot CLI installed and signed in
- GitHub CLI (`gh`) installed and signed in (ARIA reuses `gh auth token` for Octokit in v1)
- Work IQ plugin installed in Copilot CLI (`/plugin marketplace add microsoft/work-iq`, then
  install `workiq@work-iq`)
- A task tracker's MCP server configured in Copilot CLI (optional), and its connection test succeeds

### 0.6 Building and running (since Phase 1)

npm workspaces: `packages/protocol` (IPC contract), `packages/core` (engine), `apps/desktop` (Electron). From the
project folder, in PowerShell:

```powershell
npm install                              # npm 11 runs install scripts only when allowed: package.json allows electron, denies koffi
node node_modules\electron\install.js    # only if Electron's binary is missing (e.g. npm skipped its install script)
npm run typecheck
npm test                                 # Vitest: core with the fake runtime, the renderer's store and Markdown; no model calls
npm run dev                              # the app, with hot reload: uses your real data folder and Conductor session
npm run build; npm run e2e               # the scripted specs (ui-*): fake runtime, throwaway data folder, repo and sessions, no model calls
npm run e2e:real                         # phase1, phase2 and perf-*: the real runtime, so real model calls (AI credits)
$env:ARIA_E2E_MCP = "1"; npm run e2e:real   # also lets phase1's MCP test call your real task tracker's read tools
```

The fifteen scripted UI specs run on the fake runtime: no model calls, no credits, and no real servers (GitHub is a local
mock). Their workers still edit and commit in real worktrees in a temp folder, and their pushes go to local bare
repositories. After `npm run build`, `npm run e2e` runs them (it never runs the real-runtime specs). The same by hand, from `apps\desktop`:

```powershell
npx playwright test ui-cards ui-attention ui-away ui-flow ui-integrations ui-github ui-mywork ui-pr ui-fix ui-actions ui-timesheet ui-search-memory ui-automations ui-phase6c ui-phase6d
```

`npm test` takes about 100 s for core. `packages/core/vitest.config.ts` gives each test 10 s rather than 5, and runs on
half the cores rather than all but one. Most core tests run git many times (worktrees, pushes to bare repositories),
and on Windows a process start is costly. With every core busy, the suite ran slower and task tests passed 5 s.
`npm run e2e` runs the scripted `ui-` specs only. `npm run e2e:real` runs `phase1`, `phase2` and the `perf-` specs: those use the real runtime with GitHub off (their
`ARIA_TEST_RUN=1` gives ARIA no GitHub at all), so they spend AI credits but never touch GitHub.

- `ui-cards`: task cards (question, budget, failure, restart, Discard), the session view, profiles.
- `ui-attention`: Part A's done-when (three tasks ask at once, answered by a button, a reply and through ARIA), a
  permission, a plan, a changed brief template, a proposal, and the Conductor inspector (Part B item 1).
- `ui-away`: attention (Part B item 2): toasts only while you're away, coalescing, Focus mode, idle and lock, the away
  card.
- `ui-flow`: "Always allow this" and "Save as memory" (Part B item 3), a destructive command that asks every time.
- `ui-integrations`: Customize › Integrations (Part B item 4): servers, Sign in, rules for ARIA and for tasks.
- `ui-github` (Phase 4 item 1) covers ARIA's watches:
  - a run, a red run with its job, and a PR's checks and review;
  - a renamed repository's redirect, and an answer cut off after its headers;
  - Chromium's cache never answering;
  - a restart, the inbox, Customize › Notifications and the away card's GitHub group.
- `ui-mywork` (item 2): My work, its refreshes and partial answers, the watch rows, and the project menu by keyboard.
- `ui-pr` (item 3): ARIA's `open_pr` proposing, the PR card (the workflow tick, the uncommitted warning, the fenced
  body), Push and open (to a bare repository and the mock), the PR's watch going green, and Discard's note.
- `ui-fix` (item 4), the done-when: a red check fixed with one click, Push new commits to the same PR, the checks going
  green, then Address comments on a review.
- `ui-actions` (Phase 5A): Action-request cards (`A-1`, `A-2`), decoded `*Json` preview, inline JSON editing before
  Send, and the destructive confirmation checkbox (`remove_task_from_bucket`, which injects `confirm: true` only after
  your tick and clears the tick if the JSON is edited).
- `ui-timesheet` (Phase 5C & 5D): Timekeeper model slot in Customize › Models, preparing a daily timesheet draft
  (`card-timesheet`), confirming an uncertain row, accepting the "Always map … to task …?" learning offer, filling
  a gap conversationally through ARIA, submitting to the tracker (`card-time-registered`), inspecting the week strip and
  day in the Time view, updating a registered entry (the tracker's update tool), and deleting a registered entry after
  ticking its confirmation checkbox (the tracker's delete tool).
- `ui-search-memory` (Phase 6A): `remember` and `forget` tools saving and removing project and global memories (with
  chat notices, Customize › Memory attribution, and injection into briefs and ARIA's own system prompt), and the
  sidebar **Search** view (`nav-search`, `Ctrl+K`) searching across projects, tasks, session transcripts, and memories,
  opening the matching session view or card.
- `ui-automations` (Phase 6B): Utility model slot in Customize › Models, `remind_me` and `schedule_routine` tools in the
  chat, advancing the E2E clock to fire the **Reminder** card (`card-reminder`, Snooze 15m, Done), managing built-in and
  custom routines in the **Automations** view (`nav-automations`), triggering **Run now** on **Morning brief** and
  **Friday week time overview**, and jumping from an unregistered workday on the Morning brief card into the **Time**
  view.
- `ui-phase6c` (Phase 6C): Spotlight-style **Quick prompt bar** (`Ctrl+Space` global shortcut and in-window toggle) with
  `/slash` and `@task` autocomplete, **Start at login** toggle in Customize › Notifications, deterministic slash
  commands (`/status`, `/focus`, `/tasks`, `/budget`, `/pause-all`), and **"Rerun with…"** launching a second run with
  another profile and switching between `Run #1` and `Run #2` in the session view's **Compare runs** bar.
- `ui-phase6d` (Phase 6D): **Voice & Push-to-talk** settings in Customize › Notifications (`voice-spoken`, **Test
  voice**, and OS-keychain cloud API key storage), spoken announcements when a background task finishes, and
  push-to-talk transcription in both the chat composer (`composer-ptt`) and Quick prompt bar (`quick-prompt-ptt`,
  `Ctrl+Shift+Space`).

Environment overrides for a development build (a packaged build drops every `ARIA_*` switch and
`ELECTRON_RENDERER_URL`, keeping only `ARIA_LOG_LEVEL` and the two `ARIA_WHISPER_*` settings):
`ARIA_DATA_DIR` (data folder, default Electron's userData, `%APPDATA%\ARIA`),
`ARIA_PROJECT_ROOTS` (folders to scan, `;`-separated, default `~\Documents\GitHub`), `ARIA_CONDUCTOR_ID` (Conductor
session id, default `aria-conductor`), `ARIA_MODEL` (default model when none is saved yet) and `ARIA_WORKTREE_ROOT`
(where task worktrees go, default `C:\wt`, else `~\.aria-wt`). Set the first and third to try things without touching
your real conversation. `ARIA_FAKE_RUNTIME=ui-cards` swaps the Copilot runtime for a scripted one (no model calls, no
credits; its workers still edit and commit in real worktrees): the nine scripted specs above use it, and it's handy for
UI work. Two more switches, for those specs only: `ARIA_E2E_HOOKS=1` gives the spec a handle on what can't be
driven from the window: toasts are recorded instead of shown, the attention clock moves only when the spec advances it,
the spec sets what the window and the system report about you (focused, away, idle, locked), and a sign-in page is
recorded instead of opened in the browser (`ui-away`, `ui-integrations`). `ARIA_FAKE_CONDUCTOR_DELAY_MS` makes the
scripted runtime take that long to open ARIA's conversation, so the inspector can be seen while it reopens
(`ui-attention`). All three switches work only in an unpackaged build (a stray value in a packaged one changes nothing),
and the window's title and a log line say when the fake runtime or the hooks are on.

GitHub in a test run (since Phase 4; `apps/desktop/src/main/github-options.ts`):
- **A test run** is the scripted runtime, the hooks, or `ARIA_TEST_RUN=1` (the real-runtime specs). It never asks
  gh for its token and never reads github.com. Without a test's server it has no GitHub at all.
- **A test's GitHub, the mock's variables:** each needs a test run and only a development build reads it.
  - `ARIA_FAKE_GITHUB` is the test's GitHub server, on loopback only, with a fake token.
  - `ARIA_FAKE_LOG_HOST` is its log storage, where job logs redirect (loopback only).
  - `ARIA_FAKE_PUSH_ROOT` is a folder of bare repositories (`<owner>/<repo>.git`) that a PR's push and D53's fetch
    go to. The command line is production's; a git config ARIA writes points github.com there, file protocol only.
    Without this folder a test run never pushes or fetches.
- **`ARIA_E2E_HOOKS=1` now also, for GitHub:**
  - no host name resolves in Chromium's network stack (only `127.0.0.1`), and GitHub's session uses no proxy;
  - Open on GitHub is recorded, never opened;
  - the spec can reach GitHub's fetch and ask which GitHub this run reads (`test` or `none`).
- **The specs' git:**
  - every spec's own git and its ARIA run with fsmonitor off and git's proxy at a dead port (`e2e/git-env.ts`);
  - core's tests do the same, with every proxy variable at that port, from `packages/core/test/no-network.ts`;
  - that file also blocks any other host, DNS, and `gh`.

---

## 1. Vision

The GitHub Copilot app is **session-centric**: you start sessions, they show up in a sidebar,
and *you* move between them to see what each one is doing.

ARIA is **attention-centric**: there is exactly **one conversation**. You tell it what you
want; it spins up the work in the background, keeps an eye on it, and only interrupts you when
something is **done**, **needs you**, or **went wrong**. You never *have to* pick a session from a
list, but a sessions sidebar is always there when you want to look inside one.

### Design principles

1. **One chat, many hands.** Every request goes into the same chat. Background workers do the
   work; the chat is where results and questions come back.
2. **Interrupt only when it matters.** Progress noise (tool calls, file reads, logs) never
   lands in the chat. Questions, approvals, completions and failures do.
3. **Answer in place.** Questions and approvals arrive as cards with buttons. You can answer
   with one click or a short reply, without "going to" a session.
4. **Deterministic where possible, AI where useful.** Watching CI, routing events and rendering
   notifications is plain code (free, instant, reliable). The model is used for understanding
   requests and doing the work.
5. **Safe by default.** Every task runs in its own git worktree and branch. Pushes, merges and
   anything outside the worktree need your approval unless you said otherwise.
6. **Core first, UI second.** The engine is a UI-agnostic Node service so a phone or web client
   can be added later without rewriting anything.
7. **Transparent on demand.** Every background session can be opened from the sidebar to read its
   full conversation (the brief, tool calls, decisions) and to step in directly.
8. **You choose the models.** Every part of ARIA that uses AI has its own model and
   reasoning-effort setting. ARIA never picks a model on its own unless you allow it.
9. **It reads widely, writes only with you.** ARIA can see your GitHub, Outlook, Teams and other
   connected tools, but sending, posting or registering anything outside a task's worktree always
   goes through a card you click.

### Copilot app vs ARIA

| | GitHub Copilot app | ARIA |
|---|---|---|
| Main surface | Sidebar of projects and their sessions + "My work" | One chat timeline, plus the same kind of sidebar (projects → sessions, My work, Automations) for looking inside |
| Starting work | New session per task | Just ask; ARIA starts a task |
| Following progress | Open each session | Cards update in place; open a session from the sidebar only when you want the details |
| Models | Picked per session | Set per part (ARIA, worker profiles, summaries), each with model + reasoning effort |
| Questions / approvals | Inside each session | Cards in the one chat, answer inline |
| CI / PR monitoring | Separate views | Watchers that report back into the chat |
| Plugins, MCP servers, skills | Yes | Yes (same runtime). The first draft uses exactly what's configured in Copilot CLI; each session only gets the servers and tools in its scope, and every call is checked. |
| Time registration | — | Daily timesheet draft from Outlook, Teams, GitHub and ARIA activity; one click submits it to your task tracker |
| Engine | Copilot CLI | Copilot CLI via the Copilot SDK |

---

## 2. What it should feel like

```
You     Add a dark mode toggle to GerbilBreederTracker and open a draft PR when done.
ARIA  On it. Started "Dark mode toggle" in a fresh worktree off main.
        [Task card · Dark mode toggle · running · editing src/theme.ts]

You     Also, tell me when the deploy workflow on Moonrise finishes.
ARIA  Watching deploy.yml run #482 on Moonrise (in progress, ~3 min so far).

        ── 6 minutes later ──
[❓ Dark mode toggle needs you]
        Should the toggle live in Settings or in the header?
        [Settings] [Header] [Reply…]
You     (clicks Header)

[✅ CI · Moonrise · deploy.yml #482 succeeded in 4m12s]          [Open run]

        ── 10 minutes later ──
[✅ Dark mode toggle is done]
        5 files changed (+142 −18). Tests pass. Draft PR #37 opened.
        Watching its CI now.                       [View diff] [Open PR]

You     What's still running?
ARIA  Nothing is running. One thing is being watched: CI on PR #37 (2 of 3 checks done).

        ── 16:30 ──
[🕒 Timesheet · Thu 16 Oct · draft 7h15 of 8h · 1 gap]
        09:00–09:15  Standup                      → task "Squad meetings"
        09:15–11:30  Dark mode toggle (PR #37)    → task ACME-123 (linked in the branch name)
        …                                                   [Review] [Submit]
You     The gap at 15:00 was a call with the design team.
ARIA  Added 15:00–15:45 to your "Design sync" task. That makes 8h. Ready to submit.
You     (clicks Submit)
[✅ 7 entries registered in your tracker for Thu 16 Oct]
```

Toasts appear when the window isn't focused; clicking one jumps to the card.

Want to see *how* the dark mode task went? Open the sidebar and click "Dark mode toggle" under the
GerbilBreederTracker project.
Its full conversation opens next to the chat: the brief ARIA wrote, every file it read and
edited, every command it ran. If you spot something to improve (for example, it ran `npm test`
but the project uses `pnpm`), you can type straight into that session, save the correction as a
memory, or adjust the prompt ARIA uses for future briefs.

---

## 3. Architecture

```
┌─ Desktop shell (Electron) ────────────────────────────────────────────────────────────┐
│  chat · sessions sidebar · session view · cards · tray · global hotkey · voice        │
└───────────────────────────────────────────────────────────────────────────────────────┘
          ▲ cards, live updates            │ your messages, button clicks
          │                                ▼
┌─ Core engine (Node) ──────────────────────────────────────────────────────────────────┐
│                                                                                       │
│                     tools                     creates                                 │
│  ┌───────────────┐          ┌──────────────┐            ┌──────────────────────────┐  │
│  │ Conductor     │ ───────► │ Task manager │ ─────────► │ Worker sessions          │  │
│  │ the one chat  │          │ worktrees    │            │ local: git worktree      │  │
│  └───────▲───────┘          │ queue        │            │ cloud: Mission Control   │  │
│          │                  └──────────────┘            └────────────┬─────────────┘  │
│          │ <updates> digest                                          │ events         │
│  ┌───────┴──────────────────────────────┐   ┌───────────┐            │                │
│  │ Attention engine                     │◄──│ Event bus │◄───────────┘                │
│  │ classify · coalesce · route replies  │   └─────▲─────┘                             │
│  └───────┬──────────────────────────────┘         │ events                            │
│          ▼                                ┌───────┴─────────┐                         │
│  Notifier: toast · sound · voice · phone  │ GitHub watchers │                         │
│                                           │ Actions, PRs,   │                         │
│                                           │ inbox           │                         │
│                                           └─────────────────┘                         │
│  ┌────────────────────┐                                                               │
│  │ Timekeeper (daily) │ ──► timesheet draft card ──► your click ──► tracker MCP       │
│  └────────────────────┘                                                               │
│  Shared: SQLite store · policy engine · model profiles · integration scopes ·         │
│          repo registry · scheduler                                                    │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
          │ JSON-RPC: one CopilotClient → one Copilot CLI server → many sessions
          ▼
  Copilot CLI runtime ──► models you chose (Copilot or BYOK)
                      ──► plugins, skills, MCP servers: GitHub · Outlook · Teams · Tracker · …
```

The **Copilot SDK** (`@github/copilot-sdk`) starts the Copilot CLI in server mode in the
background and talks to it over JSON-RPC. For Node the CLI is bundled with the SDK, so there is
nothing extra to install. Every "session" in this plan is an SDK session on that one runtime.

### The moving parts

| Part | What it is | Model and reasoning effort |
|---|---|---|
| **Conductor** | One long-lived SDK session: the chat you talk to. Understands requests and controls everything through custom tools. | **You choose** one model + effort in settings. Suggested: a fast model with low effort. |
| **Workers** | One SDK session per task, each in its own worktree (or in the cloud). They do the actual coding. | **You choose** through worker profiles (each a model + effort), with a per-task override. See §4.12. |
| **Watchers** | Plain code that polls GitHub (Actions, PRs, notifications) and emits events. | None. Plain code. |
| **Attention engine** | Plain code that turns all events into cards, toasts and a digest for the Conductor, and routes your replies. | None by default. Optional AI summaries use the **utility model** you choose. |
| **Timekeeper** | One SDK session that runs once a day (or on request). It reads your calendar, Teams and work activity and prepares a timesheet draft for the task tracker's MCP server. See §4.14. | **You choose** one model + effort in settings. |

All AI sessions (Conductor, workers, Timekeeper) can use your plugins, MCP servers and skills, each
limited to what it needs (§4.13).

---

## 4. Components in detail

### 4.1 Desktop shell

- **Electron + React + TypeScript.** Electron's main process is Node, so the SDK runs there
  directly. (Tauri would need a Node sidecar for the SDK, which adds complexity for no gain here.)
- **Sessions sidebar** (collapsible, `Ctrl+B`) structured like the Copilot app's: ARIA,
  My work, Automations, Customize, Search, then each project (repo) with its sessions underneath.
  A session view lets you read and steer any of them. See §5.2 and §5.3.
- **Tray icon** that shows a dot when something needs you; ARIA keeps running when the
  window is closed.
- **Global hotkey** (for example `Ctrl+Space`) opens a small Spotlight-style prompt bar from
  anywhere. Type, press Enter, and it's gone. Results come back as toasts and in the chat.
- **Start at login** (optional).
- The engine runs in an Electron `utilityProcess` (or the main process at first). The window
  is only a view onto it, connected over typed IPC.

### 4.2 Core engine and the Copilot client

- One `CopilotClient` for the whole app, started at launch, stopped at quit.
- Auth: `useLoggedInUser: true` (reuses your Copilot CLI login). BYOK is available later through
  the session `provider` option.
- Wrap the SDK behind a small **adapter interface** (`AgentRuntime`) because the SDK is in
  technical preview and its API will change. Only the adapter imports `@github/copilot-sdk`.
- The adapter also makes testing easy: a fake runtime can replay recorded event streams.

### 4.3 The Conductor (the one chat)

A single long-lived session with a stable `sessionId` (for example `"conductor"`) so it can be
resumed after restarts with `client.resumeSession("conductor", …)`.

**Configuration**

- `infiniteSessions: { enabled: true }` so the chat can live forever. The runtime compacts old
  context in the background.
- `systemMessage` in `"append"` mode with the ARIA persona and rules (draft in §9.4).
- Model and reasoning effort come from your settings (§4.12). A fast model with low effort is a
  good starting point, because the Conductor mostly routes and summarizes; heavy reasoning happens
  in workers.
- **It does not edit code itself.** Its tool set leaves out the built-in write and shell tools
  (`availableTools` keeps only `view`, `glob`, `grep`, `web_fetch`, `skill`, its own tools and its MCP scope), and
  its permission handler still rejects `write` and `shell` as a backstop. That pushes all real work into tasks. It
  may read files and query GitHub to answer questions.
- **It can read your work tools** through its integration scope (§4.13): GitHub, Outlook mail and
  calendar, Teams, the task tracker and your other MCP servers. So "what's on my calendar tomorrow?" or
  "did anyone reply to my PR in Teams?" just work. Any write (send, post, accept, register) goes
  through a confirmation card.

**Custom tools (the Conductor's control panel)**

Register them with `defer: "never"`: custom tools are deferred by default, and the model then spends an extra call
on `tool_search_tool` before it can use one (Phase 0).

| Tool | Purpose |
|---|---|
| `list_repos` / `register_repo` | Know which local repos exist (name → path, remote, default branch). |
| `list_profiles` | The worker profiles you configured (name, model, effort, when to use each). |
| `start_task` | Start a background task: repo, title, brief, mode (`interactive` / `plan` / `autopilot`), `local` or `cloud`, optional profile (only one of yours, and only when your model policy allows it), base branch, and an optional tracker task to log the time to. |
| `list_tasks` / `get_task` | Status, last summary, diff stats, pending questions, cost. |
| `message_task` | Send a task extra instructions: into a running one (`mode: "immediate"` to steer, `"enqueue"` to queue); a finished, failed or cancelled one continues in its session; one paused at its budget gets them when you raise the budget. |
| `answer_question` | Answer a pending question from a task. |
| `decide_permission` | Approve or reject a pending permission request. |
| `approve_plan` | Accept or send back a task's plan. |
| `cancel_task` / `cleanup_task` | Stop a task; remove its worktree when you're done with it (the branch and its commits stay; **Discard** on its card also deletes the branch and the session). |
| `open_pr` | Push the task branch and open a (draft) PR. Needs confirmation by policy. |
| `watch` / `list_watches` / `unwatch` | Watch a workflow run, PR, branch or deployment and report back. |
| `remind_me` / `schedule_routine` | Reminders and recurring prompts ("every weekday at 9, brief me"). |
| `remember` / `forget` | Long-term preferences and facts (§4.9). |
| `prepare_timesheet` | Ask the Timekeeper for a draft for a day or a range (§4.14). Submitting is only possible with the card's button, never from a tool call. |
| `list_activities` / `list_time_rules` / `save_time_rule` / `delete_time_rule` / `link_task_tracker` | Inspect collected work activities (ARIA task stretches, local git commits, GitHub PRs/reviews/CI) with their resolved tracker task IDs, manage mapping rules, and link or unlink a tracker task on an ARIA task (§4.14, Phase 5B). |
| `list_action_tools` / `request_action` | Discover the MCP tools set to `Ask` for ARIA (with their sanitized `inputSchema`) and propose a write in one of your tools (send a mail, post in Teams, accept a meeting, create or update a task in the tracker). Shows an `action_request` card (`A-n`) with the exact content. Nothing happens until you click. Then the call is made in a short-lived session with the exact-payload check (§4.13, Phase 5A). |

**How the Conductor learns what happened (without costing extra requests)**

Every model call costs money (premium requests or AI credits, depending on your plan). So events
do **not** each trigger a Conductor turn. Instead:

1. Events become cards in the UI immediately (no model involved).
2. The attention engine keeps a list of **unseen updates** and **pending requests**.
3. When you next send a message, it's prefixed with a compact block:

   ```
   <updates since your last message>
   - [done] "Dark mode toggle" (GerbilBreederTracker): 5 files, tests pass, draft PR #37.
   - [ci] Moonrise deploy.yml #482 succeeded (4m12s).
   <pending>
   - Q-17 from "Fix login bug": "Use JWT or session cookies?"
   </pending>
   </updates>
   ```

4. For more detail, the Conductor calls `get_task` or `list_tasks`.

This keeps the chat aware of everything for the cost of a few hundred tokens per message.

### 4.4 Workers (tasks)

Each task is one SDK session plus a database record.

**Local tasks**

1. Resolve the repo from the registry.
2. Create a worktree: `git worktree add <root>\<repo>\<task-slug> -b aria/<task-slug> <base>`.
   Keep `<root>` short (for example `C:\wt`) and enable `core.longpaths`, because Windows path
   limits bite fast with node_modules.
3. `client.createSession({ workingDirectory: worktreePath, model, reasoningEffort, streaming: true,
   onPermissionRequest, onUserInputRequest, onExitPlanModeRequest, onAutoModeSwitchRequest })`, with model and
   effort taken from the task's worker profile (§4.12), `disabledMcpServers` and an exact `availableTools` list
   from the worker scope (§4.13). Then `session.rpc.mode.set({ mode })` for `plan` or `autopilot`: mode is not a
   session option.
4. Subscribe to all events with `session.on(handler)` and feed them to the task state machine.
5. Send the brief (§9.5) with `session.send({ prompt })`.

**Cloud tasks** (later phase)

- `createSession({ cloud: { repository: { owner, name, branch } }, streaming: true, … })` runs
  the task on GitHub-hosted compute through Mission Control.
- Wait for `session.start` with `producer === "copilot-agent"` **before** the first `send`.
  An early first send is silently dropped (documented SDK limitation). Use a ~60 s timeout.
- Save the Mission Control URL from the `session.info` event (`infoType === "remote"`); it is
  not emitted again.
- Good for long jobs that should keep running when your PC sleeps.

**Concurrency**

- Default limit: 3 local tasks at once; the rest are queued (shown as "queued" on their card).
- One `CopilotClient` hosts all sessions. (Phase 0: 5 parallel workers on one client worked fine; the runtime
  tree went from 84 MB idle to 380–600 MB with 5 busy workers, CPU stayed low.)

**Task state machine**

```
queued → starting → running ⇄ waiting_input
                       ⇅      waiting_permission
                       ⇅      waiting_plan_approval
                       ⇅      waiting_budget
                       ↓
              done (needs review) → pr_open → merged/closed → cleaned_up
              failed · cancelled · interrupted (app closed mid-run; resumable)
```

**Event → state → attention mapping**

| SDK event | Task state | What you see |
|---|---|---|
| `assistant.turn_start` | running | Sidebar item and live-strip chip turn blue |
| `assistant.intent` | running | Status text on the task card and sidebar item ("editing src/theme.ts") |
| `tool.*`, `subagent.*`, `assistant.message_delta` | running | Nothing in chat; visible in the task's session view |
| `permission.requested` (policy says "ask") | waiting_permission | 🔴 Approval card + toast |
| `user_input.requested` | waiting_input | 🔴 Question card + toast |
| `exit_plan_mode.requested` | waiting_plan_approval | 🔴 Plan card (summary, full plan, Approve / Revise). Answered through `onExitPlanModeRequest` with one of the offered `actions` (`autopilot`, `interactive`, `exit_only`) |
| `assistant.usage` adds up to the task's budget (sub-agents included) | waiting_budget | 🔴 Budget card (+ credits / stop). The turn is aborted and the slot freed; Continue raises the budget and queues the task first in line. The runtime's own session limit (`session_limits_exhausted`, 30 credits minimum) isn't used. |
| `session.task_complete` (autopilot only) followed by `session.idle` | done (needs review) | 🟢 Done card with summary + diff stats + toast |
| `session.idle` with mode `interactive`/`plan` | done (needs review) | 🟢 Done card with the last assistant message |
| `session.idle` in autopilot without `task_complete` | done (needs review), after a minute of quiet | 🟢 Done card with its last message and a warning that it didn't say it had finished |
| `session.error` | failed | 🔴 Error card (Retry / Open log) |
| `assistant.usage` | — | Cost counter on the task card |
| `session.model_change` | — | Warning card if the new model isn't the one you chose (§4.12) |

Phase 0 findings behind this table (`docs/spike-notes.md`):

- `session.task_complete` only fires in autopilot, and its `success` flag was `true` even when the agent wrote that
  it was blocked and hadn't committed. So "done" always means "needs review". The Done card is based on ARIA's own
  checks: run the project's tests, check that a commit exists and the diff isn't empty.
- An autopilot `session.idle` alone isn't necessarily the end (the SDK's `sendAndWait` ignores autopilot idles and
  sub-agent events). ARIA needs its own "settled" rule, as in `spike/src/lib/wait.ts`.
- Phase 2 found: `availableTools` is a strict allowlist, so it also removes tools the runtime only adds for a mode or a
  handler: `task_complete` (autopilot) and `ask_user` (with `onUserInputRequest`). Without `task_complete` an autopilot
  worker can't say it's done and the runtime keeps nudging it; without `ask_user` it can't ask you anything. Workers list
  both explicitly (`WORKER_BUILTINS` in `integrations/scope.ts`).

**After a task is done**

- Done card buttons: **View diff**, **Open PR**, **Continue** (send more instructions),
  **Discard**.
- Opening a PR automatically creates a watcher for that PR's checks.

### 4.5 Attention engine (the heart of the single chat)

Every event from workers, watchers and the scheduler is normalized into:

```ts
type AttentionEvent = {
  id: string;
  source: "task" | "watch" | "schedule" | "system";
  refId: string;            // task id, watch id, …
  kind: "question" | "permission" | "plan" | "budget" | "done" | "failed"
      | "ci_success" | "ci_failure" | "review" | "reminder" | "progress";
  priority: "blocking" | "milestone" | "info" | "noise";
  title: string;
  body?: string;
  actions?: CardAction[];   // buttons
  createdAt: number;
};
```

**Rules**

| Priority | Examples | Chat | Toast | Tray dot | Conductor digest |
|---|---|---|---|---|---|
| blocking | question, permission, plan, budget, failure, tasks interrupted | New card at the bottom | When you're away, also in Focus mode (never while the window is in front and focused, D25) | Red | Yes, in `<pending>` |
| milestone | task done, CI finished, PR reviewed | New card | When you're away, unless Focus mode is on | — | Yes |
| info | task started, watch created | Updates the existing card | No | — | Short line |
| noise | tool calls, intents, logs | Never (session view only) | No | — | No |

"Away": the window isn't in front and focused, the screen is locked, the PC sleeps, or there's been no input for
5 minutes.

**Coalescing.** Several milestone toasts within 30 seconds become one toast ("3 tasks finished"); each card in the
chat keeps its own buttons (D24). Repeated progress updates edit the same card in place.

**Focus mode.** When on, only blocking events toast; the milestones it kept from toasting wait for the "while you were
away" card (§5.5), which then shows on your return whatever the time away.

**Routing your replies.** This is how one chat can serve many tasks:

1. **Buttons** on a card resolve it directly (no model call).
2. **Reply-to.** Every card has a "Reply" action that pins a reply target above the input box
   ("↩ replying to: Dark mode toggle"). That message goes straight to the task
   (`message_task` or `answer_question`), without going through the Conductor.
3. **@mention.** `@dark-mode use the header instead` routes directly as well.
4. **Free text.** Anything else goes to the Conductor. It sees the `<pending>` list and decides
   whether you're answering a question, starting something new, or asking for status.
5. **Directly in the session view.** If you opened a session from the sidebar, you can type into
   it there. ARIA is told about it in its next `<updates>` digest.

### 4.6 GitHub watchers

Plain code using Octokit. No model involved.

| Watch | API | Polling |
|---|---|---|
| Workflow run | `GET /repos/{o}/{r}/actions/runs/{id}` (or `runs?head_sha=` / `?branch=`) and `/jobs` | Every 15 s while in progress, then stop |
| PR checks and reviews | `GET /repos/{o}/{r}/pulls/{n}`, `/pulls/{n}/reviews`, `/commits/{sha}/check-runs` | Every 60 s while open |
| Default-branch health | `GET /repos/{o}/{r}/actions/runs?branch=main&per_page=1` | Every 5 min for repos you mark as "watched" |
| Inbox catch-all | `GET /notifications` | Respect the `X-Poll-Interval` header (usually 60 s) |
| Task tracker (**Phase 7**, needs native MCP) | the tracker's my-tasks read (its raw JSON variant) through ARIA's own MCP client, diffed against the last result | Every 10 min: new tasks assigned to you, status or priority changes, new comments on your tasks. Until then, ask ARIA ("anything new on my tasks?"). |

- Use **ETags** (`If-None-Match`). A `304 Not Modified` response doesn't count against your rate
  limit, so frequent polling is nearly free.
- Use `@octokit/plugin-throttling` and `@octokit/plugin-retry`.
- Watches have an end condition: "until completed", "until success", "until merged", or a timeout.
- Auth for v1: reuse the GitHub CLI token (`gh auth token`). Later: a proper OAuth device flow.
- Webhooks (real-time, no polling) need a public endpoint. That's a later upgrade with a small
  relay (a GitHub App + a tiny serverless function). Polling is fine for one person.

**CI failure → fix flow.** A ❌ CI card gets a **Fix it** button. It starts a task on that
branch with the failing job's log (`GET /repos/{o}/{r}/actions/jobs/{job_id}/logs`) included in the
brief. This is one of the most "ARIA" moments in the app, so it ships in the GitHub phase.

### 4.7 Notifications

- **Windows toasts** via Electron `Notification`. Clicking a toast focuses the window and scrolls
  to the card. (Buttons inside Windows toasts need custom `toastXml`; that's optional polish.)
- **Sounds**: a distinct sound for "needs you" vs "done".
- **Voice (later)**: speak short announcements ("Dark mode is done, tests pass") with the
  browser's `speechSynthesis` (uses Windows voices, free) or a nicer cloud TTS.
- **Phone (later)**:
  - Push via [ntfy](https://ntfy.sh) or Pushover: one HTTP call per notification.
  - Two-way via a Telegram bot that relays messages into the same chat.
  - The SDK's **remote sessions** can also show local sessions in GitHub web/mobile through
    Mission Control.

### 4.8 Permissions and safety policy

All permission requests from workers go through a **policy engine** before reaching you.
Request kinds in the SDK: `shell`, `write`, `read`, `mcp`, `custom-tool`, `url`, `memory`, `hook`.

**Default policy** (editable in settings, overridable per task):

| Request | Inside the task's worktree | Outside the worktree |
|---|---|---|
| `read` | Auto-approve | Ask |
| `write` | Auto-approve | Ask (always) |
| `shell`, allowlisted (`npm test`, `npm run build`, `git status/diff/add/commit`, `dotnet test`, …) | Auto-approve | Ask |
| `shell`, `git push` | Ask (auto in autopilot only if you allow it) | — |
| `shell`, destructive (`Remove-Item -Recurse` / `rm -rf`, `del /s`, `rimraf`, `robocopy /MIR`, `git reset --hard`, `git checkout .` / `git restore .`, `git clean`, `git stash clear`, force pushes, `git branch -D`, …) | Ask every time, sandboxed or not (D28, D29) | Ask every time |
| `url` / network | Ask; remember allowed domains | Ask |
| `mcp` | Per tool, from Customize › Integrations (§4.13): read tools auto, write tools ask | — |

- Responses map to SDK results: `approve-once`, `approve-for-session`, `approve-for-location`,
  `reject` (with feedback), or `user-not-available`.
- If nobody answers for N minutes, the task stays paused. It never auto-approves on a timeout.
  (Phase 0: a request held for 15 minutes stayed pending without errors and ran normally afterwards.)
- Hard rules ARIA never breaks, whatever you approve: no pushes to a default branch, no merging pull requests, and
  no deleting, mirroring or pruning remote branches, also through git or gh aliases or another program (Phase 3).
- **Destructive commands are a fixed Ask** (D28, D29), checked after the hard rules and before your rules: they ask
  every time, also in the sandbox, whatever an Auto rule says (a Never rule still refuses them), and their card offers
  only Approve once and Reject (no "Approve for this task", and no grant from before covers them). The class is
  `Remove-Item` and its aliases with `-Recurse` (any prefix), `-rf` or `/s`, or in a line with a recursive
  `Get-ChildItem`; `rimraf` (also through `npx` and the package managers); `robocopy /MIR` or `/PURGE`; `git reset
  --hard`; `git checkout` or `git restore` of the whole worktree (`.`, `*`, `:/`, `:(top)`, `git restore` without a
  path); `git checkout -f`; `git switch -f` or `--discard-changes`; `git clean` without `-n`; `git stash clear` and
  `drop`; force pushes; `git branch -D` and `-M`. Also behind a git alias, or in the command line a shell is given
  (read as commands, else by its words where ARIA can't read it, as with cmd's own syntax). `git restore <file>`,
  `git checkout -- <file>` and `git restore --staged` aren't in it.
- **Your rules** (Customize › Permissions): the most specific one wins, the strictest among equally specific ones. A
  rule can be **exact** (only that command, its arguments in that order, letter case included; it weighs one more than
  the same words without "exact") and can apply to **sandboxed tasks only** (D27). An Auto rule matches only a program
  named alone (`npm`, `npm.cmd`), never one named by its folder (`.\npm.cmd`, `C:\…\node.exe`, `C:npm`): a task can put
  its own program there, so such a command asks as before; Ask and Never rules match it either way. Saving a new or
  changed Auto rule goes through the save checks (D26).
- Tokens live in the OS keychain (Electron `safeStorage`), never in plain-text config. Saving never overwrites stored
  secrets that won't decrypt today (a locked keyring, a restored profile): they wait aside and rejoin once they read.

**What the requests contain (Phase 0)**, and what that means for the rules:

- **Shell:** `fullCommandText`, `shellType`, `intention`, `commandSegments`, `possiblePaths`, `possibleUrls`,
  `resolvedWorkingDirectory`, `requestSandboxBypass`. Commands run in PowerShell 7 (`pwsh`). Match rules against
  `commandSegments[]` (for PowerShell, `commands[]` holds the whole line as one unparsed entry). Allowlist exact
  operations (`git status`, `git commit`, `npm test`), never a whole program: `git` alone allows a push to any URL
  and `node` runs arbitrary code. `possiblePaths` was often empty, so "inside the worktree" can't rely on it alone.
  Even exact operations can reach outside the worktree through their arguments (`--prefix`, `--output`, `-C`),
  variables (`$env:…`) or script blocks, so rules must check arguments too. **An allowlist is not a sandbox**: an
  approved `npm test` runs whatever code the agent wrote. So workers also run in the runtime's **sandbox** (D20, from
  Phase 3), which confines their commands and file tools to the worktree and their network to package registries.
- **Write / read:** `fileName` or `path`, `resolvedPath`, and for writes the `diff`.
- **MCP:** `serverName`, `toolName` (the wire name `<server>-<tool>`), `args`, `readOnly`. `readOnly` is false for
  tools without MCP annotations (the task tracker's tools have none), so the name rules in §4.13 decide the class.
- A pre-tool hook (`onPreToolUse`) can also deny a call before any permission request; `onPreMcpToolCall` cannot
  block.

### 4.9 Memory and repo registry

- **Repo registry** (shown as **Projects** in the sidebar): on first run, scan configured roots
  (default: `~\Documents\GitHub`, skipping ARIA's own repo) for git repos. Add more from the sidebar (local folder, GitHub
  clone, or repository URL). Store name, path, `owner/name` remote, default branch, learned
  commands (test/build/lint), and per-project settings: default worker profile, pinned, hidden.
  The Conductor resolves "the castle defense game" → `Garden Castle Defense`.
- **Memory**: small facts and preferences ("always draft PRs", "Moonrise uses pnpm",
  "don't touch main on StarHarvester"). Stored in SQLite, injected into the Conductor's system
  message, and edited with `remember` / `forget` or a settings page.
- **Per-repo instructions**: workers automatically pick up the repo's
  `.github/copilot-instructions.md` / `AGENTS.md`, just like the CLI does.

### 4.10 Persistence and crash recovery

- **SQLite** (`node:sqlite`, §6). Tables in §8.
- The SDK keeps its own session transcripts. ARIA stores each task's `sessionId` so it can call
  `resumeSession` after a restart.
- Several SDK events (deltas, `session.idle`, `assistant.usage`, …) are **ephemeral** and are
  not replayed on resume. ARIA therefore persists its own task state and timeline, and on startup:
  1. Marks tasks that were running as `interrupted`.
  2. Shows one card: "3 tasks were interrupted when ARIA closed. [Resume all] [Review]".
  3. Resumes watchers from the database.
- Resuming needs the session's handlers and tools again (`resumeSession(id, config)`); they aren't persisted. The
  runtime marks a tool call that was cut off as failed and emits `session.warning` with
  `warningType: "interrupted_tools"`, which the Review card shows. `getEvents()` keeps messages, tool calls with
  arguments and results, and permission decisions: enough for the session view (Phase 0).
- The runtime's session store is the same one the Copilot CLI and app use, so ARIA's sessions show up in their
  session lists. ARIA names its sessions (`name`, `clientName`) and deletes them with the task's cleanup.

### 4.11 Cost and budget

- Show cost per task on its card (from `assistant.usage` events and `session.usage.getMetrics`, which reports
  `totalNanoAiu` and `totalPremiumRequestCost`). The account quota is shared with every other Copilot session, so
  per-task cost always comes from the session's own metrics.
- Show remaining quota in settings (`session.rpc.quota.get`: unit `ai_credits`, used and remaining, reset date).
  `account.getQuota` returned a wrong reset date in Phase 0.
- Use SDK **session limits** (`sessionLimits.maxAiCredits`, minimum **30** AI credits) as the hard cap for each
  task. Because that minimum is far above a small task's cost (0.25–0.5 credits in Phase 0), ARIA also keeps its
  own per-task watcher (credits from `assistant.usage`, number of turns) that pauses the task with a blocking
  "budget" card at the profile's budget, well before the runtime limit, instead of silently spending more.
- Optional daily budget across all tasks.
- Model choices are yours (§4.12). Billing is token-based: every model dropdown shows the model's price category and
  token prices from the runtime's model list (`billing.tokenPrices`, `modelPickerPriceCategory`), so you see the cost
  when you choose. (The older `billing.multiplier` field is empty in the current runtime.)

### 4.12 Model and reasoning control

Every part of ARIA that uses AI has its own explicit **model + reasoning effort** setting.
Nothing is chosen behind your back.

**Model slots**

| Slot | Used for | Suggested start | Where you change it |
|---|---|---|---|
| **ARIA** (Conductor) | The main chat | Fast model, low effort | Customize › Models. Applies from your next message (`session.setModel`). |
| **Worker profiles** | Background tasks | See below | Customize › Models; per task when starting it; mid-task in the session view |
| **Utility** (optional) | AI-written summaries: morning brief, "while you were away", task titles | Off, or a cheap model with low effort | Customize › Models |
| **Timekeeper** | Preparing your daily timesheet (§4.14) | A mid-range model, low or medium effort | Customize › Models |
| Watchers, attention engine | Nothing | No model | — |

**Worker profiles** are named presets that you define. For example:

| Profile | Use for | Model | Effort |
|---|---|---|---|
| **Default** ★ | Everyday tasks | your pick | medium |
| **Quick** | Small fixes, docs, renames | a fast, cheap model | low |
| **Deep** | Features and refactors | a strong model | high |
| **Architect** | Plan mode, large changes | your strongest model | highest available |
| **CI fix** | Used by the "Fix it" button | your pick | medium |

A profile can also set a BYOK provider, a default mode (interactive / plan / autopilot), extra
instructions for the worker, and a session budget.

**Who picks the profile for a task?** One setting, and you choose:

1. **Me** (default): ARIA always uses the Default profile unless you name one
   ("use Deep for this"). A project can set its own default profile in Project settings (for
   example, Moonrise always uses Deep); that then counts as "Default" for tasks in that repo.
2. **ARIA, within my profiles**: ARIA may choose one of your profiles. It must say which one
   and why on the task card, and it can never use a model outside your profiles.
3. **Ask me**: ARIA proposes a profile on a card, and the task starts when you confirm.

**How this is enforced in code, not just in the prompt**

- The `profile` parameter of `start_task` is an enum of your profile names, so the Conductor
  can't invent a model. When you edit profiles, ARIA refreshes the tool with `session.setTools`.
- With policy 1, the task manager accepts a non-default profile only if its name appears in your
  latest message. Otherwise it falls back to Default.
- Dropdowns are filled from the runtime's model list (`models.list`), with each model's price category, token prices
  and the effort levels it supports (`supportedReasoningEfforts`; some models also accept `none`). BYOK models appear
  next to Copilot's.
- ARIA checks every model it sets against your profiles in its own code. The session option `allowedModels` is
  only a backstop: in Phase 0, setting a model outside the list didn't fail, the runtime silently picked an allowed
  one instead.
- Auto tier only applies to the `auto` model, which ARIA never selects, so a session doesn't change model on its
  own that way. ARIA answers the runtime's "switch to auto after a rate limit?" request (`onAutoModeSwitchRequest`)
  with "no" (or asks you), and raises a warning card if `session.model_change` reports a model you didn't choose.
  `model_change.cause` tells automatic switches apart (`rate_limit_auto_switch`, `refusal_fallback`). **Decided
  (D15):** no setting was found to turn off the refusal fallback, so ARIA detects it and shows the warning card
  (with Switch back). Candidate improvement to test in Phase 2: give each session `allowedModels` with only its
  profile's model, so there is nothing to fall back to.
- Every task card, sidebar item and session view shows the model and effort in use. Changing them
  mid-task from the session view calls `session.setModel(model, { reasoningEffort })` (applies from the next turn);
  effort alone uses `session.rpc.model.setReasoningEffort`.
- Sub-agents that a worker starts on its own can be pinned (Phase 0): custom agents through
  `customAgents[].model` / `reasoningEffort`, built-in ones (`explore`, `task`, …) through
  `session.rpc.tools.updateSubagentSettings`. ARIA pins them to the task's profile unless the profile says
  otherwise, and the session view shows which model each sub-agent used.

### 4.13 Integrations: plugins, MCP servers and skills

Every ARIA session (the Conductor, workers, the Timekeeper) runs on the Copilot CLI runtime, so
it supports everything the CLI does: MCP servers (local stdio and remote HTTP/SSE, with OAuth
sign-in handled by the runtime), plugins, skills and custom agents, plus the GitHub MCP server
that ships with the CLI.

**First draft: use what's configured in Copilot CLI**

In the first draft, ARIA has no MCP configuration of its own. Its sessions use the MCP servers
and plugins you've set up in Copilot CLI, including Work IQ and your task tracker's MCP server:

- Plugins installed in the CLI are loaded by SDK sessions automatically ("ambient").
- MCP servers in the CLI's own config: **decided:** sessions pick them up automatically, so the
  CLI stays the only place you configure anything. **Phase 0 confirmed this** (all servers from
  `~/.copilot/mcp-config.json` plus plugin-provided ones load, and the CLI's disabled list is honored), so the
  fallback of passing the config through `mcpServers` isn't needed.
- Adding and removing a server happens in the CLI (`/mcp`, `/plugin`). ARIA picks up the change on its next
  start. **Signing in is the exception:** ARIA's runtime doesn't reuse the Copilot app's or CLI's sign-in for
  OAuth servers such as Work IQ. Each one starts as `needs-auth` until it's signed in once through ARIA
  (`session.rpc.mcp.oauth.login({ serverName })` returns a URL to open in the browser). The token then persists
  across restarts. The task tracker's server connected without a prompt (Phase 0). A sign-in that expired (its refresh refused too)
  shows as `needs-auth` again, and a session that was already open doesn't get a new sign-in: only sessions opened
  after it do (checked 2026-10-19).
- The built-in GitHub MCP server is started only for a session that passes `githubMcpToolConfig` (`{}`: 19 read
  tools; `enableAllTools`: 102). Without it, a session has no GitHub tools at all (checked 2026-10-19). Every session
  ARIA opens passes `{}` (D35).

Every session sees only the tools in its scope, and ARIA checks every call as well (Phase 0 showed both work
in the first draft):

- **Hiding.** Each session gets `disabledMcpServers` for the servers outside its scope (this also works for
  plugin-provided servers) and an exact `availableTools` list. Tool names are the runtime's wire names
  `<server>-<tool>` (spaces in server names become hyphens: `Work-IQ-Calendar-ListCalendarView`). The lists only
  match exact names or a bare `*`, never a pattern such as `Acme-get_*`, so ARIA expands each scope into
  exact names (the full list is available without a model call).
- **Permission policy.** Every `mcp` permission request is checked against the session's scope
  and the tool's rule before it runs. Out-of-scope calls are rejected.
- **Exact-payload check for writes.** When you approve a write (a timesheet or an action card),
  a short-lived session (using the Conductor's model) is told to make exactly that call. Before
  the call runs, ARIA's code compares its arguments with the payload you approved. Anything that
  differs is blocked. **Decided:** this check lives in the permission handler, the same place as
  the scope rules. An SDK pre-tool hook is the fallback only if permission requests turn out not
  to include the full arguments. So even without its
  own MCP client, ARIA sends exactly what you approved.
- **Tool classes from the name**, so a new tool gets a sensible default without any setup (the runtime's own
  `readOnly` flag is false for every tool without MCP annotations, including a task tracker's tools, so it can't decide
  this):
  - `get_*`, `search_*`, `list_*`, `find_*`, `fetch_*`, `read_*`, `query_*`, `check_*`, … and a connection test → read
  - `create_*`, `update_*`, `add_*` → write
  - `delete_*`, `remove_*` → destructive
  - generic `api_post`, `api_patch`, `api_delete` → unrestricted

  The class fails closed (D33): a tool reads only when its name starts with a read verb and has no word anywhere that
  changes something (`search_and_replace` writes; a verb that's also a noun, like `commit`, counts unless it's the
  thing right after the read verb, so `get_commit` still reads). A second action after the read verb makes it a write
  as well, joined by `and`, `or` or `then` (`search_and_book_flight`, `find_or_provision_vm`) or as part of another
  verb (`check_in_changes`), and so does any name ARIA can't place. In Customize › Integrations you set a rule per
  tool and scope, but only a stricter one than its class allows (D34): a tool's class can't be relabelled.

**Later: native MCP (Phase 7)**

Once the first draft works, ARIA gets its own MCP configuration:

- its own list of servers and plugins in Customize › Integrations, imported from the CLI, with an
  optional **Keep in sync** that re-imports on every start
- each session's scope keeps being applied with `disabledMcpServers` and exact `availableTools` lists (already
  in the first draft; `COPILOT_PLUGIN_DIR_ONLY=true` had no visible effect in Phase 0 and isn't needed)
- a built-in MCP client (`@modelcontextprotocol/sdk`) so ARIA's code can call servers directly,
  with no model in between: the Submit button, action cards, duplicate checks, and the task tracker
  watcher (§4.6)

**Scopes: each session only gets what it needs**

| Session | Integrations | Can it change things? |
|---|---|---|
| **ARIA** (Conductor) | GitHub, Work IQ (mail, calendar, Teams), the task tracker's read tools, your other MCP servers | Never directly. A write (mail, Teams post, meeting reply, tracker task) is proposed as an action card that shows the exact payload, and only that payload can be sent after your click. |
| **Workers** | GitHub, repo-specific MCP servers, skills and plugins, docs servers | Only inside their worktree, per the permission policy. An MCP tool that changes things asks every time (D30); GitHub tools that merge or write branches, refs, files, commits or tags never run (D31). GitHub's read tools run on their own by default, across every repository your account can see, with a warning on the page (D35). Work IQ and the task tracker: off by default; you can turn their read tools on, with a warning (D32). |
| **Timekeeper** | Work IQ calendar and Teams (plus mail metadata if you opt in), GitHub, the task tracker's read tools | No. It only proposes a timesheet draft. After you click Submit, exactly the rows you approved are sent. |

In the first draft, out-of-scope tools aren't passed to a session (exact allowlists) and are blocked when called
anyway.

**Customize › Integrations** in the first draft shows:

- the servers and plugins found in your Copilot CLI setup, with their source and status (adding and removing
  still happen in the CLI; Refresh checks again, at most every 30 s), and a **Sign in** button for servers that show
  `needs-auth` in ARIA's runtime (Work IQ), with Cancel and Try again
- every tool seen so far, with its class (from the name rules) and a rule per scope (ARIA, Tasks): auto, ask or
  never, among what its class allows (D22, D30, D31, D34). A new server's read tools reach ARIA by default and a
  notice says it appeared; tasks don't get it (D33). A server that's gone keeps its rules, shown with when it was last
  seen, to move to a renamed server or forget. No server address is kept (it can carry a key), and what servers say
  (names, descriptions, errors) is shown as plain text, cut, without control or invisible characters

With native MCP it also gets Test buttons, Import from Copilot CLI, and Keep in sync.

Content from mails, Teams messages, task comments and other people's issues is
**untrusted data**. ARIA never follows instructions found in it.

**Microsoft 365 through Work IQ**

You have a Microsoft 365 Copilot license with Work IQ access, so ARIA uses Work IQ for mail,
calendar and Teams, through the Work IQ servers in your CLI setup (`Work IQ Mail`, `Work IQ Calendar`,
`Work IQ Teams`, plus the `workiq@work-iq` plugin). No Graph app registration is needed, but each server needs the
one-time sign-in in ARIA described above. Work IQ is in preview, so ARIA wraps it the same way as the SDK: behind
an adapter, with recorded responses as test fixtures.

**A task tracker's MCP server**

ARIA works with one task tracker at a time, through its MCP server. A config file describes the tracker: which of its tools to call,
where a task's fields are in the JSON they return, what a task reference looks like, and how a time log is written
(the format is in [`docs/trackers.md`](docs/trackers.md)). In **Customize › Integrations**, a server's card has **Use as task tracker**,
which picks a config for it (or **Import config…**), and `/tracker` lists the configs and switches between them. With no tracker, nothing
that needs one is shown. Phases 5 and 7 were built for one tracker and made generic afterwards, so this section and §4.14 say what the
app does with any config.

ARIA classifies the tools of the tracker's server like this by default (you can change any rule). The config names the tools of the
first groups; any other tool of the server is classed by its name, as above:

| Group | Named by | Class | ARIA (Conductor) | Timekeeper | After your click |
|---|---|---|---|---|---|
| Tasks and lookups, read | `tasks.myTasks`, `tasks.byId`, `projects.search`, `tools.testConnection` | read | auto | auto | — |
| Time logs, read | `timeLogs.byRange` | read | auto | auto | — |
| Time logs, write | `timeLogs.create`, `timeLogs.update` (listed in `tools.reserved`, D54) | write | refused in `request_action` | never | the **Submit** and **Update** buttons, with the exact-payload check |
| Time logs, delete | `timeLogs.delete` (listed in `tools.reserved`) | destructive | refused in `request_action` | never | only after an explicit confirm click in the Time view |
| Other tools that change tasks | named like `create_*`, `update_*`, `add_*` | write | ask (action card) | never | the action card's button, with the exact-payload check |
| Other destructive tools | named like `delete_*`, `remove_*`; `tools.confirm` lists the ones that need `confirm: true` | destructive | ask, showing the exact IDs. ARIA never sets `confirm=true` on its own. | never | only after an explicit confirm click |
| Generic request, read | a generic GET tool such as `api_get` | read | auto | never | — |
| Generic request, write | `api_post`, `api_patch`, `api_delete` and the like | unrestricted | **never** | never | — |

A server's generic request tools can change anything its API allows, so the writing ones are off for every session by default.
Everything ARIA needs from a tracker has to be a dedicated tool: a config is refused when a tool it reads with isn't named like a read,
or when a time-log write isn't in `tools.reserved`.

This also covers your **task tracker work**: "what's assigned to me?", "what changed on my tasks today?", or "create a follow-up task in
the design project for the review comments". That last one becomes an action card with the task fields the tool asks for, following the
project's existing conventions as the tool's own guidance asks.

### 4.14 Work tracking and time registration

Goal: at the end of the day, a draft of your timesheet is ready. You check it, fix what's wrong,
click **Submit**, and the entries are registered in your task tracker.

**The task tracker**

ARIA works with one task tracker at a time, through its MCP server (§4.13). A config file describes it (the format is in
[`docs/trackers.md`](docs/trackers.md)): which tools to call, where a task's fields are in the JSON they return, what a task
reference looks like, and how a time log is written. With no tracker, the parts of this section that need one (task links, Submit) are left
out, and the Time view keeps times and comments only; a tracker without time logs gets the same. Phases 5A to 7B were built for
one tracker and made generic afterwards.

**What a time log needs**

A time log is a **task** reference, a **start** and an **end** time, and a comment. When the tracker asks for them (`requiresProjectCustomer`
in its config), it also has a **project** and a **customer**. So every block of your day has to land on a tracker **task**. The project and
customer always come from that task (from the tracker's own read of it), never from a guess. The config says how the times are written
(`timeLogs.time`): local time without an offset (`2026-07-08T09:00:00`), with the zone's offset, or in UTC. It also says how the create
call takes its entries (`timeLogs.create.args`): a template with one row per entry (task, project, customer, date, start, end, minutes,
comment). A tool that takes the rows as one JSON **string** argument gets it from the template's `$json` directive. The Timekeeper reads the
tracker's JSON through the config's paths, and only the JSON: the formatted text that some tools also return is ignored, so the tools
the config names for reading are the ones that return JSON.

**Activity sources**

| Source | How ARIA gets it | What it contributes |
|---|---|---|
| Outlook calendar | Work IQ (`ListCalendarView`, `GetUserDateAndTimeZoneSettings`) | Meetings: start and end with time zone, subject, organizer, attendees, online or not, cancelled, your response. Fixed blocks. Your working hours and time zone. |
| Teams | Work IQ (`ListChats`, `ListChatMessages`) | Chats you were active in (message times are UTC). There's no tool for calls you joined: Teams meetings come from the calendar, and the invite response isn't proof of attendance (`GetOnlineMeetingAttendanceReports` may be; untested). |
| Outlook mail (opt-in) | Work IQ | Metadata only (time, subject, recipients) of mails you sent |
| GitHub | Octokit, through the watchers (no model) | Commits, PRs opened and reviewed, comments, with time and repo |
| Local git | `git log` in your registered projects | Unpushed commits and branch names |
| Task tracker | The Timekeeper, through the tracker's MCP server from your CLI setup | Your open tasks (`tasks.myTasks`), and what's already logged that day (`timeLogs.byRange`) |
| ARIA itself | Its own database | Tasks per project with start and end times, and the tracker task linked to each |

Not planned: tracking which windows or apps are active on your PC. That's too invasive for too
little gain.

**How each block finds its tracker task** (most reliable first)

1. **Explicit link**: a task reference or task URL, as the config's `taskRef` describes them (an ID after a prefix or keyword such as
   "task", or on its own when the tracker's IDs say what they are), in the
   branch name, commit message, PR title or body, or meeting title or invite. An ARIA task can
   also be linked to a tracker task when it starts (`start_task` accepts one).
2. **Your rules**: repo → task, meeting title or organizer → task, Teams channel → task. For
   example: all "Standup" meetings → your squad's meetings task.
3. **Suggestion**: the Timekeeper picks among your open tasks and the tasks you logged to recently,
   and marks the row **uncertain** until you confirm it.

**How a timesheet is built**

1. **Collect** (plain code, all day): GitHub, local git and ARIA activity go into an
   `activities` table as they happen.
2. **Prepare** (the Timekeeper session, once a day at a time you set, such as 16:30, or when you
   ask: "ARIA, prepare my timesheet for yesterday"):
   - fetch the day's meetings and Teams activity through Work IQ
   - fetch your open tasks and anything already logged for that day, as the config's steps say
   - place meetings as fixed blocks, then fill the gaps with clusters of GitHub, git and ARIA
     activity
   - map each block to a task as described above
   - write a short comment per entry ("Dark mode toggle, PR #37")
   - return the draft through an ARIA tool (`propose_timesheet`). The Timekeeper has no tracker
     write tools.
3. **Check** (plain code, not the model):
   - time zones: your local time (handled with daylight saving in mind) becomes the form the config says for creating entries
     (`timeLogs.time`: local without an offset, with the zone's offset, or UTC), and the dates the config's date-range read asks for
     (Phase 0: one tracker's date-range read took ISO dates such as `2026-10-16`, not epoch milliseconds)
   - rounding (for example to 15 minutes), overlaps, and the total against your expected hours
   - overlap with entries already in the tracker, to prevent duplicates
   - gaps and uncertain rows are flagged
4. **Review**: a Timesheet card appears in the chat, for example
   "Thu 16 Oct · draft 7h45 of 8h · 1 gap · 2 uncertain". Edit rows inline, or just tell ARIA
   ("the 14:00 block was the design sync task").
5. **Submit**: one click. A short-lived session is told to call the config's create tool (`timeLogs.create`) with
   exactly the rows you approved, and ARIA's code compares the call's arguments with those rows
   before it runs; anything different is blocked (§4.13). Each entry is reported as registered or
   failed, with the reason, taken from the tool's result and never from what the model says afterwards. If the
   batch fails, fully or partly, the card shows the server's full response (D16). The returned IDs are stored, so a
   day is never registered twice.
   (Phase 0: the cheapest model reproduced 1–20 rows byte-exactly in 5 of 5 runs, 3–8 s per submit.)
   (With native MCP in Phase 7, ARIA's code makes this call itself.)
6. **Later changes**: editing a registered entry uses the config's update tool (`timeLogs.update`, in place, not
   delete + recreate). Deleting goes through its delete tool (`timeLogs.delete`) only after a
   confirm card that lists the exact IDs.

**Learning.** When you correct a mapping, ARIA offers to save it as a rule ("Always map the
#design channel to the design task?"). Rules are visible and editable in the **Time**
view.

**Reminders.** The morning brief mentions any workday that isn't registered yet. On Friday
afternoon you get a week overview that shows missing days.

**Who does what.** The model only maps blocks that links and rules can't, writes the comments, and
(in the first draft) carries out the approved submit call. Times, totals, duplicate checks and the
check that the submitted rows match what you approved are plain code, because a model should never
decide the numbers or the content of what ends up in your timesheet.

---

## 5. UI design

### 5.1 Main window

```
┌────────────────────────────┬──────────────────────────────────────────────────────────────────────┐
│ + New session              │ ARIA                                                    2 need you │
│ ● ARIA                 2 ├──────────────────────────────────────────────────────────────────────┤
│   My work                  │ You     add dark mode to GerbilBreederTracker, draft PR when done    │
│   Automations              │ ARIA  On it. Started "Dark mode toggle" (Default · medium).        │
│   Time                6h30 │ ┌ Task · Dark mode toggle · GerbilBreederTracker ───────── waiting ┐ │
│   Customize                │ │ 6m · Default · medium · 0.4 credits                [Open] [Stop] │ │
│   Search                   │ └──────────────────────────────────────────────────────────────────┘ │
│                            │ ┌ ? Dark mode toggle needs you ─────────────────────────── waiting ┐ │
│ PROJECTS                 + │ │ Should the toggle live in Settings or in the header?             │ │
│ ▾ GerbilBreederTracker   ● │ │ [Settings]  [Header]  [Reply…]                                   │ │
│     ? Dark mode toggle     │ └──────────────────────────────────────────────────────────────────┘ │
│     ✓ README cleanup       │ ┌ ✓ CI · Moonrise · deploy.yml #482 ────────────────────── success ┐ │
│ ▾ Moonrise               ▶ │ │ Finished in 4m12s                                     [Open run] │ │
│     ▶ Refactor scoring     │ └──────────────────────────────────────────────────────────────────┘ │
│     ◌ Update dependencies  │                                                                      │
│     ◷ CI · deploy.yml #482 │                                                                      │
│ ▸ StarHarvester            │                                                                      │
│ ▸ Garden Castle Defense    │                                                                      │
│ ▸ Lantern Orchards         ├──────────────────────────────────────────────────────────────────────┤
│   Show 2 more…             │ ↩ replying to: Dark mode toggle   ✕                                  │
│                            │ [ Ask ARIA anything…                                 (mic) (send) ]│
└────────────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (left): the Copilot-app-style navigation, with each project's sessions underneath.
  See §5.2.
- **Chat** (center): the one conversation with ARIA. Everything that needs you lands here.
- **"2 need you" badge**: the number of blocking items. Clicking it jumps to the oldest one.
- **Live strip**: when the sidebar is collapsed, a row of small chips at the top of the chat
  shows active tasks and watches at a glance. Clicking a chip scrolls to its card.

### 5.2 Sessions sidebar

A collapsible left sidebar (`Ctrl+B`) built the same way as the GitHub Copilot app's: a few
top-level items, then **Projects**, each with its own sessions underneath. You never *need* it,
because everything that needs you still shows up in the chat. It's there for when you want to look
inside or start something yourself.

**Top-level items, mapped from the Copilot app**

| Copilot app | ARIA | What it does |
|---|---|---|
| New | **+ New session** | Start a task yourself: pick a project, profile, mode and brief. It skips ARIA (no Conductor cost) but still reports back into the chat. |
| Chats | **ARIA** (pinned, with a "needs you" count) | Your one conversation. It replaces the Copilot app's separate chats. |
| My work | **My work** | GitHub issues, PRs and CI status across your projects, fed by the watchers (§4.6). Your task tracker's tasks join it in Phase 7 (native MCP). Opens in the right-hand pane. |
| Automations | **Automations** | Your routines and reminders: enable/disable, next run, last result, Run now. |
| — | **Time** (ARIA only) | Day and week view of timesheet drafts and registered time, the activity behind each entry, and your mapping rules (§4.14). Shows today's total. |
| Customize | **Customize** | Models and worker profiles (§4.12), integrations with their scopes and tool rules (§4.13), prompts, permission policy, skills, memory. |
| Search | **Search** | Search across session transcripts, tasks and projects. |
| Projects | **Projects** | One entry per repo, with that repo's sessions underneath (below). |

**Projects (one per repo)**

- The list comes from the repo registry (§4.9). On first run it's filled by scanning
  `~\Documents\GitHub`. The **+** next to *Projects* adds more, with the same three options as the
  Copilot app: **Local folder or repository**, **GitHub repository** (clone), and
  **Repository URL**.
- Each project row shows a red dot if one of its sessions needs you and a spinner if one is
  running. Projects with activity expand automatically and move to the top; pinned projects stay
  where you put them.
- Hovering a project shows a **+** to start a new session in that repo. That opens the same
  dialog as *+ New session*, with the project already filled in.
- Right-click a project: **Ask ARIA about this project** (puts "About Moonrise: " in the chat box; `@` names a
  task, §4.5), **Open in VS Code**, **Open on GitHub**, **Watch default-branch CI** (toggle),
  **Project settings** (default worker profile, base branch, test/build commands), **Pin**,
  **Hide**.
- Projects without sessions stay collapsed, and inactive or hidden ones sit behind
  "Show n more…".

**Sessions under a project**

- Sorted by what matters: **needs you**, **running**, **queued**, **watching** (that repo's CI and
  PR watches), then **done · review**. Finished and archived sessions sit behind
  "Show older (n)".
- Each row shows a state icon (`?` needs you, `▶` running, `◌` queued, `◷` watching, `✓` done,
  `✗` failed), the title, and a cloud badge for cloud tasks. Hovering shows profile · effort,
  elapsed time and cost.
- Clicking a row opens the session view (§5.3). Right-click: **Open**, **Stop**, **Rename**,
  **Archive**, **Open worktree in VS Code**.
- Sessions you start yourself and sessions ARIA starts appear the same way, so you always find a
  piece of work under the repo it belongs to.

Whether the sidebar is open, and which projects are expanded, is remembered.

### 5.3 Session view and flow tuning

Clicking a session in the sidebar opens it in a pane to the right of the ARIA chat. The chat
stays visible, and a button makes the pane full width. It shows exactly what that session saw and
did:

```
┌─ Dark mode toggle · GerbilBreederTracker ───────────────────── waiting ┐
│ Profile [Default ▾]   Model [Claude Sonnet ▾]   Effort [medium ▾]      │
│ autopilot · aria/dark-mode-toggle · 6m · 0.4 credits                 │
│ [Diff]  [Open in VS Code]  [Terminal here]  [Stop]                     │
├────────────────────────────────────────────────────────────────────────┤
│ ▾ Brief from ARIA                                                    │
│   Add a dark mode toggle to the app. Run the tests before finishing.   │
│ Assistant  I'll add a ThemeProvider and a toggle component.            │
│ ▸ read   src/App.tsx                                       auto · 0.1s │
│ ▸ edit   src/theme.ts  (+42 −3)                            auto · 0.2s │
│ ▸ shell  npm test                                         auto · 12.4s │
│ ? Should the toggle live in Settings or in the header?                 │
│   → Header  (you, from the ARIA chat)                                │
│ Assistant  Moving the toggle into Header.tsx…                          │
├────────────────────────────────────────────────────────────────────────┤
│ Message this session…                            [Steer now ▾]  (send) │
└────────────────────────────────────────────────────────────────────────┘
```

- **The brief** ARIA sent (expandable), so you can judge whether ARIA delegated well.
- Assistant messages, reasoning (collapsed), and every tool call with its arguments, output,
  duration, and whether the policy auto-approved it or you did.
- Questions and how they were answered (button, reply-to, or through ARIA).
- **Header**: profile, model and effort (changeable mid-task), mode, branch, elapsed time, cost,
  and buttons for **Diff**, **Open in VS Code**, **Terminal here** and **Stop**.
- **Message this session directly**: "Steer now" (`mode: "immediate"`) or "Queue"
  (`mode: "enqueue"`). ARIA hears about it through its `<updates>` digest.

The **ARIA** row in the sidebar is your one conversation (§5.2), so clicking it shows the chat. Its **Inspect**
button (also in the chat header) opens the Conductor's inspector in the session view: each of your messages as sent,
with the `<updates>`/`<pending>` block that went with it, the tools ARIA called with their arguments, results and
time, and its answer. That's where you see *why* ARIA did something.

**Improving the flow.** The session view is also where you fix what you saw:

- **Edit prompts**: the Conductor's system prompt, the worker brief template and per-profile
  instructions are editable in Customize › Prompts, with version history and a diff so you can roll
  back.
- **Always allow this**: on a tool call, turns that approval into a permission rule.
- **Save as memory**: turns a correction ("Moonrise uses pnpm") into a memory fact, so future
  briefs include it.
- **Rerun with…** (later): rerun a finished task's brief in a fresh worktree with a different
  prompt or profile, to compare the results side by side.

Live content comes from `session.on(…)`. After a restart, history comes from `session.getEvents()`
(Phase 0: it holds messages, tool calls with arguments and results, and permission decisions; usage and deltas
are not kept, so ARIA stores cost itself).

### 5.4 Card types

| Card | Content | Actions |
|---|---|---|
| Task (updates in place) | Title, repo, state, current intent, elapsed time, profile · effort, cost | Open, Stop |
| Question | The task's question, choices if provided | Choice buttons, Reply |
| Permission | What it wants to run or write, and where | Approve once, Approve for task, and for a safe sandbox block Always allow this exact path/host, or Reject (with note) |
| Plan | Summary + expandable plan | Approve, Revise, Cancel |
| Profile proposal (policy 3) | Suggested profile, model, effort, and why | Start, Change profile |
| Done | Summary, files changed (+/−), test result | View diff, Open PR, Continue, Discard |
| Failed | Error and last message | Retry, Open, Discard |
| CI | Workflow, run number, duration, result | Open run, Fix it (on failure) |
| PR | Review received / checks done / merged | Open PR, Address comments |
| Model warning | A session switched to a model you didn't choose | Switch back, Accept |
| Timesheet draft | Day, total against expected hours, gaps, uncertain rows, editable rows with their sources | Submit, Edit, Open in Time view |
| Time registered | Entries registered or failed, with tracker ids | Open in Time view, Retry failed |
| Action request | A mail, Teams post, meeting reply or tracker task ARIA wants to send or create, shown exactly as it will go out | Send, Edit, Cancel |
| Tracker update (Phase 7) | New task assigned to you, a status change, or a new comment on one of your tasks | Open task, Ask ARIA |
| Digest | Morning brief or "while you were away" | Expand |
| Reminder | Your reminder | Snooze, Done |

"Open" on any card opens that session in the session view.

### 5.5 Small touches that make it feel like ARIA

- **Morning brief**: on the first open of the day (or at a scheduled time), a digest card:
  "Overnight: PR #37 got 2 comments, CI failed on Moonrise main, cloud task X finished."
- **"While you were away"**: after 15 minutes or more away (configurable), one summary card on your return: what
  finished, what failed and what needs you, each line linking to its own card (those stay, D24).
- **Quick prompt bar** from anywhere (global hotkey).
- **Push-to-talk** (later): hold a hotkey, speak, release. Use local `whisper.cpp` or a cloud
  speech-to-text API. (The browser's built-in speech recognition doesn't work in Electron.)
- **Slash commands**: `/status`, `/tasks`, `/watch`, `/focus`, `/pause-all`, `/budget`.

---

## 6. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Agent runtime | `@github/copilot-sdk` (Node), pinned to 1.0.22 (bundled runtime 1.0.98) since Phase 0 | Official; bundles the Copilot CLI |
| Desktop shell | Electron 44 + `electron-vite` 6 | Node main process runs the SDK directly (Electron 44 embeds Node 24.22) |
| UI | React 19 + TypeScript + Tailwind v4 + `lucide-react`; shadcn/ui when its components are needed | Fast to build, good components. Phase 1 needed only plain Tailwind. |
| UI state | Zustand | Simple and fast for a streaming timeline |
| Markdown | `react-markdown` + `shiki` | Assistant messages and code |
| Diffs | Monaco diff editor (or `react-diff-view`) | Diff tab in the session view |
| Layout | `react-resizable-panels` | Sidebar · chat · session view panes |
| Database | SQLite via the built-in `node:sqlite` (`DatabaseSync`), plain SQL, append-only migrations tracked with `PRAGMA user_version` | Local, fast, zero setup. Changed from better-sqlite3 + Drizzle in Phase 1: Node 24 and Electron 44 both ship `node:sqlite`, so there is no native module to rebuild per Electron ABI, and tests and app use the same driver. |
| GitHub API | `@octokit/rest` + throttling/retry plugins | Watchers, PRs, logs |
| Git | `execa` calling `git` | Worktrees, branches, diff stats |
| Validation | `zod` | Tool parameters and IPC contracts |
| MCP client (Phase 7) | `@modelcontextprotocol/sdk` | ARIA's own exact calls to MCP servers (tracker submit, watcher, action cards). Not in the first draft. |
| Dates and time zones | Built-in `Intl.DateTimeFormat` two-pass solver (`timekeeper/checks.ts`) | Daylight-saving-safe timesheet math across IANA and Windows time zones (D59), with zero external dependency |
| Scheduling | `croner` | Routines and reminders |
| Packaging | `electron-builder` | Windows installer, auto-update later |
| Tests | Vitest (core, with fake runtime), Playwright for Electron (UI) | Phase 1's E2E runs against the real runtime; the live MCP read check is opt-in (§0.6) |

---

## 7. Project structure

```
ARIA\
├─ apps/
│  └─ desktop/                 Electron shell
│     ├─ main/                 window, tray, hotkey, notifications, starts core
│     ├─ preload/              typed IPC bridge
│     └─ renderer/             chat, cards, sessions sidebar, session view, settings
│                              (models, profiles, prompts, policy)
├─ packages/
│  ├─ core/                    UI-agnostic engine
│  │  ├─ runtime/              AgentRuntime adapter over @github/copilot-sdk (+ fake for tests)
│  │  ├─ conductor/            system prompt, tools, <updates> injection
│  │  ├─ tasks/                task manager, state machine, worktrees, queue
│  │  ├─ watchers/             GitHub pollers (runs, PRs, notifications)
│  │  ├─ attention/            normalize, prioritize, coalesce, route replies
│  │  ├─ policy/               permission rules
│  │  ├─ models/               model list, worker profiles, profile policy, auto-tier off
│  │  ├─ prompts/              versioned Conductor prompt, brief template, profile instructions
│  │  ├─ integrations/         reads the Copilot CLI setup, scopes per session, tool rules,
│  │  │                        exact-payload check (Phase 7: own config + native MCP client)
│  │  ├─ timekeeper/           activity collectors, Timekeeper session, mapping rules, checks
│  │  ├─ memory/               repo registry, facts
│  │  ├─ scheduler/            reminders, routines, morning brief
│  │  └─ store/                SQLite schema + queries
│  └─ protocol/                shared types for UI ↔ core (zod schemas)
├─ spike/                      Phase 0 test scripts
├─ docs/
│  └─ spike-notes.md           answers to the §11 checklist
└─ PLAN.md                     this plan
```

As built in Phase 1, each package keeps its code under `src/` (`apps/desktop/src/{main,preload,renderer}`,
`packages/core/src/{runtime,conductor,integrations,memory,store,util}`, `packages/protocol/src`), with tests in
`packages/core/test`, `apps/desktop/test` (renderer units) and `apps/desktop/e2e`. Phase 2 added `packages/core/src/tasks`
(task manager, worktrees, worker policy, profiles, brief), Phase 3 added `attention`, `policy` and `prompts`, Phase 4
added `github` and `watchers`, Phase 5A added `integrations/actions.ts`, Phase 5B added
`timekeeper/{links,rules,collectors}.ts`, Phases 5C–5D added `timekeeper/{scope,checks,session}.ts` and `TimeView.tsx`,
and Phase 6A–6D added `search/search.ts`, `scheduler/scheduler.ts`, `conductor/slash.ts`, `voice/voice.ts`,
`SearchView.tsx`, `AutomationsView.tsx`, and `QuickPromptBar.tsx`;
the remaining core folders arrive with their phases.

---

## 8. Data model (SQLite)

| Table | Key columns |
|---|---|
| `repos` (Projects) | id, name, path, owner, repo, default_branch, test_cmd, build_cmd, watched, default_profile_id, added_via (scan/local/github/url), pinned, hidden, sort_order, expanded. Phase 1 has name through default_branch, added_via, pinned, hidden and sort_order, plus path_key (one row per folder, compared case-insensitively like Windows); the rest arrive with their features. |
| `tasks` | id, title, repo_id, slug, branch, worktree_path, location (local/cloud), session_id, profile_id, model, reasoning_effort, profile_chosen_by (you/aria), tracker_task_id, mode, state, summary, files_changed, additions, deletions, pr_number, cost, outbox (messages it hasn't got yet), archived, created_at, updated_at. Phase 2 keeps id, repo_id, state, archived and the times as columns and the rest as JSON (`data_json`), so later fields need no migration. |
| `model_profiles` | id, name, description (when to use), model, reasoning_effort, provider_json (BYOK, optional), default_mode, extra_instructions, budget, is_default. Built in Phase 2 as `profiles` (id, unique lowercased name, sort order, JSON); the default profile is a setting. |
| `prompt_versions` | id, kind (conductor/brief/profile), profile_id, content, note, created_at, active |
| `requests` | id, task_id, kind (question/permission/plan/budget), payload_json, state (pending/resolved), resolution_json, created_at |
| `watches` | id, kind (run/pr/branch/inbox), target_json, until, etag, last_state, next_poll_at, created_by_task_id |
| `timeline` | id, kind (chat/notice/card), content_json, created_at, updated_at. Phase 1 stores chat messages and notices; ref_kind and ref_id arrive with task cards in Phase 2. |
| `memory` | id, scope (global/repo), repo_id, text, created_at |
| `routines` | id, cron, prompt, enabled, last_run_at |
| `integrations` | id, name, kind (plugin/mcp), source (imported from CLI / added in ARIA), config_json, status, scopes (conductor/worker/timekeeper), keep_in_sync |
| `integration_tool_rules` | integration_id, tool_name, class (read/write/destructive/unrestricted), scope, rule (auto/ask/never) |
| `activities` | id, source (github/git/aria/calendar/teams/mail/tracker), kind, started_at, ended_at, repo_id, external_id, title, linked_tracker_task_id, metadata_json |
| `time_rules` | id, match_json (source + pattern), tracker_task_id, created_from (you/correction), enabled |
| `tracker_tasks_cache` | task_id, title, project_id, customer_id, status, last_seen_json, fetched_at (filled by the Timekeeper; from Phase 7 also used by the watcher's diff) |
| `timesheet_entries` | id, date, start, end, minutes, tracker_task_id, tracker_project_id, tracker_customer_id, comment, sources_json, mapped_by (link/rule/suggestion/you), confidence, state (draft/approved/submitted/failed), tracker_entry_id, error |
| `settings` | key, value_json (includes Conductor, utility and Timekeeper model + effort, profile policy, expected hours per day, rounding, timesheet time, sidebar state) |

---

## 9. Code sketches

> These sketches follow the documented SDK API, but the SDK is in technical preview. Check field
> names against the current `nodejs/README.md` during Phase 0.

### 9.1 Client and Conductor

```ts
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const client = new CopilotClient({ useLoggedInUser: true });
await client.start();

const conductorConfig = {
  model: settings.conductor.model,                     // your choice, from Customize › Models
  reasoningEffort: settings.conductor.reasoningEffort, // your choice
  streaming: true,
  infiniteSessions: { enabled: true },
  systemMessage: { mode: "append", content: renderConductorPrompt(prompts.active("conductor"), memory) },
  tools: conductorTools,                       // start_task, list_tasks, …
  onPermissionRequest: conductorPolicy,        // rejects "write" and "shell"
};

const conductor = (await sessionExists("conductor"))
  ? await client.resumeSession("conductor", conductorConfig)
  : await client.createSession({ sessionId: "conductor", ...conductorConfig });

conductor.on((event) => timeline.handleConductorEvent(event));

// Changing the Conductor's model or effort in settings applies from the next message:
settings.onChange("conductor", ({ model, reasoningEffort }) =>
  conductor.setModel(model, { reasoningEffort }));  // verified in Phase 0: applies from the next turn
```

### 9.2 A Conductor tool

```ts
// Rebuilt (and pushed with session.setTools) whenever you edit your profiles.
const makeStartTask = (profiles: Profile[]) => defineTool("start_task", {
  description:
    "Start a background task in its own git worktree. Use this for anything that edits code, " +
    "runs builds or touches git. Returns immediately; results arrive later as cards.",
  parameters: z.object({
    repo: z.string().describe("Repo name from list_repos, e.g. 'Moonrise'"),
    title: z.string().describe("Short task title, 2-6 words"),
    brief: z.string().describe("Complete instructions for the worker, including what done looks like"),
    profile: z.enum(profiles.map((p) => p.name) as [string, ...string[]]).optional()
      .describe("Worker profile. Omit to use the Default profile."),
    mode: z.enum(["interactive", "plan", "autopilot"]).optional()
      .describe("Omit to use the profile's default mode."),
    where: z.enum(["local", "cloud"]).default("local"),
    baseBranch: z.string().optional(),
  }),
  handler: async (args) => {
    // The model policy decides whether the requested profile is allowed (§4.12).
    const profile = modelPolicy.resolveProfile(args.profile, lastUserMessage());
    if (modelPolicy.mode === "ask") {
      await attention.proposeProfile(args, profile);   // task starts after you confirm
      return { state: "awaiting_profile_confirmation", profile: profile.name };
    }
    const task = await tasks.start({ ...args, profile });
    return { taskId: task.id, state: task.state, branch: task.branch, profile: profile.name };
  },
});
```

### 9.3 Starting a worker

```ts
async function runLocalTask(task: Task) {
  const wt = await worktrees.create(task.repo, task.slug, task.baseBranch);

  const session = await client.createSession({
    model: task.profile.model,                       // always from one of your profiles
    reasoningEffort: task.profile.reasoningEffort,
    streaming: true,
    workingDirectory: wt.path,
    disabledMcpServers: scopes.disabledServers("worker"),       // §4.13: servers outside the scope
    availableTools: scopes.exactTools("worker"),                // exact names only, no patterns
    onPermissionRequest: (req) => policy.decide(task, req),     // may wait on a UI click
    onUserInputRequest: (req) => attention.askUser(task, req),  // resolves when you answer
    onExitPlanModeRequest: (req) => attention.askPlan(task, req),
    onAutoModeSwitchRequest: () => "no",                        // never switch models on a rate limit
  });
  if (task.mode !== "interactive") await session.rpc.mode.set({ mode: task.mode }); // not a session option

  await store.tasks.update(task.id, { sessionId: session.sessionId, state: "running" });
  session.on((event) => taskEvents.handle(task.id, event));     // → state machine → attention
  //                                                             → sidebar + session view
  await session.send({ prompt: renderWorkerBrief(prompts.active("brief"), task) });
}

// "Message this session directly" from the session view:
async function messageSession(taskId: string, text: string, steer: boolean) {
  const session = sessions.get(taskId);
  await session.send({ prompt: text, mode: steer ? "immediate" : "enqueue" });
  attention.noteDirectMessage(taskId, text);   // shows up in ARIA's next <updates> digest
}
```

### 9.4 Conductor system prompt (draft)

```
You are ARIA, a personal engineering assistant running on the user's Windows PC.
You are the single point of contact: the user talks only to you.

How you work
- You never edit files, run builds or use git yourself. For anything that changes code,
  call start_task with a complete brief. You may read files and query GitHub to answer questions.
- Resolve repos with list_repos. If the repo is ambiguous, ask one short question.
- Each user message may begin with an <updates> block listing what happened since they last
  spoke, plus <pending> questions and approvals. Mention only what's relevant; the user already
  saw cards for these. If the user's message answers a pending item, resolve it with the right
  tool instead of starting new work.
- Confirm with the user before: pushing to a default branch, merging, deleting branches,
  working outside a task worktree, or exceeding the budget.
- Models: {{profilePolicyRule}}
  (policy 1: "Use the Default profile unless the user names a profile in their message."
   policy 2: "Pick one of the profiles from list_profiles and state which one and why."
   policy 3: "Propose a profile; the user confirms before the task starts.")
  Never suggest or use a model that isn't in one of the user's profiles.
- The user can also message a session directly from the sidebar. Those messages appear in
  <updates>; don't contradict them.

How you talk
- Short. Lead with the outcome. Use task titles, never internal ids.
- After starting work, say what you started in one line. Don't narrate progress; cards do that.

What you know about the user
{{memory}}
```

### 9.5 Worker brief template

```
Task: {{title}}
Repo: {{repo}} · working in a dedicated worktree on branch {{branch}} (base: {{base}})

Goal
{{brief}}

{{profileInstructions}}

Rules
- Stay inside this worktree.
- Run the project's tests ({{testCmd}}) before finishing. Fix failures you caused.
- Commit your work with a clear message. Do not push unless the brief says so.
- If something is genuinely ambiguous, ask one concise question; otherwise make a sensible choice
  and mention it in your summary.

When done
End with a 2–3 line summary: what changed, test results, and anything the user should check.
```

---

## 10. Roadmap

Sizes: **S** ≈ a few days, **M** ≈ 1–2 weeks, **L** ≈ 2–4 weeks of evenings for one developer
working with AI help.

**Where things stand (2026-10-22)**

| Phase | State |
| --- | --- |
| 0 Spike and verify | Done 2026-10-16 |
| 1 The one chat | Done 2026-10-16 |
| 2 Background tasks | Done 2026-10-16 |
| 3 Part A: ARIA in the loop | Done 2026-10-17 |
| 3 Part B: flow tuning | Done 2026-10-19 (decisions D22–D34) |
| 4 GitHub awareness | Done 2026-10-21 (decisions D36–D53) |
| 5A Approved writes and action cards (D19, D22) | Done 2026-10-22 (decisions D54–D56) |
| 5B Activity collectors, task linking and mapping rules | Done 2026-10-23 (decisions D57–D58) |
| 5C Timekeeper session and timesheet draft card | Done 2026-10-23 (decisions D59–D60) |
| 5D Time view and tracker Submit, Update and Delete | Done 2026-10-23 (decisions D61–D62) |
| 6A Conductor memory and Search | Done 2026-10-23 (decisions D63–D64) |
| 6B Automations, reminders and morning brief | Done 2026-10-23 (decisions D65–D66) |
| 6C Quick prompt bar, slash commands and "Rerun with…" | Done 2026-10-23 (decisions D67–D68) |
| 6D Voice | Done 2026-10-26 (decisions D69–D70) |
| 7A Native MCP configuration and built-in client | Done 2026-10-26 (decisions D8, D10, D16, D19, D22, D30–D35) |
| 7B Task tracker watcher and My work integration | Done 2026-10-26 (decisions D3, D8, D10, D19, D22, D24, D25, D34, D36–D40, D60) |
| 8A Cloud tasks and remote sessions | Done 2026-10-26 (decisions D71–D72) |
| 8B Phone notifications and two-way relay | Done 2026-10-26 (decisions D73–D74) |
| 9 Hardening | Done 2026-10-27 (decisions D75–D78) |

After Part B's own commit came three more: Part B's UX review fixes, Part B checked against the real runtime (six
fixes, D35, spikes 13–16), and fix 6, the lock and unlock toasts.

### Phase 0: Spike and verify (S)

**Status: done 2026-10-16.** Answers in `docs/spike-notes.md`, scripts in `spike/`. Decisions taken with the user
afterwards: D15 (refusal fallback: detect + warning card) and D16 (failed submit: show the full response). Deferred:
#6 budget exhaustion (Phase 2), #15 cloud tasks (Phase 8).
A plain Node script in `spike/` inside the project folder, no UI. Use recorded fixtures or a mock MCP server for
any write tool (§0.4).
- Create a client and session, stream events to the console, and use a custom tool.
- Run two worker sessions in parallel in two worktrees on one client.
- Trigger and handle a permission request, a user-input request and plan mode.
- Resume a session after killing the process.
- Read `assistant.usage` and `account.getQuota` to learn what a typical task costs.
- List the available models with their effort levels; set model + effort when creating a session
  and change them mid-session; check what auto tier does.
- **Done when** every item in §11 has an answer, written down in `docs/spike-notes.md`.

### Phase 1: The one chat (M)

**Status: done 2026-10-16.** Built as planned, with SQLite through `node:sqlite` (§6). Verified by Vitest (engine,
store, scope and policy with the fake runtime; the renderer's store and Markdown) and a Playwright E2E against the real
runtime (`npm run e2e:real`, §0.6; `npm run e2e` runs the scripted specs only): ARIA answers from `list_repos`, the app is closed
and reopened, the same conversation continues, and a model
picked in Customize › Models is used for the next answer. An opt-in E2E (`ARIA_E2E_MCP=1`, §0.6) lets ARIA read from your task
tracker and checks in the session's event log that it called read tools only. Answers never load images (an image URL could leak data
without a click), so the window's CSP allows no remote images. Left for later on purpose: **New session** is shown but
disabled until Phase 2, and closing the window quits the app until the tray arrives (Phase 2, with the tray dot).
- Electron shell with resizable panes, React chat with streaming markdown, SQLite timeline.
- Conductor session with the persona, `infiniteSessions`, and resume on restart.
- **Customize › Models**: the Conductor's model + effort, filled from the runtime's model list,
  with the price category and token prices shown.
- Sidebar skeleton in the Copilot app's structure: ARIA pinned, **Customize** (models), and
  **Projects** from the repo registry with **+ Add project** (`Ctrl+B` to collapse).
- Repo registry (scan `~\Documents\GitHub`) and the `list_repos` tool.
- The Conductor can use your existing Copilot CLI plugins and MCP servers for reading, limited to its scope with
  `disabledMcpServers` and an exact `availableTools` list of read tools (Phase 0 showed both work). MCP write tools
  are left out of that list, and the permission handler rejects them as a backstop, until the policy engine and
  action cards land in Phase 3.
- **Done when** you can chat with ARIA about your repos using the model and effort you picked,
  close the app, and come back to the same conversation.

### Phase 2: Background tasks (L)

**Status: done 2026-10-16.** Built as planned, with:

- D17 (worker questions on a card) and D18 (lockfile installs).
- A fixed worker policy that refuses, with feedback, everything §4.8 marks "ask" until Phase 3.
- Each worker pinned to its profile's model: `allowedModels`, updated with `setAllowedModels` on a mid-task switch. Its
  sub-agents are pinned with `updateSubagentSettings`.
- A per-task budget that pauses the task. The runtime's session limit (30 credits minimum) isn't used.
- Messages for a task that isn't running yet (queued, paused at its budget, Continue, Retry) kept in a per-task outbox
  in the database, so a restart doesn't lose them. Each task's session work (a run, a message, a cancel, a cleanup)
  runs one step at a time; a cancelled or replaced run stops sending, and a session that should be quiet but starts
  work anyway is stopped again. A task whose session is gone (deleted, lost by the runtime) gets its brief again.
- The shell policy checks each argument the way PowerShell passes it (quotes removed, typographic dashes read as `-`,
  a leading `~` expanded): no option that moves a tool's target, no path outside the worktree or into its `.git` link
  (also under the names Windows gives it: `.git.`, `GIT~1`), and New-Item only makes files and folders (it takes
  `-it j` as a junction).
- Quitting waits up to 10 s for a worktree being made or a message being sent, so neither is left half-done, and
  never hangs on a session that doesn't answer.

Verified by:

- Vitest: the task manager on a scripted fake runtime with real git repos, plus worktrees, the worker policy and
  profiles, and its races (cancel while the brief is on its way, discard while queued, a settle that sees new work, a
  model switch while the session opens, a restart with queued messages, a shutdown that doesn't hang). Each race fix
  fails its test when reverted.
- A Playwright E2E against the real runtime. A real worker added a function and its test, ran `npm test` and
  committed on its `aria/` branch in about 10 s for 0.33 credits, while the chat answered something else. The Done
  card had the diff, and the session view showed every step.
- A scripted UI E2E (`ARIA_FAKE_RUNTIME`) for the question (answered in the session view), budget, failed,
  interrupted and Discard flows, Continue from a Done card, and Escape for the dialog and the session view.
- A code review (GPT-6.1-sol, five rounds until it found nothing significant) and a UX review (Gemini, two rounds)
  of the whole phase.

Left for later on purpose:

- Plan mode, the permission, plan and profile-proposal cards, the "Ask me" profile policy, and the `<updates>` digest:
  Phase 3.
- Open PR: Phase 3/4.
- Running the project's tests from ARIA's own code: needs per-project test commands.

Known limits:

- The worker policy isn't a sandbox: an allowed `npm test` runs whatever code the task wrote (Phase 0). Since Phase 3,
  workers run in the runtime's sandbox where the PC supports it (D20).
- A short option's value attached to other option letters (`git grep -fconfig/x`) is refused, since it can't be told
  from more option letters; the refusal tells the worker to write it apart (`-f config/x`).
- A runtime that stops answering: Stop and Discard still finish (each call waits at most 10 s, each step at most a
  minute), and the session isn't reopened until its abort or detach has settled; a Continue meanwhile fails with
  "can't be reopened safely yet" and can be retried.
- `allowedModels` holds a worker to its model, so a refusal fallback may fail a turn instead of switching models; a
  switch the runtime makes anyway shows a warning (D15).
- Windows toasts, the tray dot and the taskbar overlay aren't covered by a test (the E2E runs check the in-app
  "needs you" badge); toasts from the unpackaged app may need a Start Menu shortcut.

The plan for this phase:

- Task manager, worktree manager, state machine, queue (limit 3).
- `start_task`, `list_tasks`, `get_task`, `message_task`, `cancel_task`, `cleanup_task`.
- **Worker profiles** and the profile policy (§4.12), `list_profiles`, auto tier off, model
  warning card.
- Task cards that update in place; live strip when the sidebar is collapsed.
- **Sessions sidebar** with sessions listed under their project (sorted by state), the per-project
  **+** and **+ New session** dialog, and the **session view**: full transcript, model/effort
  switcher, diff tab, and direct messages (steer or queue).
- Done and failed cards, Windows toasts, tray dot.
- **Done when** "add X to repo Y" produces a committed branch and a Done card with a diff, using the
  profile you chose, while you keep chatting about something else, and you can open that session
  from the sidebar and read every step it took.

### Phase 3: Attention loop and flow tuning (M)

**Status: done 2026-10-19.** Part A (ARIA in the loop) done 2026-10-17; Part B (flow tuning) done
2026-10-19 with D22–D34, committed as "Phase 3 Part B: flow tuning".
Part A, built with D19–D21:

- Tasks wait on you for a question (Q-1), a permission request (P-1) or a plan (L-1), and a budget pause is B-1. Each
  has a card with buttons in the chat and a bar in its session view. The short ids name the item in a message; they
  start at 1 again each time ARIA starts. A task that waits keeps its place among the three that run at once.
- Four ways to answer from the one chat: a button on the card; **Reply** on a task, question or Done card (a badge
  above the box says where the message goes, and it goes straight to the task); `@task-name` with completion; or
  plain words to ARIA, which sees what's pending in its `<updates>` digest and answers by id. ARIA can approve a
  permission, a plan or more budget only when your own message names its id, so text from a task can't get anything
  approved. Permission and plan cards have no Reply, so a reply can't become a decision.
- The worker policy engine (§4.8): your rules (auto, ask or never; the most specific wins, the strictest among equals)
  on top of fixed ones (no push to the default branch, no destructive push, no merging pull requests, and a sandboxed
  task doesn't push at all). The fixed ones:
  - read each command of a line the way Windows PowerShell 5.1 passes it (quotes, backtick escapes, comments,
    redirections, empty arguments, `;`, `|` and line breaks, also where the runtime didn't split them), and refuse a
    git or gh command whose words PowerShell computes when it runs (`$x`, `(…)`, `@x`, `a, b`, `--%`);
  - read git push's options the way git does, and find gh's command the way gh (cobra) does, flags between its words
    too;
  - follow git aliases (yours, the repository's, ones defined in the command or by an alias, chains, shell aliases)
    and gh aliases (also of several words, with `$1` arguments, and only the ones gh itself would use), each split
    the way git or gh splits them; a git word that's neither one of git's own commands nor an alias is a `git-<name>`
    program (git-flow, git-town), which could push, and is refused, also an alias run in another repository;
  - know which branch a push without a refspec pushes, also through git's push settings (`push.default`,
    `remote.<name>.push`, a mirroring remote);
  - and refuse what they can't see through, or what would change what they read: a push or a merge run by another
    program (`cmd /c`, `pwsh -Command`, `Start-Process`, `node -e`) or by git itself (`rebase -x`, `bisect run`,
    `submodule foreach`, a `-c` setting that names a program), a program written as an expression, a gh extension,
    `gh api` calls that merge or change branches, an alias that loops, a gh config ARIA can't read with certainty,
    changes to git's aliases or push settings, to the environment git and gh read, and a push after changing folders
    in the same command.

  Your rules see a command both ways too (Windows PowerShell 5.1 leaves an empty argument out, PowerShell 7 passes it
  on), and the stricter reading counts. In the sandbox everything else runs without asking, except files outside the
  worktree and web pages, which are refused. Without it, tasks keep the Phase 2 allowlist and ask for the rest.
- Workers in the runtime's sandbox (D20), shown as Sandboxed or Not sandboxed in the session view, with the task's
  "Approve for this task" grants (D21) and Revoke. The runtime's automatic dev-tool grants are off (they'd make some
  of your caches writable); the toolchains are granted read-only instead, and ARIA's own git calls on a worktree
  can't be made to run a program from it.
- The `<updates>` digest: what finished, failed or paused, and what you did on a card, since your last message. It
  goes with your next message and is stored with it.
- Plan mode for tasks (New session and profiles). `exit_plan_mode` had to join the worker's tool allowlist (spike 12).
- The "Ask me" profile policy: ARIA proposes a task on a card, and nothing runs until you press Start with the
  profile you pick.
- Customize › Prompts: ARIA's prompt, the brief template and each profile's instructions, with versions, a diff,
  rollback and reset. An edited ARIA prompt reopens the same conversation (spike 11). Customize › Permissions: the
  sandbox's state and switch, the rules, and the allowed hosts.

Part A verified by:

- Vitest (479 core tests, 10 desktop): the policy engine and its bypass attempts, grants, waiting states against
  cancel, budget, failure and shutdown, the digest, reply routing, the id guard, proposals and prompt versions. Each
  round of review fixes had a mutation run (over 200 mutations in all), each caught by the test meant for it.
- Probes with the real runtime: the sandbox (spike 10), a changed prompt on resume (11), plan mode with approve and
  revise in the sandbox (12). Probes of Windows PowerShell 5.1, PowerShell 7.6, git 2.53 and gh 2.102 for how they
  read a command line.
- A scripted UI E2E for the done-when: three tasks ask at once and are answered by a button, a reply and through
  ARIA; a permission approved for the task; a plan; a changed brief template in the next task's brief; a proposal;
  Customize › Permissions. The Phase 1 E2E against the real runtime (during Part A, before the review rounds) and the
  Phase 2 one, now sandboxed: the worker edited, ran `npm test` and committed inside the sandbox (re-run after the last
  policy changes, no step refused).
- A code review (GPT-6.1-sol, 8 rounds, 62 findings fixed, most of them ways around the fixed rules; stopped there at
  your call, with what's left in the known limits) and a UX review (Gemini, 2 rounds).

**Part B (flow tuning): done 2026-10-19.** Designed after Part A, built one item at a time. Constraints as before: no
real writes to the task tracker, Work IQ or GitHub (§0.4), the Conductor stays read-only until the action cards (D19, Phase 5),
Windows first, and a review loop per item (a design round, then code review rounds with a mutation check for each
fix). The four items, in the order they were built:

1. **Conductor inspector** (§5.3). **Inspect** on the ARIA row in the sidebar (the row itself stays your one
   conversation, §5.2) and in the chat header opens the session view in inspector mode: per message of
   yours, the `<updates>`/`<pending>` digest that went with it (already stored with the message), the tools ARIA
   called with their arguments, results and time, and its answer. Read from the Conductor session's own events, like a
   task's transcript. Read-only, no model calls.
2. **Attention** (§4.5, §5.5). A priority per event (blocking: a question, permission, plan, budget pause, failure or
   interrupted tasks; milestone: a task done; info: a task started; noise: transcript only). Nothing toasts while the
   window is in front and focused (D25); when you're away, blocking events always toast (also in Focus mode) and
   milestones toast unless Focus mode is on. **Focus mode** (a toggle in the chat header, kept): only blocking events
   toast. **Coalescing**: Done toasts within 30 s become one ("3 tasks finished"). **While you were away**: after
   15 minutes or more away (configurable), or after Focus mode held something back, one Digest card on return with
   what finished, what failed and what needs you, each line linking to its card. Plain code, no model.
3. **"Always allow this" and "Save as memory"** (§5.3, D23, D26–D29). Always allow: on a decided permission card,
   and on a shell step your Never rule refused (in the session view, found by its tool call), a small form prefilled
   with what ARIA worked out when it decided the command: one **exact** Auto rule per command of the line, for
   sandboxed tasks only when the task was sandboxed (D27), checked by construction (with it, the same request runs
   on its own). Editable, saved to Customize › Permissions through the same save checks (D26). Never for a fixed
   rule's refusal (the same code decides), a destructive command (D28), a command a rule can't name exactly (computed
   words, quotes, an empty argument, a program named by its folder) or, without the sandbox, one that reaches outside
   the worktree; running past your own Never rule needs a confirmation, and your rule stays for everything else. Rule
   notes name no task. Save as memory: only on your own words (your messages to a task and your answers in your own
   words, from the chat, a card or the session view; recorded by the engine, never on ARIA's answers or a picked
   choice), a one-line note (1–300 characters, no control or invisible characters, no `{{` or `}}`, at most 100) for
   the task's project or every project, kept in a `memories` table. Briefs get them through `{{memory}}`, right after
   the goal: the project's notes newest first, then the global ones, at most 30 lines and 3,000 characters, framed as
   the user's notes. Customize › Memory lists, edits and deletes them, marks the ones that don't fit, and says when the
   brief template lacks `{{memory}}`. No tool of ARIA's or a worker's can write one (ARIA gets memory tools in
   Phase 6, D23).
4. **Customize › Integrations, first draft** (§4.13, D22, D30–D34). The servers from your Copilot CLI setup with
   their status and source, found without a model call (Refresh one check at a time, at most every 30 s); Sign in for
   servers that need it (Work IQ), in a short-lived session of its own (`prepareLogin` for an owned installation),
   which opens the sign-in page in the browser (`https:` only; the window sees only its host), with Cancel and Try
   again; every tool seen so far with its class and a rule per scope (ARIA, Tasks), among what its class allows.
   The defaults are the first draft's scopes, so nothing changes until you change a rule. Enforced in both places:
   the session's tool scope (ARIA's conversation reopens before your next message when its own tools changed; a
   task's session when it opens) and the permission handlers, which read your rules on every request and check the
   request itself (the tool's name from the server it names; a write never runs for ARIA, D22). Trying Sign in
   needs your click against the real Work IQ server (a sign-in, no writes).

Your answers to the three questions before Part B (2026-10-17) are decisions D22 (an ARIA write tool is Ask or
Never), D23 (memory facts go into task briefs only) and D24 (coalescing groups only the toasts) in §0.3; D25–D34 came
up while building it.

Part B verified by:

- Vitest: 879 core tests and 46 desktop tests (479 and 10 after Part A), on the fake runtime, no model calls. Among
  them: the inspector against real event shapes through a stand-in SDK client, the attention rules and engine with a
  manual clock, the save checks and offers against every kind of fixed refusal, the classifier on Phase 0's 192 real
  tool names (none changes class), a property test of tool classes × scopes × stored values, and both permission
  handlers with lookups that lie.
- Mutation checks, one per guard, each run against the test meant for it: 55 for item 1, 44 for item 2, 118 for item 3
  and 83 for item 4 (300 runs, re-runs after a target changed included). All ended up caught: a mutation that survived
  got the test it lacked, or showed code with no effect, which was removed.
- The five scripted UI specs (§0.6), all passing after the last fixes: `ui-cards`, `ui-attention` (with the
  inspector), `ui-away`, `ui-flow` and `ui-integrations`.
- Reviews, per item: a design round with a rubber duck (Sonnet) before building, then code review rounds (Opus):
  - Item 1, the inspector: round 1, 8 minor findings and 4 nits, fixed; round 2, 2 nits, fixed.
  - Item 2, attention: round 1, 5 minor findings and 3 nits, fixed; round 2, 1 minor finding, fixed (checked in item
    3's round 1).
  - Item 3, "Always allow this" and "Save as memory": round 1, 1 major and 3 minor findings and the whole-worktree
    question (D29), fixed; round 2, 5 minor findings and 2 nits, fixed; round 3, all confirmed, no new findings.
  - Item 4, Customize › Integrations: round 1, nothing significant: 3 minor findings and 2 nits, fixed (the "after
    the first review" parts of D30, D31 and D33); round 2 reviewed those fixes and found 1 minor finding and 3 nits,
    fixed (arguments that can't be written as JSON are refused, D30; only verb pairs like check in count, D33; the
    reopen check ignores order; a server once seen as GitHub's stays so, D31).
- Against the real runtime: Part B was built and tested on the scripted runtime; the real-runtime checks came after,
  with the Phase 1 and Phase 2 E2E re-run and the real Work IQ Sign in, and are listed under Phase 9 ("Checked with
  the real runtime"), with the six fixes they led to.

Done when (whole phase), checked: two tasks can ask at the same time and be answered from the one chat (`ui-attention`:
three ask at once and are answered by a button, a reply and through ARIA), and a changed brief template shows in
the next task's brief (`ui-attention`; `ui-flow` also checks a saved note in the next brief). The rest of the phase's
plan below is built: the cards, replies and the digest (Part A); coalescing, Focus mode and "while you were away"
(item 2), the inspector (item 1), "Always allow this" and "Save as memory" (item 3), and the first draft of
Customize › Integrations (item 4). One difference from the plan: ARIA's write tools are Ask or Never and Ask works
like Never until the action cards (D22, Phase 5).

Known limits, Part A:

- The sandbox: LAN addresses stay reachable (Windows filtering needs `allowLocalNetwork`; loopback is blocked by
  name), tasks can write the repo's shared object store and the refs of other `aria/` branches, tasks share
  ARIA's caches and temp folder, `git stash` fails, and the shell is Windows PowerShell 5.1. npm warns about the
  `npm_config_store_dir` variable that points pnpm at ARIA's cache (harmless).
- The fixed rules read the command, not the code it runs: a push inside a script the task wrote (an npm script, a
  `.ps1`), code an interpreter or another shell runs (beyond the words push and merge), PowerShell code that builds a
  command or a setting from pieces, or state an earlier command left (a variable, an environment variable or a
  function set in a shell session that stays open) isn't seen. In the sandbox it can't reach GitHub anyway (unless
  you add GitHub to its hosts, which Customize › Permissions warns about); without the sandbox, such a command asks
  you first and the card shows it.
- A git or gh command with text PowerShell computes is refused even when it's harmless (`git commit -m "Fix $x"`):
  the worker is told to write it out. So is a git word that isn't one of git's own commands (as of Git for Windows
  2.53) or an alias: a newer git command needs the list updated.
- "Approve for this task" covers a command exactly as written, so the same command written differently (other
  spacing or quotes, options in another order) asks again.
- A task waiting for you holds one of the three slots, so three waiting tasks hold up the queue.
- Pending questions, permission requests and plans don't survive a restart (the task is interrupted), and short ids
  start again at 1, so an id in older chat can name a newer item.

Known limits, Part B (all four items in one place):

- **Inspector.** Your message and the digest that went with it are joined by exact text, so a message you type that is
  exactly an earlier prompt's digest plus that message is shown split like it. It holds your last 1,000 messages per
  open (older ones say they aren't kept here). ARIA's tool arguments and results are kept up to 20,000 characters,
  workers' up to 4,000, with the cut said below the box. A refusal folds into its tool's row only when the runtime
  links them (`toolCallId`), else it's a row of its own; the real runtime always links them (checked 2026-10-19). After
  a compaction the runtime's `getEvents` keeps everything from before it (checked), so the inspector shows the whole
  history with the compaction's note.
- **Attention.** Real Windows toasts, closing a toast that's already in the Action Center, and Windows' lock, sleep and
  idle reports aren't covered by a test: unit tests use stand-ins, and `ui-away` drives the same code through the test
  hooks. Checked by hand on 2026-10-19: they work, except that Windows drops a toast shown while the screen is locked,
  so nothing toasts while it's locked (Phase 9, gap 6). When you unlock and are still away from ARIA 1.5 s later,
  what still needs you toasts then (a question, permission or plan not answered meanwhile, a failure not retried); an
  unlock back at ARIA toasts nothing, and a Done while locked never toasts (it's in its card and the away card). A
  toast shows at most 250 characters (the card has the rest), and toasts from the unpackaged app may need a Start Menu
  shortcut (Phase 2's limit). That a packaged build ignores the test switches was checked by hand (Phase 9: Electron
  renamed, `isPackaged` true; not yet an installer build), not by a test.
- **"Always allow this".** It offers exact rules only, and an edited rule can be broad only for the test, build, lint,
  format and type-check commands (D26). An Auto rule never matches a program named by its folder (`.\npm.cmd`), which
  asks as before. A task keeps its last 30 offers; a refused step is matched to its offer by the runtime's
  `toolCallId`, else by its command text.
- **Destructive commands (D28, D29).** The destructive class reads commands, not what they do: deleting through code
  an interpreter or a script runs (`node -e "fs.rmSync(…)"`, an npm script), through tools it doesn't know
  (`del-cli`, `trash`), through a list in a file other than git's `--pathspec-from-file` (which counts), a listing
  kept in a variable and removed by a later command, `pwsh -EncodedCommand`, or pathspec magic beyond `:/` and
  `:(top)` isn't seen (`find -delete`, `find -exec`, `xargs` and a recursive listing piped to `Remove-Item` are).
  Neither are git commands that drop history other ways (`git gc --prune=now`, `git reflog expire`,
  `git update-ref -d`) or overwrite files (`Set-Content`, `Move-Item -Force`). In the sandbox they stay inside the
  task's worktree (the stash and refs are shared, D20); without it, such a command asks unless your Auto rule names it
  exactly.
- **Broad Auto rules (D26).** Options that make a test or build tool run another program or target (`go test -exec`,
  `dotnet build -t:<target>`, a runner set with `cargo --config`) run where the command does: on Phase 2's list
  without the sandbox, and under a broad Auto rule for it. Those programs are the project's own tools, which a build
  runs anyway.
- **"Save as memory".** Only on your own words (messages, replies and freeform answers): a task's last 50. At most 100
  notes, and a brief gets at most 30 lines and 3,000 characters of them (the oldest are left out; Customize › Memory
  marks them). ARIA's own prompt gets none until Phase 6 (D23). In a session view, the real runtime's answer reads
  "User selected: …" or "User responded: …"; ARIA takes that off (Phase 9, bug 1), so a runtime that words it
  otherwise would hide the button there (the question's card in the chat still has it).
- **Integrations: classes.** Classes come from names only, and you can't relabel one (D33, D34). Failing closed means
  some reads count as writes and stay away from ARIA: a name with `and`, `or` or `then` anywhere after its read verb,
  also when it only joins two things (`list_users_and_groups`); a name with a write word anywhere, or a verb that's
  also a noun past the read verb's object (`get_user_order_history`); and a name that starts with a word that isn't
  one of ARIA's read verbs (`browse_files`, `summarize_thread`). The other way round, a write can pass as a read
  when its name is a read verb and words ARIA doesn't count as changing anything: a verb it doesn't know
  (`get_user_quarantine`), a verb pair that isn't on its list (`get_rid_of_duplicates` reads; the pairs are check in,
  out and off, and log, sign and opt in and out, with a few like them), or a server that names a write like a read. Such a tool runs without asking where read tools
  do by default (every server's for ARIA, D33; GitHub's for tasks) until you set it to Never. D31 reads words in GitHub's tool names, failing
  closed: a Copilot review (`request_copilot_review`) is refused with the coding-agent tools. Checked against the real
  GitHub server's 102 names (2026-10-19): no write passes as a read. GitHub's `<thing>_read`, `_get` and `_list`
  reads are whole-name reads (D35); a few other GitHub reads still count as writes (`web_search`, `ui_get`,
  `get_latest_release`, `summarize_job_log_failures`).
- **Integrations: servers.** A server is GitHub's by its name or its address, and stays GitHub's by that name once
  seen, even if its address changes later (only removing it in the CLI and then forgetting it on the page clears that); one behind another address with another
  name is treated like any other server (its tools are Never for tasks by default, and a write asks every time,
  D30). No address is kept, so duplicates are found by host and path: two entries that differ only in their query are
  one server. Refresh starts every server in a helper session (one check at a time, at most every 30 s); a server
  that needs signing in lists no tools until it's signed in only if it never connected: one that did lists its tools
  from before (the runtime keeps them; checked 2026-10-19). Tools that aren't listed stay, with when they were last
  seen. At most 100 servers, 2,000 tools and 2,000 rules. A helper session that can't be deleted is tried again at
  the next start (the newest 50 are noted).
- **Integrations: rules.** A change of ARIA's tools reopens its conversation before your next message (the session
  isn't changed live). A task's session gets its tools when it opens: a tool turned off is refused at once for a
  running task, one turned on reaches it when it starts again (the page says how many are running). GitHub's read tools
  are on for tasks by default and reach every repository your account can see, not only the task's (D35); the page
  warns on each. ARIA's Ask works like Never until the action cards (D22, Phase 5). A task's MCP call with more than 20,000 characters of arguments, or
  with arguments that can't be written out as JSON, is refused (D30). Sign in works one server at a time with a 5-minute time-out, and worked for Work IQ Mail
  against the real runtime (2026-10-19). It waits for its session's servers to load before the login (Phase 9, bug
  2; up to 30 s, during which the page says it's starting and Cancel or quitting ends it and deletes its session), its session's id fits Microsoft's sign-in page (bug 5), and ARIA's conversation reopens after a sign-in to one
  of its servers (bug 3); a running task gets a new sign-in only when its session opens again. An expired sign-in shows as
  `needs-auth`, so Sign in is offered for it.

The plan for this phase:

- Policy engine with the default rules and a settings page; workers in the runtime's sandbox
  (D20); "Approve for this task" grants (D21).
- **Customize › Integrations** (first draft): shows the servers and plugins from your Copilot CLI
  setup, classifies tools by name, and holds per-scope rules (auto/ask/never) with the task tracker's
  defaults from §4.13. Scopes are enforced in the permission handler when a tool is called.
- Question, permission, plan, budget and profile-proposal cards with buttons.
- Reply-to, @mentions, and the `<updates>` / `<pending>` digest for the Conductor.
- Coalescing, focus mode, "while you were away".
- Conductor inspector (the injected `<updates>` and tool calls per message).
- **Customize › Prompts** with version history; "Always allow this" and "Save as memory" from the
  session view.
- **Done when** two tasks can ask questions at the same time and you can answer both from the one
  chat without confusion, and you can change the brief template and see the effect on the next
  task.

### Phase 4: GitHub awareness (M)

**Status: done 2026-10-21**, with decisions D36–D53 (§0.3).
- **Committed** as "Phase 4: GitHub awareness".
- **Design notes:** each item has one, kept as design history (like the spike notes). Each note holds the design, its
  review round ("Duck round"), the decisions, the build notes and the code review rounds ("Step C"). The notes are
  internal and not published. Where a note's later sections differ from its first ones, the later ones win.

The done-when, both scripted (§0.6):
- "Open a PR and tell me when CI is green": `ui-pr` opens a task's PR and its watch tells the checks going green.
  `ui-fix`'s last step does it again after Push new commits.
- "A red CI run can be fixed with one click": `ui-fix`. A task's PR goes red; one Fix it continues the task with the
  failing job's log; the fix is committed and pushed to the same PR; the checks on the new head go green.

Built, one item at a time:

1. **GitHub's client and watchers** (D36, D37). Octokit with ETag polling, its throttling and retry plugins, and
   gh's token (`gh auth token`, in memory only), through Chromium's network stack.
   - **The read guard** (`github/fetch.ts`): a fixed list of read paths, only to GitHub's API origin, redirects
     only within it, each answer's whole body read before it counts, and a few reads pinned to their exact query.
   - **Watches:** a run, a PR's checks and reviews, default-branch health, and the inbox (on by default; only review
     requests toast).
   - **What they make:** CI and PR cards, toasts through attention, digest lines (GitHub's words always quoted), and
     ARIA's `watch`, `list_watches` and `unwatch`.
   - **The rules they follow:** caps (50 active, 20 by ARIA, 45 by you and ARIA together), pauses per resource for rate limits,
     another gh account pausing its watches, and SSO.
2. **My work and the watch rows** (D38–D40). Three searches over your projects only, pinned in the guard and batched
   within 256 characters. They're shown as each one answers, a failed or unsearchable batch is said, and the
   searches run only while My work is open. Watch rows sit under each project, and Customize › Notifications has a
   GitHub section.
3. **`open_pr`** (D41–D44). The PR card shows what's pushed and sent, and only your click does it.
   - **The push** is ARIA's own. It runs from a scratch repository that borrows the project's objects, so none of
     the project's config, hooks, replace refs or grafts apply. It pushes by commit, over https only, with gh's
     credential helper; it refuses a rewritten address, LFS, and a branch rewritten under an open PR.
   - **The POST** is one exact single-use request.
   - **After it:** the PR is watched by the task.
   - **What the card covers:** a fork's choice of repository, D43's tick for workflow changes, and Push new commits.
4. **CI and PR cards: Fix it and Address comments** (D45–D53).
   - **Fix it** continues the task that owns the branch. If that task can't, a new task adopts the branch; for a red
     default branch, a new task starts from the commit CI ran on, which is fetched the locked-down way when it isn't
     on this PC.
   - **The failing jobs' logs** come in two pinned hops, the second to GitHub's log storage only, with no token. They
     are streamed, capped, cut and cleaned, and fenced as untrusted text the worker is told how to treat.
   - **Address comments** sends one review's text and inline comments. Reviews from outside the repository's people
     need an extra tick.
   - **ARIA only proposes either one**, as a card.
   - **Kept away from ARIA:** none of that text ever reaches ARIA's context, your words or a memory.
   - **D52's wider tick** covers what such a task changes in builds, CI and tests.

Verified by:
- **Vitest:** 1233 tests in core and 74 in the desktop app, all passing.
- **Mutation checks:** 343 mutations in ten lists, each guard broken on purpose to see the test meant for it fail.
  - Item 1: 157 (105 for the build, 34 and 18 for its two review rounds).
  - Item 2: 57 (42 and 15).
  - Item 3: 65 (52 and 13).
  - Item 4: 64 (50, 9, and 5 for the final review's nits).
  - 341 were caught. The other two: item 1's r9 only reached its race by timing, and its retargeted r9b is caught;
    item 2's i16b is masked by a second guard (the fetch's abort), kept as defence.
  - Every survivor along the way got a stronger test.
- **The nine scripted UI specs (§0.6), all passing:** `ui-github`, `ui-mywork`, `ui-pr` and `ui-fix` are new, and
  `ui-cards`, `ui-attention`, `ui-away`, `ui-flow` and `ui-integrations` still pass.
- **Reviews:**
  - one design review round per item (a rubber duck, Sonnet);
  - Opus code review:
    - item 1, two rounds, its round-2 fixes checked with item 2;
    - item 2, one round, its fixes checked with item 3;
    - item 3, one round, its fixes checked with item 4;
    - item 4, one round, its fixes checked in a final review of the whole phase: nothing significant, and its last
      small corrections are in.
- **Nothing ran against the real GitHub.** Tests and specs use a local mock GitHub, with its log storage on loopback,
  and the no-network guard. Pushes and fetches went only to local bare repositories. What that leaves to check is the
  list under Phase 9.
- **One incident:** the first version of the tests' network guard (item 1) missed one form of `socket.connect`. Its
  own test made two raw TCP connections, to api.github.com and github.com on port 443, with nothing written on them
  (no TLS, no request, no token). It was fixed at once: the guard reads every form of `connect`, and every refusal
  test now uses `.invalid` hosts.

Known limits, all four items in one place:
- **What's watched:**
  - only your projects' `origin` repositories; a fork's PRs to its upstream are found only when the fork has an
    `upstream` remote;
  - an SSH host alias isn't recognized as github.com;
  - a PR's first 100 reviews and check runs are read;
  - 5 watch places are kept for tasks and the inbox;
  - after three 403s in a row, the inbox only tries again once an hour.
- **My work's searches:**
  - at most 8 batches per search shape, each query within 256 characters, so how many repositories fit depends on
    the length of their names; the ones left over aren't searched, and My work says how many;
  - the throttling plugin spaces searches 2 s apart, so a full refresh of up to 24 searches takes about 46 s (results
    show as each search answers);
  - a repository GitHub can't search is left out for an hour, and named.
- **What GitHub's answers look like** comes from GitHub's REST docs, not checked on the wire (the Phase 9 list).
  Bottleneck adds about 170 ms per request on Windows: harmless at these intervals.
- **Opening a PR:**
  - ARIA pushes only to the project's `origin`, and only with gh's account. An `insteadOf` or `pushInsteadOf` to
    SSH, LFS anywhere in the tree, or a project whose objects are borrowed from elsewhere refuses the push: you push
    those yourself.
  - It never fetches for a PR. A PR with commits that aren't on this PC is refused, and so is a branch rewritten
    under an open PR.
  - Push protection (GH013) is passed on, never bypassed.
  - No fork is made for a repository you can't push to.
- **Fix it and Address comments:**
  - only on ARIA's own branches and your default branch (D45);
  - at most 3 failed jobs, each cut to its last 150 lines and 20 error lines (24 KB in all);
  - a review's first 100 inline comments;
  - not the PR's conversation comments (D50);
  - the comparison with the PR's head is local only;
  - a task held at its budget that's adopted is stopped for good;
  - Continue keeps the task's own profile; the CI fix profile is for new tasks (D47);
  - the log storage ARIA takes is an assumption to check (Phase 9): anything else means "no log".
- **Untrusted text:**
  - the marker check folds common Cyrillic and Greek look-alikes and NFKC forms, not every confusable letter;
  - a worker's own report may still quote what it was given, and the report reaches ARIA as every report does.
- **Tests:** core's suite takes about 100 s (§0.6).

The plan for this phase:

- Octokit with ETag polling; watchers for runs, PRs, default-branch health and the inbox.
- **My work** view (issues, PRs, CI across projects) and watch rows under each project in the
  sidebar.
- `open_pr` tool (draft by default), auto-watch PR checks after opening.
- CI cards, **Fix it** flow with job logs, PR review cards with "Address comments".
- **Done when** "open a PR and tell me when CI is green" works end to end, and a red CI run can be
  fixed with one click.

### Phase 5: Work tracking and time registration (L, split into 5A–5D)

Split into four sub-phases so the shared write-execution plumbing (5A), passive data collection (5B), AI timesheet
drafting (5C), and the Time view + tracker registration (5D) can each be designed, reviewed and tested on their own.
Automated timesheet reminders and the daily schedule move to **Phase 6B**, where the scheduler and Morning brief are
built.

#### Phase 5A: Approved writes and action cards (S)

**Status: done 2026-10-22** (decisions D54–D56, completing D19 and D22). Design, duck round (`gemini-3.8-flash` high),
build notes (`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- Short-lived execution session (`runtime.runMcpAction`, `ActionRunner.executeApprovedMcpCall`) that carries out one
  approved MCP write call using the Conductor's model and reasoning effort, with all other MCP servers disabled,
  `availableTools: ["mcp:<wireName>"]`, randomized nonce payload markers, and a single-use **exact-payload check**
  (`checkExactPayload` + `checkJsonRawTokens`) in both `onPermissionRequest` and `hooks.onPreToolUse` (§4.13, D10).
  Outcome is taken strictly from `tool.execution_complete`, never from the model's reply.
- `list_action_tools` and `request_action` tools for the Conductor and **Action-request cards** (`action_request`,
  short ids `A-n`) in the chat (Send / Confirm and run, Edit, Cancel, Try again) for writes across your tools: the task
  tracker's tasks (its create, update and remove tools),
  Outlook mail, Teams messages and Calendar replies (moved from Phase 3, D19).
- In **Customize › Integrations**, ARIA tools set to **Ask** now propose an action card instead of acting like Never
  (D22). D31 GitHub fixed tools, `unrestricted` tools (`api_post`, `api_patch`, `api_delete`), and the tracker's
  time-log write tools (reserved for 5D's Timesheet flow, D54) are refused in `request_action`.
- Destructive safeguard (§0.4 #5, D55): `request_action` refuses `confirm=true` from the model; destructive cards
  require a confirmation checkbox bound to the exact JSON text (editing the JSON unchecks it), and only your tick
  injects `confirm: true`.

Verified by:
- **Vitest:** 1242 tests in core (`packages/core/test/actions.test.ts` covering `checkExactPayload`,
  `checkJsonRawTokens`, `validateActionArgs`, `sanitizeInputSchema`, `checkActionTool`, `ActionRunner`, and
  `CopilotRuntime.runMcpAction` against a stand-in SDK client) and 76 in the desktop app (`apps/desktop/test/cards.test.tsx`),
  all passing.
- **Scripted UI specs (§0.6):** `ui-actions` (proposing a create call of a made-up tracker (Acme) with a decoded preview of its `*Json` argument,
  inline JSON editing before Send, and a remove call with its confirmation checkbox resetting
  on JSON edit and injecting `confirm: true`) and `ui-integrations`, all passing.
- **Reviews:** one design review round (`gemini-3.8-flash` high, 4 blocking and 8 non-blocking findings adopted) and two
  code review rounds (`gpt-6-luna` max: round 1 found 1 high and 3 medium issues, all fixed; round 2 verified the fixes
  and found 1 high issue on invisible format characters in tool identifiers, fixed in `classifyTool` and
  `checkActionTool`).

Known limits:
- Until Native MCP in Phase 7A, each approved write still spends one short-lived model call (3–8 s, ~0.07–0.21 AI
  credits on a lightweight model in Phase 0) to invoke the MCP tool through the SDK runtime.
- Tool `inputSchema` is captured from `session.rpc.mcp.listTools` for servers that are `connected` when the inventory
  runs (pruned to depth 6 and 8,000 characters); for a tool whose server provided no schema, `validateActionArgs`
  checks plain-JSON structure, size, disguise characters and `*Json` strings without required-key validation.
- If a short-lived session is killed after `onPermissionRequest` approved the call (`approvedOnce`) but before
  `tool.execution_complete` arrives, ARIA cannot know whether the remote server processed the write; the card turns
  `failed` and warns you to check whether it went through before clicking Try again.

- **Done when** asking ARIA to create or update a task in the tracker or send a message produces an Action-request card
  showing the exact payload, clicking Send runs the short-lived session, and any argument difference is refused.

#### Phase 5B: Activity collectors, task linking and mapping rules (S)

**Status: done 2026-10-23** (decisions D57–D58). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- The `activities`, `time_rules` and `tracker_tasks_cache` tables in SQLite (Migration 7, §8), with `(ended_at,
  started_at)` overlap indexing and `manual_link` protection so manual tracker link overrides and clearances are never
  overwritten by automatic re-scans (D57).
- Plain-code activity collectors (`timekeeper/collectors.ts`) for **ARIA tasks** (one row per execution stretch,
  `task:<id>:run:<stretch>`, refreshed live while active), **GitHub** (PRs opened/updated/merged/closed, reviews, and CI
  runs from `PullRequests` and `Watchers`) and **local git** (`git log --branches --source --no-merges
  --no-show-signature` with `%at` author timestamps across registered projects, filtered to your identity and `aria/*`
  branches, flagging unpushed commits, D58).
- **Explicit task linking** (first written for one tracker, then made generic: the active tracker's config says what a task
  reference looks like, `taskRef`, §4.14): recognizes task references and task URLs in branch names, commit messages,
  PR titles/bodies, task briefs, and meeting invites; optional `trackerTaskId` on `start_task`, in the **New session** dialog, on
  `TaskCard`, and editable inline in `SessionView` (`setTaskTracker` / `link_task_tracker`).
- **Mapping rules** (`timekeeper/rules.ts`): `repo`, `branch`, `meeting_title`, `meeting_organizer` and `teams_channel`
  → tracker task ID, with `exact` / `prefix` / `contains` modes and deterministic specificity ordering
  (`resolveActivityTask`: explicit link → `branch` > `repo`, `meeting_title` > `meeting_organizer`).
- **Done when** ARIA records local git, GitHub and task activity in SQLite, links branches, commits and tasks to
  tracker task IDs automatically, and matches activities against your mapping rules (verified by
  `packages/core/test/timekeeper-5b.test.ts`, `apps/desktop/test/cards.test.tsx`, and `e2e/ui-actions.spec.ts`).

#### Phase 5C: Timekeeper session and timesheet draft card (M)

**Status: done 2026-10-23** (decisions D59–D60). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- **Timekeeper** model + effort + daily schedule slot in **Customize › Models** (`CustomizeModels.tsx`, §4.12), plus
  strict read-only scoping (`timekeeper/scope.ts`, §4.13, D59): the task tracker's read tools (excluding its raw request tool), Work IQ
  Calendar and Work IQ Teams read tools (excluding `Work IQ Mail` and `workiq-*` plugin tools), and `propose_timesheet`.
- Timekeeper session (`runtime.runTimekeeper`, `TimekeeperRunner` in `timekeeper/session.ts`) and Conductor tools
  (`prepare_timesheet`, `get_timesheet`, `update_timesheet_entry`): ingests the tracker's tasks (`tracker_tasks_cache`),
  existing time logs, and eligible Work IQ calendar/Teams events, preserves user-edited (`mappedBy: "you"`) and
  submitted rows across re-preparations (D60), and persists draft rows in SQLite (`timesheet_entries`, Migration 8).
- **Plain-code checks** (`timekeeper/checks.ts`): two-pass `Intl.DateTimeFormat` time-zone and DST math across Windows
  and IANA time zones (`normalizeTimeZone`, `parseDateTimeInZone`, `intervalMinutesOnDate`), boundary-aware rounding,
  verified link/rule provenance against stored `activities`, task → project/customer lookup from `tracker_tasks_cache`,
  overlap detection, duplicate/overlap checks against entries already in the tracker, and working-hour gap & total math.
- **Timesheet draft card** (`timesheet_draft`, `Cards.tsx`): summary header, uncovered gap buttons (**+ Fill gap**),
  inline row editing, **Confirm** button on uncertain rows, conversational corrections through ARIA, and the
  **"Always map X to task Y?"** learning rule offer (`acceptTimesheetRuleOffer` / `dismissTimesheetRuleOffer`).
- **Done when** "prepare my timesheet for today" (or any date) produces a checked Timesheet draft card in the chat that
  you can edit inline or through ARIA, and correcting a mapping offers to save a rule (verified by
  `packages/core/test/timekeeper-5c.test.ts`, `apps/desktop/test/cards.test.tsx`, and `e2e/ui-timesheet.spec.ts`).

#### Phase 5D: Time view and tracker Submit, Update and Delete (S–M)

**Status: done 2026-10-23** (decisions D61–D62). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- **Time** view in the sidebar (`Sidebar.tsx`, `TimeView.tsx`, §5.1, §5.2): shows today's total on the sidebar row
  (`nav-time-total`), a 7-day Monday–Sunday ISO week overview strip with Prev / Today / Next week controls, the
  selected day's draft and registered entries with the activity behind each entry (`sources`), the day's collected
  activities with **Scan local git**, and the **Mapping rules** editor (`time_rules`).
- **Submit** on the Timesheet card and in the Time view (`submitTimesheet`): enforces plain-code validation gates
  (every row `certain`, valid `start < end`, `trackerTaskId` (and `trackerProjectId` and `trackerCustomerId` when the
  config's `requiresProjectCustomer` says the tracker asks for them), clean `comment`, and zero overlaps or tracker
  duplicates), calls the config's create tool (`timeLogs.create`) through 5A's short-lived
  session and exact-payload check (`allowTimeLogTools: true`), reports per-entry status on the **Time registered** card
  (`card-time-registered`, showing the complete `rawResponse` on partial or full failure, D16, and gating ambiguous
  transport outcomes behind `needsReconcile`, D61), and persists `tracker_entry_id`s in SQLite (`state = "submitted"`,
  D62) so a day is never registered twice.
- **Later changes**: editing a registered entry calls the config's update tool (`timeLogs.update`); deleting calls its
  delete tool (`timeLogs.delete`, with `confirm: true` injected by `executeApprovedMcpCall` for a tool that needs it) only
  after an explicit confirmation box and checkbox bound to the exact tracker entry ID (§0.4 #5, §4.14 #6, D55).
- **Done when** you can inspect your day and week in the Time view and one click on Submit registers the approved rows
  in the tracker without duplicates, with a result per entry (verified by `packages/core/test/timekeeper-5d.test.ts`,
  `apps/desktop/test/cards.test.tsx`, and `e2e/ui-timesheet.spec.ts`).

### Phase 6: ARIA polish (M, split into 6A–6D)

#### Phase 6A: Conductor memory and Search (S)

**Status: done 2026-10-23** (decisions D63–D64). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- `remember` and `forget` tools for the Conductor (`conductor/tools.ts`, `memory/memories.ts`), injecting global and
  project memory into ARIA's own system prompt via `{{memory}}` (`conductorNotes`, `conductorMemoryBlock`, completing
  D23; Customize › Memory already exists from Phase 3 Part B), guarded against prompt injection by
  `assertMemoryGrounded` / `assertForgetGrounded` (D63) and announced with timeline notices (`memory_remembered`,
  `memory_forgotten`).
- **Search** view in the sidebar (`Sidebar.tsx`, `SearchView.tsx`, `search/search.ts`, §5.2): backed by SQLite's
  `session_transcripts` index (Migration 9, D64), searches across session transcripts (worker sessions and ARIA's own
  conversation), tasks, projects, and memories, opening the matching session view (scrolled to the matched entry) or
  card.
- **Done when** ARIA can save and remove memories in its own prompt with `remember` / `forget`, and Search finds
  matches across session transcripts, tasks and projects (verified by `packages/core/test/memory-6a.test.ts`,
  `packages/core/test/search-6a.test.ts`, and `apps/desktop/e2e/ui-search-memory.spec.ts`).

#### Phase 6B: Automations, reminders and morning brief (M)

**Status: done 2026-10-23** (decisions D65–D66). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- Scheduler (`croner`, `scheduler/scheduler.ts`), `routines` and `reminders` tables (Migration 10), `remind_me` /
  `schedule_routine` tools (guarded by `assertReminderGrounded`, `assertRoutineGrounded`, and `activeRoutineTurn`, D65),
  and the **Reminder** card (`card-reminder`: Snooze 15m, Snooze 1h, Done).
- **Utility model** slot in Customize › Models (`CustomizeModels.tsx`, `runtime.runUtilitySummary`, D66: optional
  tool-free session; plain-code digest when off).
- **Morning brief** card (`card-morning-brief`) on first open of the day (or scheduled time) and the **Automations**
  view in the sidebar (`Sidebar.tsx`, `AutomationsView.tsx`: enable/disable, next run, last result, Run now).
- Built-in time-tracking routines (§4.14): daily Timekeeper draft at the time you set (`timesheetTime`, default 16:30),
  morning-brief reminder for unregistered workdays, and Friday afternoon week overview (`weekly_time_overview`).
- **Done when** routines and reminders run on schedule, can be managed and triggered with Run now in Automations, and
  the morning brief and daily timesheet draft fire automatically (verified by
  `packages/core/test/scheduler-6b.test.ts` and `apps/desktop/e2e/ui-automations.spec.ts`).

#### Phase 6C: Quick prompt bar, slash commands and "Rerun with…" (S)

**Status: done 2026-10-23** (decisions D67–D68). Design, duck round (`gemini-3.8-flash` high), build notes
(`gemini-4-argon` high), and two code review rounds (`gpt-6-luna` max) were done.
- Global hotkey (`Ctrl+Space`, configurable in Customize › Notifications) Spotlight-style **Quick prompt bar**
  (`QuickPromptBar.tsx`, `globalShortcut` in `main/index.ts`, tray menu item) with `/slash` and `@task` autocomplete,
  plus optional **Start at login** (`app.setLoginItemSettings` and tray checkbox, §4.1, §5.5).
- Deterministic slash commands in the chat and prompt bar (`conductor/slash.ts`, D68: `/status`, `/tasks`, `/watch`,
  `/focus`, `/pause-all`, `/budget`), with shared `/slash` autocomplete in `Chat.tsx` and `QuickPromptBar.tsx`.
- **"Rerun with…"** in the session view and on Done cards (`SessionView.tsx`, `NewSessionDialog.tsx`, `Cards.tsx`, §5.3,
  D67): reruns a finished, failed, cancelled or interrupted task's brief in a fresh worktree off the original
  `baseCommit` with a different prompt or profile, and links the runs in a **Compare runs** switcher bar (`Run #1`,
  `Run #2`, …) that preserves the active Transcript / Diff tab.
- **Done when** the global hotkey sends a prompt from anywhere, slash commands run directly where deterministic, and a
  finished task can be rerun with another profile or prompt (verified by
  `packages/core/test/slash-rerun-6c.test.ts` and `apps/desktop/e2e/ui-phase6c.spec.ts`).

#### Phase 6D: Voice (S, optional)

**Status: done 2026-10-26** (decisions D69–D70). Design, build notes (`gemini-4-argon` high), and two code review rounds
(`gpt-6-luna` max) were done.
- Spoken announcements for milestones and blocking items (`attention/attention.ts`, `renderer/src/voice.ts`,
  `CustomizeNotifications.tsx`, §4.7, D69): configurable scope (`Off`, `Blocking only`, `Milestones and blocking items`)
  using Windows `speechSynthesis` or OpenAI-compatible cloud TTS, with a bounded 3-item playback queue, lock awareness,
  and sanitized 180-character summaries (`formatSpokenText`).
- Push-to-talk hotkey (`Ctrl+Shift+Space`) and mic buttons in the chat composer (`composer-ptt`) and Quick prompt bar
  (`quick-prompt-ptt`, `voice/voice.ts`, §5.5, D70): records 16 kHz 16-bit mono PCM WAV in the renderer and transcribes
  via local `whisper.cpp` (`execFile`, `shell: false`) or cloud speech-to-text (with API keys encrypted via Electron's
  `safeStorage`).
- **Done when** ARIA can speak short announcements and transcribe push-to-talk into the chat box (verified by
  `packages/core/test/voice-6d.test.ts` and `apps/desktop/e2e/ui-phase6d.spec.ts`).

### Phase 7: Native MCP (M, split into 7A–7B)

#### Phase 7A: Native MCP configuration and built-in client (M)

**Status: done 2026-10-26** (decisions D8, D10, D16, D19, D22, D30–D35). Design, rubber duck (`gemini-3.8-flash` high), build notes (`gemini-4-argon` high), and code review (`gpt-6-luna` max) were done.
- ARIA's own MCP configuration in Customize › Integrations: **Import from Copilot CLI**, optional **Keep in sync**,
  and **Test** buttons (Sign in already exists from the first draft).
- Sessions keep receiving only the servers and tools in their scope (`disabledMcpServers`, exact `availableTools`
  lists, and `mcpServers` / `pluginDirectories` for ARIA's own config). `COPILOT_PLUGIN_DIR_ONLY` isn't needed: it
  had no visible effect in Phase 0.
- Built-in MCP client (`@modelcontextprotocol/sdk`): Submit, Update, Delete, duplicate checks and Action-request cards
  call the servers directly from ARIA's code, with no model in between.
- **Done when** ARIA has its own MCP configuration, and approved writes no longer go through a model (verified by
  `packages/core/test/mcp-7a.test.ts`).

#### Phase 7B: Task tracker watcher and My work integration (S)

**Status: done 2026-10-26** (decisions D3, D8, D10, D19, D22, D24, D25, D34, D36–D40, D60). Design, rubber duck (`gemini-3.8-flash` high), build notes (`gemini-4-argon` high), and code review (`gpt-6-luna` max) were done.
- Task tracker watcher (§4.6; first written for one tracker, then made generic): polls the tracker's my-tasks read
  (`tasks.myTasks`) every 10 minutes through the built-in MCP client, diffs against `tracker_tasks_cache`, and emits
  **Tracker update cards** (new task assigned, status or priority change, new comment) with Open task and Ask ARIA.
- A section for the tracker's tasks in **My work** (§5.2).
- **Done when** changes on your tracker tasks arrive as cards in the chat and your assigned tracker tasks show in My
  work alongside GitHub items (verified by `packages/core/test/tracker-acme.test.ts`, which runs the watcher on a made-up
  tracker's config, and `apps/desktop/e2e/ui-phase7b.spec.ts`).

### Phase 8: Beyond the desk (M, split into 8A–8B)

#### Phase 8A: Cloud tasks and remote sessions (M)

**Status: done 2026-10-26** (decisions D71–D72). Design, rubber duck (`gemini-3.8-flash` high), build notes (`gemini-4-argon` high), and code review (`gpt-6-luna` max) were done.
- Cloud tasks (`createSession({ cloud: { repository: … } })`) through Mission Control: waiting for `session.start`
  (`producer === "copilot-agent"`), saving the Mission Control URL from `session.info`, and cloud badges in the sidebar
  and cards (§4.4).
- Remote sessions (`remote: true`, `enableRemoteSessions: true`) so local tasks show up in GitHub web and mobile.
- **Done when** a task can run in the cloud (`where: "cloud"`), is tracked in the chat and sidebar with its Mission
  Control link, and keeps running when your PC sleeps (verified by `packages/core/test/phase8a-cloud.test.ts`).

#### Phase 8B: Phone notifications and two-way relay (S–M)

**Status: done 2026-10-26** (decisions D73–D74). Design, rubber duck (`gemini-3.8-flash` high), build notes (`gemini-4-argon` high), and code review (`gpt-6-luna` max) were done.
- Phone push notifications (ntfy or Pushover) from the attention engine while you're away.
- Two-way Telegram relay into the one chat.
- **Done when** blocking and milestone events push to your phone while away and replies from the relay land in the
  ARIA chat (verified by `packages/core/test/phase8b-phone-telegram.test.ts`).

### Phase 9: Hardening (ongoing)

**Status: done 2026-10-27** (decisions D75–D78). Design, rubber duck (`gemini-3.8-flash` high), build notes (`gemini-4-argon` high), and code review (`gpt-6-luna` max) were done.
- Crash recovery tests (`packages/core/test/crash-recovery-phase9.test.ts`), budget alerts (`packages/core/test/budget-alerts-phase9.test.ts`),
  structured rotated logging (`packages/core/test/logging-redact-phase9.test.ts`), and SDK upgrade checklist (`docs/sdk-upgrade-checklist.md`).
- Recorded event-stream fixtures for regression tests of the state machine (`packages/core/test/event-fixtures.test.ts`).
- Policy engine command hardening for Git 2.53+ and gh CLI (`packages/core/test/policy-hardening-phase9.test.ts`).
- Packaging and pre-update shutdown verification (`packages/core/test/packaging-phase9.test.ts`).
- Follow-ups from Phase 3 Part A:
  - The code review of Part A stopped after 8 rounds at your call (62 findings fixed). Each round still found a
    narrower way around the fixed rules, so another review pass of the policy engine (`packages/core/src/policy`,
    `tasks/policy.ts`) is worthwhile before the rules are relied on without the sandbox.
  - The fixed rules carry a list of git's own commands (Git for Windows 2.53) and of gh's top-level commands;
    update both with new git and gh versions.
  - The Part A known limits (Phase 3 above): what the sandbox doesn't cover, what the fixed rules don't read, and
    pending items that don't survive a restart.
  - Not yet tried against the real runtime: permission cards and pnpm or yarn installs in the sandbox.
- Follow-ups from Phase 3 Part B:
  - The Part B known limits (Phase 3 above), in one list.
  - Item 4's fixes after its first review (the "after the first review" parts of D30, D31 and D33, and two nits:
    ARIA reopens only when its own tools change, and a helper session that fails to delete is kept for the next
    start) were reviewed in round 2, which found 1 minor finding and 3 nits, all fixed. No reviewer note is left open.
  - The three commits after Part B (its UX review fixes, the real-runtime check and fix 6) had a code review of their own (Opus): nothing
    significant. 1 minor finding: D35's GitHub reads reach every repository the account can see; your choice was to
    keep them on for tasks and warn (D35, the page's warning, a defaults test on GitHub's default toolset). 3 nits,
    fixed: the lock wording in the Part B known limits, a stale line in "Part B verified by", and Sign in that couldn't
    be cancelled while its session's servers load (now the page says it's starting, and Cancel or quitting ends it and
    deletes its session). 11 mutations for the new guards, all caught.
  - The classifier's word lists and D31's words were checked against Phase 0's 192 tool names and GitHub's own MCP
    server's names, and on 2026-10-19 against the real GitHub server's 102 names (spike 13); update them when a server
    adds tools the names don't place.
- Follow-ups from Phase 4: the Phase 4 known limits (Phase 4 above), in one list. Item 4's review round 1 fixes (a cut-off
  answer taken as good, a run's name as a task title, an adoption race, the nonce and look-alike markers) were checked
  in the final review of the whole phase: nothing significant. Its last nits (a JSON answer that isn't JSON, a 204's
  empty body, the marker check folding text only for itself) are fixed, with a mutation each.
- Follow-ups from Phase 5A: the Phase 5A known limits (Phase 5A above). Needs a check with the real runtime (with your
  per-action OK for any write, §0.4): that `session.rpc.mcp.listTools` populates `inputSchema` for Work IQ's servers in
  `inventory()`, and that an Action-request card for a real read tool set to `Ask` (or a harmless draft/task write you
  approve) runs end to end through `CopilotRuntime.runMcpAction`.
- **Needs a check against the real GitHub** (Phase 4 was built and tested against a local mock only; from the last
  section of each Phase 4 design note).
  - **Reads only, so no OK is needed beyond running ARIA with your account:**
    - [ ] **The shapes of GitHub's answers:**
      - whether a 304 carries `X-Poll-Interval` and the rate-limit headers;
      - the notifications' `Last-Modified`;
      - the `x-oauth-scopes` of gh's token;
      - which account ARIA reads as when gh and Copilot CLI are signed in as different accounts.
    - [ ] **My work's search:** whether the 256 characters count the qualifiers, and whether several `repo:`
      qualifiers stay an OR; whether search answers carry ETags and 304s; the exact form of
      `X-GitHub-SSO: partial-results`.
    - [ ] **Jobs and check runs:** that an Actions check run's id is its job's id, with a `check_run_url` pointing
      back at it.
    - [ ] **A job log's redirect:**
      - its status (302 or 307);
      - its Location's host and path (ARIA takes only
        `productionresultssa<n>.blob.core.windows.net/actions-results/…` with `sig` and `se`);
      - how long the address stays valid;
      - whether a log ever comes inline;
      - the storage's content type, encoding and Range support;
      - typical log sizes;
      - a 410 after retention, 404 against 403 for a private repository, and SSO.
    - [ ] **Reviews:** `author_association` and `user.type` on one review's read; the review comments' shapes (`line`
      against `original_line`, `side`, suggestions, replies, outdated comments) and their pagination.
    - [ ] **A fork's PR run** (`head_repository` another repository): Fix it isn't offered.
    - [ ] **D53's fetch** of one commit by its sha through gh's credential helper (a read, with no write).
    - [ ] **Search's 422s:** that a search answers 422 for a `repo:` that doesn't exist or this account can't see,
      and what a renamed repository's old name does there (My work's fallback for a 422 depends on it).
    - [ ] **The compare API** (`compare/{sha}...{sha}`): its `behind` and `identical` statuses, and a 404 for a commit
      GitHub doesn't have, across a fork network too (the PR card's base check depends on it).
    - [ ] **The PR lookup by head** (`pulls?head=<owner>:aria/…&state=open`): that it finds a PR right after it's
      opened (the "already exists" path depends on it).
  - **Writes, so each needs your OK for a push or a PR (§0.4), on a throwaway repository first:**
    - [ ] **The push through `gh auth git-credential`:** gh's full path with spaces, no credential window, and an SSH
      `insteadOf` or `pushInsteadOf` refused.
    - [ ] **PRs and their CI:**
      - a draft PR, a ready PR, and a repository that doesn't take drafts (422);
      - CI on it going green (told by the PR's watch) and red (its card);
      - Push new commits to the same PR.
    - [ ] **Forks and permissions:** a fork's PR on its upstream; an organisation with SSO; a repository you can't push
      to.
    - [ ] **The body:** a mention, a closing keyword, a link and an image inside the body's fence stay inert.
    - [ ] **Push protection:** a GH013 rejection passed on as GitHub words it.
    - [ ] **Fix it end to end** with a real failing job's log, and **Address comments** with a real review (each needs
      a PR first).
- **Checked with the real runtime** (2026-10-19, spikes 13–16 and the app, 0.27 AI credits; answers and evidence in the
  [spike notes](docs/spike-notes.md#phase-3-part-b-checks)). Part B was built and tested on the scripted runtime only:
  - [x] Inspector: `getEvents()` keeps everything from before a compaction (also after a restart), and
    `PermissionRequest.toolCallId` is always there and equals the tool call's id, for refused calls too.
  - [x] "Save as memory": the `ask_user` result is **not** your answer as is: it's `User selected: <choice>` or
    `User responded: <your words>` (bug 1 below).
  - [x] Integrations (the reviewer had already confirmed from recorded real events that an MCP permission request's
    `serverName` and wire `toolName` match the inventory's names):
    1. `getCurrentMetadata()` fills `mcpServerName`, `mcpToolName` and `description` for every MCP tool: yes.
    2. Sign in from a short-lived session works for Work IQ (`workiq`, plugin-provided), but only once the session's
       servers have loaded: right after `createSession`, `login` fails with "MCP host is not available on this
       session" (bug 2). No server is an owned installation, so `prepareLogin` wasn't tried.
    3. `session.mcp_server_status_changed` arrives on the sign-in session, and the token reaches new sessions and a new
       runtime, but not a session that's already open (bug 3).
    4. A resumed session takes new `availableTools` and `disabledMcpServers`: yes.
    5. The built-in GitHub server isn't started at all unless a session passes `githubMcpToolConfig` (gap 4); with
       `{}` it lists 19 read tools, with `enableAllTools` 102. D31 holds for all of them, and no write passes as a
       read; some of GitHub's reads count as writes (`issue_read`, `pull_request_read`, `actions_get`, …).
    6. An expired token (refresh refused too) shows as `needs-auth`, without an error, never `failed`; Sign in then
       works again.
    7. `mcp.list` reports a remote server's `url` on every check, in every status (pending, connected, needs-auth,
       disabled, failed): yes.
  - **Bugs and gaps it found**, all fixed on 2026-10-19 with your OK (details in the spike notes; 6 is under
    Attention below):
    1. The session view showed a task's answer with the runtime's prefix ("User selected: Green") and never offered
       "Save as memory" on it. Now the prefix is taken off.
    2. Sign in called `login` right after creating its session, which fails on the real runtime: in the app, Work IQ
       Mail's Sign in failed with "MCP host is not available on this session". Now it asks for the session's servers
       first (that starts its MCP host), then logs in.
    3. After a Sign in, ARIA's open conversation kept the server signed out: it reopened only when its tools
       changed, and a server that needs signing in still lists its old tools. Now a sign-in to a server ARIA uses
       reopens it before your next message.
    4. ARIA passed no `githubMcpToolConfig`, so neither ARIA nor tasks got GitHub's tools. Now every session
       starts GitHub's default toolset, and GitHub's `<thing>_read/_get/_list` names count as reads (D35).
    5. Microsoft's sign-in page refused ARIA's request (AADSTS901001): the runtime sends the session's id as
       `client_session`, which takes 20–50 characters, and ARIA's sign-in sessions had 56. Now they have 44.
  - [x] **The real Work IQ Sign in** (your click): Customize › Integrations → Work IQ Mail → Sign in → finished in the
    browser → Connected, with its tools listed (2026-10-19, after fixes 2 and 5).
  - [x] **Attention on real Windows** (2026-10-19, guided, the built app on the scripted runtime without the test
    hooks): toasts only while you're away, coalescing, `replaces` taking the first toast out of the notification panel
    (Action Center), a toast's click opening its card, lock and idle as away, and the "while you were away" card. One
    gap: **a toast shown while the screen is locked is dropped by Windows** at once and doesn't reach the notification
    panel. 6. Fixed with your OK: while locked nothing toasts, and on an unlock that leaves you away from ARIA what
    still needs you toasts, 1.5 s after the unlock (Windows gives the window its focus back 0.2 s after reporting the
    unlock, which made an unlock back at ARIA toast). Rechecked on real Windows, both ways.
  - [x] **The Phase 1 and Phase 2 E2E against the real runtime**, after fixes 1–5: both passed (2026-10-19; `phase1`'s
    MCP test skipped, as without `ARIA_E2E_MCP=1`).
  - [x] **Sleep**: this PC sleeps in Modern Standby, which locks the screen first; Electron reports the lock, `suspend`
    and `resume`, and ARIA survived a 30 s sleep (2026-10-19).
  - [x] **A packaged build ignores the test switches**: launched through a copy of Electron named `ARIA.exe`
    (`app.isPackaged` true, which is all the gating reads), with all three switches set: title "ARIA", no hooks, the
    real runtime (2026-10-19). An installer build packs the app differently but uses the same check.

### Phase 10: Actionable sandbox blocks (initial implementation 2026-11-27; M, split into 10A–10C)

**Goal:** a blocked action should stop at a clear permission card instead of making you discover, edit and restart the
sandbox's global settings. You can allow the missing access **once**, for the **current task/session**, or **always**
for that exact, reviewed resource. The default remains sandboxed; the answer never silently turns the whole sandbox
off.

**The problem addressed by the initial implementation.** Before Phase 10, `runtime/copilot.ts` set
`allowBypass: false` and turned a request with `requestSandboxBypass` into a generic `other` request, dropping the
attempted operation and target; `policy/worker.ts` then refused it. Sandboxed reads and URLs outside the grants were
also returned as `never`, so a boundary block could not produce a recovery action. Phase 10A now preserves the
original request, and `allowBypass: true` means only "let ARIA handle this exact pending bypass request"; it does not
approve it. **A policy refusal and a sandbox boundary refusal are separate things.**

The proposed user experience is:

1. The runtime blocks a command, file or host and sends ARIA a structured request. ARIA checks the normal policy first,
   then shows a card: **Blocked by the sandbox**, the exact command or path/URL, what boundary it crossed, why the task
   says it is needed, and the precise access that would be added.
2. The card offers **Allow once**, **Allow for this task**, and **Always allow this exact access**. Reject remains an
   explicit option and can include guidance to the task. The task stays paused until a choice is made; no timeout can
   approve anything.
3. ARIA retries only the request that was approved. The transcript records the block, the chosen scope and the result
   as separate events. A one-time grant is consumed. A task grant is visible and revocable in the session view. A
   persistent grant appears under Customize › Permissions with the same target, access and reason.
4. The choices mean the following (the UI must use these definitions in its help text):
   - **Once**: one exact retry, then the boundary is closed again. The original command/path and sandbox boundary must
     match; another spelling or a later action asks again.
   - **For this task/session**: future requests may be approved only while that same task session is alive, and only when
     their operation and target match the exact grant. It does not disable the sandbox and does not transfer to a
     continuation in a different worktree or session. A worker resume of the same session keeps it; task restart clears
     it. The user can revoke it immediately.
   - **Always**: persist an ARIA-owned, structured, revocable exception for the narrow resource (for example one
     read-only directory or one host), scoped to sandboxed tasks. It does not mean `allow all`, does not save an opaque
     runtime permission, and never converts a `Never` rule or fixed safety refusal into an allow. Secrets, credential
     stores, drive roots, the user's whole profile, another worktree and protected `.git` files still cannot be added.

The card should call out the risk in plain language ("Allows this task to read C:\\…", not "bypass 0x…") and require a
second confirmation for **Always**. A missing or unbounded target, a target ARIA cannot canonicalize, an unreadable
command, or arguments that cannot be shown honestly are refused rather than offered as a broad bypass.

#### 10A. Preserve and classify sandbox blocks (S–M)

- Spike the pinned SDK, without model calls, with a test session that tries one blocked read, write, shell path, and
  outbound host. Record the exact `PermissionRequest` fields, when `requestSandboxBypass` appears, and the behavior of
  `approve-once`, `approve-for-session`, `approve-for-location` and `approve-permanently`. Compare `allowBypass: false`
  and `true` and verify that a rejected bypass leaves the sandbox active. Put the fixture in the recorded SDK event
  tests rather than relying on package types alone; update the SDK notes with any API/version assumption.
- Change the runtime normalization so a sandbox boundary request retains its original kind, exact payload and a
  `sandboxBlock` classification (read/write path, network host, command and working directory). Do not flatten it to
  `other`. Add a stable, canonical identity for the boundary request and a boolean that says whether the runtime can
  safely retry only that request.
- In the worker policy, evaluate fixed/hard rules, destructive-command rules, MCP tool policy and the user's `Never`
  rules first. Only a request whose ordinary policy would otherwise be permitted, and that is blocked **solely by the
  sandbox boundary**, becomes an actionable block. A push/merge fixed rule, destructive action, malformed command,
  protected path, or explicit Never remains a refusal. The existing Ask-every-time rules (D28–D30) keep their current
  scope: a sandbox exception cannot make destructive or external writes auto-run.
- The initial implementation enables runtime bypass requests (`allowBypass`) so the SDK routes a blocked exact
  operation to ARIA's permission handler. Each verdict is still `approve-once`; task scope and persistence are owned
  by ARIA, not by SDK-wide bypass state. Failure to configure the sandbox still fails closed. Do not update the live
  session's sandbox spec globally in response to a card; use a verdict for the one pending request, or a checked ARIA
  grant for later identical requests. A real-runtime probe remains required before this rollout is called complete.
- Keep the runtime's approval result internal to the adapter: ordinary permissions still use ARIA's existing grants;
  sandbox decisions add a scoped `SandboxGrant` verdict. The engine must not confuse SDK "approve for session" with
  unrestricted access.

#### 10B. Scoped grants and recovery UX (M)

- Extend protocol types with a discriminated sandbox block (kind, resource, access, command/cwd where relevant,
  canonical target, reason, and a safe display value), plus the decision scope `once | task | always | reject`.
  Preserve the distinction in `PendingPermission`, the card payload and transcript entries. Do not overload an
  ordinary command rule with arbitrary filesystem/network access.
- Add a `SandboxGrant` collection to task state. Its identity includes operation, canonical target and access mode.
  It starts only after the user approves the task scope, survives resume of that same session, covers all currently
  waiting requests with the same identity, and is revocable. A task grant is cleared on cleanup, rerun or a new session;
  its access is never inherited by a child task.
- Add persistent `SandboxException` records to the policy store for **Always**. Start narrowly with exact read-only
  local paths and exact/wildcard hosts already accepted by sandbox settings. Treat a write-path exception, executable
  shell exception or an exception whose request identity is ambiguous as not persistable until 10C; those cases can
  still offer Once and For this task. Store `createdAt`, reason, access and target, and make deletion immediate for newly
  started or resumed sessions. Migrate existing `allowedPaths` and `allowedHosts` without changing their effective
  access.
- Reuse the existing permission manager and card, but give sandbox blocks their own title, risk explanation and
  primary/secondary buttons. The card opens collapsed details only for the full command; the concise line always shows
  the actual resource. "For this task" is unavailable where the runtime cannot provide a stable identity. "Always" is
  unavailable where the target is outside the safe exception classes. Existing ordinary approval cards and D21 task
  grants stay unchanged.
- After approval, acknowledge the scope in the card receipt and let the worker continue. A one-time approval retries
  exactly once; a task/persistent grant may satisfy a newly emitted identical request by returning the one-request SDK
  result after ARIA has checked its identity. Do not use the runtime's permanent approval API for ARIA's **Always**
  choice; ARIA owns the list so it can validate, display and revoke it.
- On a denied or expired request, send useful feedback back to the worker: which resource was blocked, which option was
  rejected, and whether it should use an in-worktree alternative. Do not suggest changing or disabling the sandbox in
  a way that bypasses the policy checks.

#### 10C. Management, verification and rollout (S–M)

- Add a **Sandbox exceptions** subsection to Customize › Permissions. List target, read/write/network access, scope,
  source (manual, card or task path) and add/revoke controls. Keep the sandbox's Enabled switch and global hosts/paths
  for advanced users, but a card approval writes only the narrow exception required for that action. Warnings for
  GitHub, credentials, broad folders and local network follow the stricter of the current and existing D20 rules.
- Add policy tests for every block class and scope: once is consumed, task identities cannot drift to a different
  working directory/argument/path spelling, Always survives restart and is removable, a user `Never` wins, D28/D29
  destructive commands remain every-time, and hard Git/GitHub rules cannot be bypassed. Include Windows case rules,
  separators, drive-relative paths, 8.3 names, links, encoded URLs and Unicode display values.
- Add task-manager tests for multiple concurrent requests, cancellation/restart, revocation while work is paused,
  stale card clicks, resume, and an ARIA conversational approval that names the right short id. None of the sandbox
  scopes may be inferred from model/task text: only a direct card or validated Conductor decision approves a request.
- Add scripted UI specs for one-time recovery, session recovery, persistent recovery with confirmation/revoke, and a
  fixed-rule refusal that offers no bypass. Add a real-runtime, read-only probe for one blocked reference-file read and
  one disallowed host. With explicit per-action OK, also check one harmless write outside the worktree; stop after the
  result is verified and delete any temporary resource.
- Update §4.8, §5.4, the safety paragraph in `README.md`, and the SDK spike appendix. Record the final semantics as
  decisions in §0.3 when the spike proves them. Keep a feature flag during rollout; turning it off restores the current
  fail-closed behavior and should not alter ordinary permission rules or existing sandbox settings.

**Done when:** from a normal sandboxed task, a blocked read or host produces a card in the one chat; **Allow once**,
**Allow for this task**, and **Always allow this exact access** each complete the intended scope; the task resumes when
it should; and no choice can weaken a hard refusal, a `Never` rule, an external-write confirmation, or the sandbox for
an unrelated action. A user can inspect and revoke every non-one-time grant. Until the Phase 10A spike proves the runtime
behavior, the exact SDK result used for a retry is intentionally unspecified; the trust boundary and scope above are
not.

---

## 11. Things to verify in Phase 0

These are the details the public docs don't fully pin down. **All answered (or explicitly deferred) in
`docs/spike-notes.md` on 2026-10-16.**

1. Does one `CopilotClient` comfortably run 3–5 concurrent sessions (memory, CPU)?
2. Exact payload of `user_input.requested` / `onUserInputRequest` (choices, freeform) and how to
   reply.
3. Can `onPermissionRequest` stay pending for a long time while you're away (minutes or hours)
   without timing out?
4. How to start a session in **plan** or **autopilot** mode from the SDK, and how to answer
   `exit_plan_mode.requested`.
5. How to restrict the Conductor's built-in tools (available/excluded tools config versus just
   rejecting them in the permission handler).
6. Session limits: the config field names for a per-task budget.
7. Billing: what one Conductor turn and one typical worker task cost on your plan (premium requests
   vs AI credits).
8. Does `session.task_complete` fire reliably at the end of autopilot work, or should "done" be
   inferred from `session.idle` + a final message?
9. Behaviour on Windows: long paths in worktrees, shell used for commands (PowerShell vs cmd).
10. `models.list`: which reasoning-effort levels each model supports, and the exact values to
    pass as `reasoningEffort`.
11. `session.setModel(model, options)`: can it change the effort too, and does the change apply
    from the next turn?
12. Auto tier (`setAutoTier`): is it on by default, and how do you switch it off for every session?
13. Sub-agents started by a worker: can their model and effort be pinned (custom agents
    config), or do they pick their own?
14. `session.getEvents()`: does it hold enough (tool calls with arguments and results, permission
    decisions, questions) to rebuild a full transcript in the session view after a restart?
15. Cloud tasks: which models and effort levels are available there?
16. Plugins installed in the CLI are ambient. Can a session's `mcpServers` / `tools` config hide
    them per session, or is `COPILOT_PLUGIN_DIR_ONLY=true` + explicit `pluginDirectories` needed?
17. **Critical for the first draft:** what an `mcp` permission request contains (server name,
    tool name, full arguments). The scope rules and the exact-payload check depend on it. If the
    arguments aren't included, use an SDK pre-tool hook instead, and confirm the hook can block
    the call.
18. Work IQ (license and access confirmed): which of its tools return what the Timekeeper needs
    (meeting times and titles, Teams calls and chats you were in), and how precise they are.
19. The task tracker's MCP server (tool list confirmed): the exact field shapes its time-log create
    tool expects (ISO 8601 with or without offset, comment field name), what it returns per entry on
    partial failure, and (for Phase 7) how the server gets its bearer token, so ARIA's own MCP
    client can start it the same way the CLI does.
20. **Critical for the first draft:** does an SDK session pick up the MCP servers from the CLI's
    own config automatically (not just plugins)? If not, confirm that passing the CLI's config file
    contents through `mcpServers` works, including servers that need a sign-in.
21. Can a short-lived session reliably make one exact tool call from a payload it's given
    (the tracker's time-log create tool with N rows) without reformatting it, so the exact-payload check
    passes?

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| SDK is in technical preview; the API changes | Pin the version; isolate it behind the `AgentRuntime` adapter; keep event fixtures to catch breakage |
| Cost creep (every turn costs) | No model calls for events; you set every model and effort; price category and token prices shown in every dropdown; per-task budgets; cost on every card |
| Models drifting from what you chose | Profiles enforced in code (enum + policy check), auto tier off, warning card on `session.model_change`, model shown everywhere |
| A mail or Teams message contains instructions aimed at ARIA (prompt injection) | Treated as data, never instructions; scopes keep write tools away from sessions that read mail; every write needs your click on a card that shows the payload |
| Wrong time gets registered | Drafts only; plain-code checks for totals, overlaps and duplicates; you review before Submit; per-entry results; registered ids stored |
| Privacy: work data sent to a model | Mail is opt-in and metadata-only; nothing stored beyond what the timesheet needs; check company policy for which models may see Microsoft 365 data |
| Work IQ is in preview and may change or have outages | Wrapped behind an adapter with recorded fixtures; time tracking still works from GitHub, git, the task tracker and ARIA activity, with meetings added by hand |
| A tracker server's generic `api_post` / `api_patch` / `api_delete` tools can change anything | Off ("never") for every session by default; dedicated tools cover everything ARIA needs |
| A model sends something different from what you approved | First draft: ARIA's code compares every write call's arguments with the approved payload before it runs and blocks any difference. Phase 7: writes are made by ARIA's own MCP client, with no model involved. |
| Too many tool descriptions in a session (cost, distraction) | Each session gets only its scope: `disabledMcpServers` plus an exact `availableTools` list (works in the first draft; a full session has ~210 tools and ~24k tokens of system prompt). Out-of-scope calls are still blocked by the permission policy. |
| An agent reports success it didn't achieve (`task_complete.success` was `true` for blocked, uncommitted work in Phase 0) | "Done" always means "needs review"; the Done card shows ARIA's own checks (tests run, commit exists, diff), never just the agent's word. Write results come from tool results, never from the model's reply. |
| A shell rule that names a whole program allows far more than intended (`git` → push anywhere, `node` → any code) | Rules name exact operations (`git commit`, `npm test`) and match the runtime's parsed `commandSegments`; anything else asks. |
| ARIA's sessions clutter the user's Copilot CLI/app session list (shared session store) | Name them (`name`, `clientName`) and delete them on cleanup. |
| The sidebar pulls you back into babysitting sessions | Blocking items still come to the chat; the sidebar is for inspecting and improving, not required for anything |
| One chat gets noisy | Strict priority rules, coalescing, cards that update in place, focus mode |
| Replies go to the wrong task | Buttons and reply-to first; free text only via the Conductor with the `<pending>` list; confirm when unsure |
| Agent does something destructive | Worktree isolation, policy engine, hard rules, no auto-approve on timeout |
| Lost state on crash | Own SQLite state, `interrupted` state, resume flow |
| Windows path and shell quirks | Short worktree root, `core.longpaths`, test commands on Windows early |
| GitHub rate limits | ETags, adaptive intervals, `X-Poll-Interval`, throttling plugin |

---

## 13. Later ideas

- **Auto-answer**: let the Conductor answer simple worker questions from memory ("use pnpm"),
  with an "answered for you" note you can override.
- **Review mode**: ARIA reviews its own PRs with a second model before telling you they're ready.
- **Project dashboards on request**: "show me what changed this week in Moonrise" as a rich card.
- **Multi-agent backends**: because the core talks to an adapter, an ACP-speaking agent
  (`copilot --acp` or others) could be plugged in later.
- **Team mode**: a shared ARIA that posts cards into a team channel.

---

## 14. Sources

The appendices below summarize what was learned from these sources while planning (2026-10-16).

- GitHub Copilot SDK repo: https://github.com/github/copilot-sdk
- Node SDK reference: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
- SDK feature guides (hooks, custom agents, MCP, streaming events, steering, persistence, cloud and
  remote sessions, usage and billing): https://github.com/github/copilot-sdk/blob/main/docs/features/README.md
- Copilot app docs: https://docs.github.com/en/copilot/concepts/agents/github-copilot-app
- Copilot app getting started (sidebar structure: New, My work, Automations, Customize, Search,
  Projects, Chats): https://docs.github.com/en/copilot/how-tos/github-copilot-app/getting-started
- Copilot app agent sessions (sessions grouped by repository):
  https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions
- Copilot CLI ACP server: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- SDK MCP servers (config, tools allowlist, OAuth):
  https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md
- SDK plugin directories (ambient CLI plugins, `COPILOT_PLUGIN_DIR_ONLY`):
  https://github.com/github/copilot-sdk/blob/main/docs/features/plugin-directories.md
- Microsoft Work IQ (Microsoft 365 MCP servers and Copilot CLI plugin): https://github.com/microsoft/work-iq
- Agent 365 / Work IQ MCP servers on Microsoft Learn: https://learn.microsoft.com/en-us/connectors/a365mcpservers/
- GitHub REST: conditional requests and rate limits, Actions runs/jobs/logs, notifications
  (docs.github.com/rest)

---

## Appendix A. Copilot SDK and runtime notes

Collected from the SDK's README and docs on 2026-10-16. The SDK is in technical preview, so check
everything against the current docs before relying on it.

### A.1 Basics

- npm package: `@github/copilot-sdk`. SDKs also exist for Python, Go and .NET (some sources also
  list Java and Rust).
- Architecture: your app → SDK client → JSON-RPC → Copilot CLI in server mode. The SDK starts,
  keeps alive and stops the CLI process. For Node, Python and .NET the CLI is **bundled**; Go needs
  it installed. You can also connect to a CLI server you run yourself (`cliUrl`).
- A Copilot subscription is required unless you use BYOK.
- Auth options: the signed-in CLI user (`useLoggedInUser`), an OAuth GitHub App, environment
  variables (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`), or BYOK (key-based only; no Entra
  ID or managed identities).
- By default, sessions get the CLI's first-party tools, still governed by the permission handler.
  Approving everything (`approveAll`) is the equivalent of `--allow-all`, so always install a
  real permission handler.

### A.2 `CopilotClient`

- Options: `connection` (`RuntimeConnection.forStdio` / `forTcp` / `forUri` / `forInProcess`
  [experimental]), `mode` (`"copilot-cli"` default, or `"empty"`), `workingDirectory`,
  `baseDirectory`, `logLevel`, `env`, `gitHubToken`, `useLoggedInUser`, `onListModels`,
  `telemetry`, `sessionFs`, `sessionIdleTimeoutSeconds`, `enableRemoteSessions`.
- Methods: `start()`, `stop()`, `forceStop()`, `ping()`, `createSession(config)`,
  `resumeSession(sessionId, config)`, `listSessions(filter)` (returns `sessionId`, `startTime`,
  `modifiedTime`, `summary`, `isRemote`, `context` with cwd, gitRoot, repository, branch),
  `deleteSession(id)`, `getForegroundSessionId()`, `setForegroundSessionId(id)`,
  `onLifecycle(handler)`.

### A.3 Session config (`createSession`)

- `sessionId`, `model`, `reasoningEffort`, `streaming`, `workingDirectory`
- `tools` (custom tools; `defineTool(name, { description, parameters (zod or JSON schema),
  handler })`, with optional `overridesBuiltInTool`, `skipPermission`, `defer`)
- `systemMessage` (`mode`: `"append"` default, `"replace"`, `"customize"`)
- `infiniteSessions` (`enabled`, `backgroundCompactionThreshold`, `bufferExhaustionThreshold`)
- `provider` (BYOK: `type` openai/azure/anthropic, `baseUrl`, `apiKey`, `bearerToken`, `wireApi`)
- `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`, `hooks`, `commands`
- `mcpServers`, `pluginDirectories`, custom agents, skills, `memory`
- `cloud: { repository: { owner, name, branch? } }` for cloud sessions; `remote: true` to share a
  local session to GitHub web and mobile

### A.4 Session methods

`send({ prompt, attachments?, mode?: "enqueue" | "immediate" })` returns a message id;
`sendAndWait(options, timeout)`; `on(type, handler)` / `on(handler)` (both return an unsubscribe
function); `abort()`; `getEvents()`; `disconnect()`; `setModel(model, options?)`;
`setTools(tools)`; `setAutoTier(autoTier)`. Also `session.usage.getMetrics` (experimental) and
`session.mcp.*` (MCP management, including `session.mcp.oauth.login`).

### A.5 Events (40+; the ones ARIA uses)

- Assistant: `assistant.turn_start`, `assistant.turn_end`, `assistant.intent` (short live status),
  `assistant.message_delta`, `assistant.message`, `assistant.reasoning_delta`,
  `assistant.reasoning`, `assistant.usage` (tokens, premium-request cost, AI-credit token details, model; ephemeral)
- Tools: `tool.execution_start`, `tool.execution_progress`, `tool.shell_output`,
  `tool.execution_complete` (success, result or error), `tool.user_requested`
- Session: `session.idle` (with `aborted`), `session.error` (`errorType`, `message`,
  `statusCode`), `session.task_complete` (optional `summary`), `session.title_changed`,
  `session.context_changed`, `session.compaction_start` / `_complete`, `session.shutdown`,
  `session.model_change`, `session.usage_info` (context tokens vs limit),
  `session.usage_checkpoint`, `session.session_limits_changed`, `session.warning`
  (`warningType: "policy_blocked"`), `session.start` / `session.info` (cloud sessions)
- Requests: `permission.requested` / `.completed`, `user_input.requested` / `.completed`,
  `elicitation.requested` / `.completed`, `exit_plan_mode.requested` / `.completed`,
  `session_limits_exhausted.requested` / `.completed`
- Sub-agents and skills: `subagent.selected` / `.started` / `.completed` / `.failed` /
  `.deselected`, `skill.invoked`
- Other: `abort`, `user.message`, `system.message`, `external_tool.requested` / `.completed`,
  `command.queued` / `.completed`
- Several events are **ephemeral** and are not replayed on resume (deltas, `session.idle`,
  `assistant.usage`, …). Persist your own state.

### A.6 Permissions

- Request kinds: `shell`, `write`, `read`, `mcp`, `custom-tool`, `url`, `memory`, `hook` (more
  may be added). Fields seen in the docs: `kind`, `toolCallId`, `toolName`, `fileName`,
  `fullCommandText`, `managedApprovalRequired`.
- Results: `approve-once`, `approve-for-session`, `approve-for-location`, `approve-permanently`,
  `reject` (with optional feedback), `user-not-available`, `no-result`.
- Without a handler, requests stay pending for manual resolution.

### A.7 MCP, plugins, skills

- `mcpServers` is a map of name → config. Local: `type: "local"` or `"stdio"`, `command`, `args`,
  optional `env`, `cwd`, `tools`, `timeout`. Remote: `type: "http"` or `"sse"`, `url`, optional
  `headers`, `tools`, `timeout`, and OAuth fields (`oauthClientId`, `oauthScopes`,
  `oauthPublicClient`, `oauthGrantType`). `tools: ["*"]` = all, `[]` = none, or a list of names.
- Remote OAuth: runtime-managed loopback (`session.mcp.oauth.login`), runtime-managed hosted
  callback, or host-managed tokens.
- Plugins bundle skills (`SKILL.md`), custom agents (`agents/*.md`), hooks (`hooks.json`), MCP
  servers (`.mcp.json`) and LSP servers (`.lsp.json`). Pass extra ones with `pluginDirectories`,
  or `--plugin-dir` at CLI launch.
- **Plugins installed in the CLI are ambient**: SDK sessions under the same user config load their MCP
  servers automatically. The docs say `COPILOT_PLUGIN_DIR_ONLY=true` turns that off (only explicit directories);
  in Phase 0 it had no visible effect, while per-session `disabledMcpServers` did work.
- Phase 0: the CLI's own MCP server config **is** loaded automatically (§11 #20), plugin-provided servers too.
  Plugin agents and personal skills only load with `enableConfigDiscovery: true`.

### A.8 Cloud and remote sessions

- Cloud sessions run on GitHub-hosted compute through **Mission Control**, visible at
  `github.com/copilot/tasks/{sessionId}`. They need the cloud-agent entitlement and org policies
  that allow it.
- Wait for `session.start` with `data.producer === "copilot-agent"` before the first `send`: an
  earlier first send is silently dropped. Use a timeout (~60 s).
- `session.info` with `infoType === "remote"` carries the Mission Control URL once; store it.
- Resume with `resumeSession` without passing `cloud` again. Treat `policy_blocked` as final.
- `GITHUB_COPILOT_INTEGRATION_ID` sets the `Copilot-Integration-Id` header.

### A.9 Usage and billing

- `assistant.usage`: per model call, with `model`, `inputTokens`, `outputTokens`, `cost`, `initiator` and
  `copilotUsage.tokenDetails` (nano AI credits per token type). Phase 0: `cost` was 1 on every model call, but the
  session's billed `totalPremiumRequestCost` counted one per user message (agent continuations weren't billed
  again). So totals come from `usage.getMetrics()`, never from summing `cost`.
- `models.list` (raw `client.rpc.models.list`): each model's `billing.tokenPrices` (AI credits per 1M tokens) and
  `modelPickerPriceCategory`. Phase 0: `billing.multiplier` was empty for every model.
- `session.usage.getMetrics` (experimental): `totalNanoAiu` (AI credits in nano units),
  `totalPremiumRequestCost`, and `modelMetrics` per model.
- `account.getQuota`: `quotaSnapshots` keyed by `premium_interactions`, `chat`, `completions`,
  each with `entitlementRequests`, `usedRequests`, `remainingPercentage`, `resetDate`
  (`-1` = unlimited).
- Session limits can cap a session's AI-credit budget; exhaustion raises
  `session_limits_exhausted.requested`.
- How premium requests and AI credits relate is defined by GitHub's billing docs, not the SDK.

### A.10 Other SDK features (not used in the first draft)

Fleet mode (parallel sub-agents within one session), citations, image input, context clearing,
client info, steering and queueing (used for direct messages), session persistence.

### A.11 ACP (Agent Client Protocol), as an alternative

Copilot CLI implements ACP (public preview since 2026-01-28): `copilot --acp` (stdio, NDJSON) or
`copilot --acp --port <n>` (TCP). Clients can create sessions with their own working directory,
send prompts with images and resources, stream updates, answer permission requests and cancel.
TypeScript client library: `@agentclientprotocol/sdk`. ARIA doesn't use it (D5), but the
`AgentRuntime` adapter keeps the door open.

---

## Appendix B. Task tracker tool reference

Each tracker's tools and fields are in its config; see [`docs/trackers.md`](docs/trackers.md).

---

## Appendix C. GitHub Copilot app: background

What ARIA is modeled on. Dates come mostly from secondary news sources and may be slightly off.

- **What it is:** a desktop app (macOS, Windows, Linux) for agent-driven development, built on
  Copilot CLI and integrated with GitHub (repos, branches, CI). Announced at Microsoft Build 2026
  as a technical preview; preview opened to all paid subscribers around 2 June 2026; generally
  available around 17 June 2026 (adding canvases, cloud automations, and BYOK models and MCP
  tools); available on every Copilot plan, including Free and Education, since around 7 July 2026.
- **Sessions:** each session gets its own git worktree and branch, so several agents can work in
  parallel. Sessions run in a cloud sandbox or locally (optionally sandboxed). Modes:
  **Interactive**, **Plan** (approve the plan first) and **Autopilot**. You pick the model and
  reasoning effort per session. Computer use works in local sessions on macOS and Windows.
- **Sidebar:** New · My work (issues, PRs, CI, reviews) · Automations (scheduled or on-demand agent
  tasks) · Customize (plugins, skills, MCP servers, canvases) · Search · **Projects** (connected
  folders or repos, each with its active sessions and a "+" to start a new one; "Add project" from
  a local folder or repository, a GitHub repository, or a repository URL) · Chats (conversations
  without a branch or workspace).
- **Around the prompt box:** a mode dropdown, Changes, Create PR and PR controls.
- **Admin:** for Business and Enterprise plans, the app has its own policy, separate from the
  Copilot CLI policy. Without a subscription, it can run with BYOK.

---

## Appendix D. Work IQ (Microsoft 365)

- Microsoft's own MCP servers for Microsoft 365 data, in **preview**. A third-party guide lists
  separate servers for mail, calendar, Teams, user/org directory, SharePoint, Word and Windows 365
  (unconfirmed by Microsoft's own docs).
- Install in Copilot CLI: `/plugin marketplace add microsoft/work-iq`, then install a plugin such
  as `workiq@work-iq`, and restart the CLI. Standalone: `npm install -g @microsoft/workiq` (runs
  the MCP server via npx; needs Node.js).
- Needs a **Microsoft 365 Copilot license** and **tenant admin consent**.
- Being a preview, features and APIs may change: keep it behind an adapter with recorded fixtures.
