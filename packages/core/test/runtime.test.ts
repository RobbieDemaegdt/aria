import type { CopilotClient } from "@github/copilot-sdk";
import { mergeEntries, type TranscriptEntry } from "@aria/protocol";
import { describe, expect, it, vi } from "vitest";
import { COPILOT_CLI_ENTRA_CLIENT_ID, CopilotRuntime } from "../src/runtime/copilot.ts";
import type { ConductorConfig, PermissionVerdict, RuntimeEvent, WorkerConfig, WorkerPlanDecision, WorkerSandbox } from "../src/runtime/types.ts";

/** A stand-in for the SDK client whose startup handshake finishes when the test says so. */
function slowClient() {
  let finishStart: () => void = () => {};
  const client = {
    start: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    ),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
  };
  return { client, finishStart: () => finishStart() };
}

describe("CopilotRuntime isAlive", () => {
  async function running(ping: () => Promise<unknown>) {
    const { client, finishStart } = slowClient();
    const runtime = new CopilotRuntime(() => Object.assign(client, { ping }) as unknown as CopilotClient);
    const starting = runtime.start();
    finishStart();
    await starting;
    return runtime;
  }

  it("is alive while it answers, and not before it starts or after it stops", async () => {
    const { client } = slowClient();
    expect(await new CopilotRuntime(() => client as unknown as CopilotClient).isAlive()).toBe(false);
    const runtime = await running(async () => ({ message: "pong" }));
    expect(await runtime.isAlive()).toBe(true);
    await runtime.stop();
    expect(await runtime.isAlive()).toBe(false);
  });

  it("isn't when the connection is gone", async () => {
    const runtime = await running(async () => {
      throw new Error("Client not connected");
    });
    expect(await runtime.isAlive()).toBe(false);
  });

  it("isn't when it doesn't answer in time", async () => {
    const runtime = await running(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      let alive: boolean | undefined;
      const asking = runtime.isAlive().then((answer) => {
        alive = answer;
      });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(alive).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await asking;
      expect(alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CopilotRuntime start and stop", () => {
  it("shuts down a client that's still starting instead of leaving it running", async () => {
    const { client, finishStart } = slowClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    const starting = runtime.start();
    const stopping = runtime.stop();
    finishStart();
    await stopping;
    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    expect(client.stop).toHaveBeenCalledTimes(1);
    await expect(runtime.listModels()).rejects.toThrow(/isn't started/);
  });

  it("shares one startup between callers and stops the client it started", async () => {
    const { client, finishStart } = slowClient();
    const factory = vi.fn(() => client as unknown as CopilotClient);
    const runtime = new CopilotRuntime(factory);
    const both = Promise.all([runtime.start(), runtime.start()]);
    finishStart();
    await both;
    expect(factory).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.forceStop).not.toHaveBeenCalled();
  });

  it("force-stops a client whose startup never finishes once the shutdown deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const { client } = slowClient();
      const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
      void runtime.start().catch(() => {
        // Cut short on purpose: what's tested is the stop.
      });
      let stopped = false;
      const stopping = runtime.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(14_000);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      expect(client.forceStop).toHaveBeenCalledTimes(1);
      expect(client.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("configures the Copilot CLI Entra client ID on the connect handshake and falls back on older runtimes", async () => {
    const connectNew = vi.fn(async (_params: Record<string, unknown>) => ({ protocolVersion: 3 }));
    const clientNew = {
      internalRpc: { connect: connectNew },
      verifyProtocolVersion: async function (this: { internalRpc: { connect: typeof connectNew } }) {
        return this.internalRpc.connect({ supportedTaskKinds: ["agent", "client", "shell"] });
      },
      start: async function (this: { verifyProtocolVersion: () => Promise<unknown> }) {
        await this.verifyProtocolVersion();
      },
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
    };
    const runtimeNew = new CopilotRuntime(() => clientNew as unknown as CopilotClient);
    await runtimeNew.start();
    expect(connectNew).toHaveBeenCalledTimes(1);
    expect(connectNew).toHaveBeenCalledWith({
      supportedTaskKinds: ["agent", "client", "shell"],
      entra: { clientId: COPILOT_CLI_ENTRA_CLIENT_ID },
    });
    await runtimeNew.stop();

    const connectLegacy = vi.fn(async (params: Record<string, unknown>) => {
      if ("entra" in params) {
        throw new Error("Invalid connect request: unknown field `entra`, expected one of `enableGitHubTelemetryForwarding`, `clientInfo`, `supportedTaskKinds`");
      }
      return { protocolVersion: 3 };
    });
    const clientLegacy = {
      internalRpc: { connect: connectLegacy },
      verifyProtocolVersion: async function (this: { internalRpc: { connect: typeof connectLegacy } }) {
        return this.internalRpc.connect({ supportedTaskKinds: ["agent", "client", "shell"] });
      },
      start: async function (this: { verifyProtocolVersion: () => Promise<unknown> }) {
        await this.verifyProtocolVersion();
      },
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
    };
    const runtimeLegacy = new CopilotRuntime(() => clientLegacy as unknown as CopilotClient);
    await runtimeLegacy.start();
    expect(connectLegacy).toHaveBeenCalledTimes(2);
    expect(connectLegacy.mock.calls[0]![0]).toMatchObject({ entra: { clientId: COPILOT_CLI_ENTRA_CLIENT_ID } });
    expect(connectLegacy.mock.calls[1]![0]).toEqual({ supportedTaskKinds: ["agent", "client", "shell"] });
    await runtimeLegacy.stop();
  });
});

/** A stand-in for the SDK client and one session, for opening workers. */
function workerClient(updateResult: { success: boolean } = { success: true }) {
  const session = {
    sessionId: "aria-task-1",
    rpc: {
      options: { update: vi.fn(async (_params: unknown) => updateResult) },
      mode: { set: vi.fn(async (_params: unknown) => ({})) },
      agent: { list: vi.fn(async () => ({ agents: [] })) },
      tools: { updateSubagentSettings: vi.fn(async () => ({})) },
    },
    disconnect: vi.fn(async () => {}),
  };
  let config: Record<string, any> = {};
  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    getSessionMetadata: vi.fn(async () => undefined),
    createSession: vi.fn(async (c: Record<string, any>) => {
      config = c;
      return session;
    }),
    resumeSession: vi.fn(async () => session),
    rpc: { sandbox: { getHostSupport: vi.fn(async (): Promise<{ supported: boolean; reason?: string; capabilities: Array<{ name: string; supported: boolean; reason?: string }> }> => ({ supported: true, capabilities: [] })) } },
  };
  return { client, session, config: () => config };
}

const sandbox: WorkerSandbox = {
  readwrite: ["C:\\wt\\repo\\task", "C:\\repo\\.git\\objects"],
  readonly: ["C:\\repo\\.git"],
  allowedHosts: ["registry.npmjs.org"],
  blockedHosts: ["localhost", "127.0.0.1", "::1"],
  initScript: "C:\\wt\\.aria\\sandbox\\aria-env.ps1",
  processFlags: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned"],
};

function workerConfig(extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    sessionId: "aria-task-1",
    name: "ARIA · Task",
    model: "claude-haiku-5.5",
    mode: "autopilot",
    workingDirectory: "C:\\wt\\repo\\task",
    availableTools: [],
    disabledMcpServers: [],
    policy: { decide: () => ({ approve: true }) },
    onQuestion: async () => ({ answer: "", wasFreeform: true }),
    onPlan: async () => ({ approved: true }),
    onEvent: () => {},
    ...extra,
  };
}

describe("CopilotRuntime workers (Phase 3)", () => {
  it("turns the sandbox on with the task's grants before the session gets its mode or any work (D20)", async () => {
    const { client, session } = workerClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    await runtime.openWorker(workerConfig({ sandbox }));
    expect(session.rpc.options.update).toHaveBeenCalledTimes(1);
    expect(session.rpc.options.update.mock.calls[0]![0]).toEqual({
      sandboxConfig: {
        enabled: true,
        addCurrentWorkingDirectory: true,
        allowBypass: false,
        allowDevToolAccess: false,
        sandboxMcpServers: false,
        userPolicy: {
          filesystem: { readwritePaths: sandbox.readwrite, readonlyPaths: sandbox.readonly },
          network: { allowOutbound: true, allowLocalNetwork: true, allowedHosts: sandbox.allowedHosts, blockedHosts: sandbox.blockedHosts },
        },
      },
      sandboxConfigSource: "session_flag",
      shell: { processFlags: sandbox.processFlags, initScripts: [{ path: sandbox.initScript, shell: "powershell" }] },
    });
    expect(session.rpc.options.update.mock.invocationCallOrder[0]!).toBeLessThan(session.rpc.mode.set.mock.invocationCallOrder[0]!);
  });

  it("includes the SDK session workspacePath in the sandbox readwritePaths when reported", async () => {
    const { client, session } = workerClient();
    (session as { workspacePath?: string }).workspacePath = "C:\\Users\\me\\.copilot\\session-state\\aria-task-1";
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    await runtime.openWorker(workerConfig({ sandbox }));
    const sent = session.rpc.options.update.mock.calls[0]![0] as {
      sandboxConfig: { userPolicy: { filesystem: { readwritePaths: string[] } } };
    };
    expect(sent.sandboxConfig.userPolicy.filesystem.readwritePaths).toEqual([
      ...sandbox.readwrite,
      "C:\\Users\\me\\.copilot\\session-state\\aria-task-1",
    ]);
  });

  it("gives a sandboxed task no network at all when no host is allowed (the runtime reads an empty list as any host)", async () => {
    const { client, session } = workerClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    await runtime.openWorker(workerConfig({ sandbox: { ...sandbox, allowedHosts: [] } }));
    const sent = session.rpc.options.update.mock.calls[0]![0] as { sandboxConfig: { userPolicy: { network: unknown } } };
    expect(sent.sandboxConfig.userPolicy.network).toEqual({ allowOutbound: false });
  });

  it("doesn't open a session the runtime won't sandbox, and turns it off for a session that shouldn't have it", async () => {
    const refused = workerClient({ success: false });
    const runtime = new CopilotRuntime(() => refused.client as unknown as CopilotClient);
    await runtime.start();
    await expect(runtime.openWorker(workerConfig({ sandbox }))).rejects.toThrow(/didn't accept the sandbox settings/);
    expect(refused.session.rpc.mode.set).not.toHaveBeenCalled();
    expect(refused.session.disconnect).toHaveBeenCalledTimes(1);

    const plain = workerClient();
    const other = new CopilotRuntime(() => plain.client as unknown as CopilotClient);
    await other.start();
    await other.openWorker(workerConfig());
    expect(plain.session.rpc.options.update.mock.calls[0]![0]).toEqual({ sandboxConfig: { enabled: false }, sandboxConfigSource: "session_flag" });
  });

  it("gives the runtime its own temp folder and needs the sandbox features ARIA uses", async () => {
    const { client } = workerClient();
    const factory = vi.fn((_env: Record<string, string>) => client as unknown as CopilotClient);
    const runtime = new CopilotRuntime(factory);
    await runtime.start({ tempDir: "C:\\wt\\.aria\\tmp" });
    // No program of its own to run here (a stand-in factory is given none): the SDK's own runtime.
    expect(factory).toHaveBeenCalledWith({ TEMP: "C:\\wt\\.aria\\tmp", TMP: "C:\\wt\\.aria\\tmp" }, undefined);
    client.rpc.sandbox.getHostSupport.mockResolvedValueOnce({ supported: false, reason: "No ProcessContainer", capabilities: [] });
    expect(await runtime.sandboxSupport()).toEqual({ supported: false, reason: "No ProcessContainer" });
    client.rpc.sandbox.getHostSupport.mockResolvedValueOnce({ supported: true, capabilities: [{ name: "shell", supported: true }, { name: "network_filtering", supported: false, reason: "Update Windows" }] });
    expect(await runtime.sandboxSupport()).toEqual({ supported: false, reason: "Update Windows" });
    client.rpc.sandbox.getHostSupport.mockResolvedValueOnce({ supported: true, capabilities: [{ name: "shell", supported: true }] });
    expect(await runtime.sandboxSupport()).toEqual({ supported: false, reason: "This PC's sandbox lacks network_filtering." });
    client.rpc.sandbox.getHostSupport.mockResolvedValueOnce({ supported: true, capabilities: [{ name: "shell", supported: true }, { name: "network_filtering", supported: true }] });
    expect(await runtime.sandboxSupport()).toEqual({ supported: true });
  });

  it("answers plan reviews and permission requests the way the runtime expects", async () => {
    const { client, config } = workerClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    let plan: WorkerPlanDecision = { approved: true, mode: "interactive" };
    let verdict: PermissionVerdict = { approve: true };
    const asks: unknown[] = [];
    await runtime.openWorker(
      workerConfig({
        onPlan: async () => plan,
        policy: {
          decide: (ask) => {
            asks.push(ask);
            return verdict;
          },
        },
      }),
    );
    // The runtime starts its GitHub server only for a session that asks (spike 13): the default toolset (D35).
    expect(config().githubMcpToolConfig).toEqual({});
    const request = { summary: "Do it", planContent: "1. a", actions: ["autopilot", "interactive", "exit_only"], recommendedAction: "autopilot" };
    expect(await config().onExitPlanModeRequest(request)).toEqual({ approved: true, selectedAction: "interactive" });
    plan = { approved: false, feedback: "Smaller steps" };
    expect(await config().onExitPlanModeRequest(request)).toEqual({ approved: false, feedback: "Smaller steps" });

    const shell = { kind: "shell", fullCommandText: "npm install x", intention: "Add x", commands: [], commandSegments: [{ fullCommandText: "npm install x" }], possiblePaths: [], possibleUrls: [] };
    verdict = { approve: false, reason: "ARIA is shutting down.", unavailable: true };
    expect(await config().onPermissionRequest(shell)).toEqual({ kind: "user-not-available" });
    verdict = { approve: false, reason: "No." };
    expect(await config().onPermissionRequest(shell)).toEqual({ kind: "reject", feedback: "No." });
    expect(asks[0]).toMatchObject({ kind: "shell", command: "npm install x", intention: "Add x" });
  });

  it("sanitizes session name so it does not contain double quotes or control characters", async () => {
    const { client, config } = workerClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    await runtime.openWorker(
      workerConfig({
        name: 'ARIA · Why does the DepencyResolver.cs have "framework-orchestrator"\nbeing mentioned',
      }),
    );
    expect(config().name).toBe("ARIA · Why does the DepencyResolver.cs have 'framework-orchestrator' being mentioned");
    expect(config().name).not.toContain('"');
    expect(config().name).not.toContain("\n");
  });
});

describe("CopilotRuntime: Sign in (Customize › Integrations)", () => {
  /** A stand-in session like the real runtime's (spike 16): its MCP host starts when its servers are first asked for,
   * and a login before that fails. */
  function signInClient() {
    let asked = 0;
    const statuses = ["pending", "pending", "needs-auth"];
    const session = {
      sessionId: "aria-helper-1",
      rpc: {
        mcp: {
          list: vi.fn(async () => ({ servers: [{ name: "Work IQ Mail", status: statuses[Math.min(asked++, statuses.length - 1)] }] })),
          oauth: {
            login: vi.fn(async (_params: unknown) => {
              if (asked === 0) throw new Error("MCP host is not available on this session");
              return { authorizationUrl: "https://login.example/authorize" };
            }),
          },
        },
      },
      disconnect: vi.fn(async () => {}),
    };
    let config: Record<string, any> = {};
    const client = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      createSession: vi.fn(async (c: Record<string, any>) => {
        config = c;
        return session;
      }),
      deleteSession: vi.fn(async () => {}),
    };
    return { client, session, config: () => config };
  }

  it("asks for the session's servers before the login, and counts their status only from the login on", async () => {
    const { client, session, config } = signInClient();
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const status = (s: string) => config().onEvent({ type: "session.mcp_server_status_changed", data: { serverName: "Work IQ Mail", status: s } });
    const starting = runtime.signIn({ serverName: "Work IQ Mail", sessionId: "aria-helper-1" });
    // While the servers load, the server says where it was: that doesn't end the sign-in.
    await vi.waitFor(() => expect(session.rpc.mcp.list).toHaveBeenCalled());
    status("failed");
    const start = await starting;
    expect(start.url).toBe("https://login.example/authorize");
    expect(session.rpc.mcp.list).toHaveBeenCalledTimes(3);
    expect(session.rpc.mcp.list.mock.invocationCallOrder.at(-1)!).toBeLessThan(session.rpc.mcp.oauth.login.mock.invocationCallOrder[0]!);
    // `done` is told only once its session is gone, so the engine never forgets a helper session that still exists.
    let deleted = false;
    client.deleteSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deleted = true;
    });
    status("connected");
    expect(await start.done).toEqual({ status: "connected" });
    expect(deleted).toBe(true);
    expect(session.disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith("aria-helper-1");
  });

  it("calls off an owned installation's prepared login when it's cancelled before there's a page (review)", async () => {
    const { client, session } = signInClient();
    session.rpc.mcp.list.mockImplementation(async () => ({ servers: [{ name: "Work IQ Mail", status: "needs-auth" }] }));
    const oauth = session.rpc.mcp.oauth as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const abort = new AbortController();
    // Cancelled during the login, after prepareLogin gave its id.
    oauth.prepareLogin = vi.fn(async () => ({ loginId: "login-1" }));
    oauth.login = vi.fn(async () => {
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { authorizationUrl: "https://login.example/authorize" };
    });
    oauth.cancelLogin = vi.fn(async () => {});
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const start = await runtime.signIn({ serverName: "Work IQ Mail", sessionId: "aria-helper-1", installationId: "inst-1", signal: abort.signal });
    expect(start.url).toBeUndefined();
    expect(await start.done).toEqual({ status: "cancelled" });
    expect(oauth.cancelLogin).toHaveBeenCalledWith({ expectedInstallationId: "inst-1", loginId: "login-1" });
    expect(oauth.cancelLogin.mock.invocationCallOrder[0]!).toBeLessThan(session.disconnect.mock.invocationCallOrder[0]!);

    // Cancelled while the login was being prepared (its id came after the cleanup started).
    const second = new AbortController();
    oauth.prepareLogin = vi.fn(async () => {
      second.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { loginId: "login-2" };
    });
    oauth.login = vi.fn(async () => ({ authorizationUrl: "https://login.example/authorize" }));
    const again = await runtime.signIn({ serverName: "Work IQ Mail", sessionId: "aria-helper-2", installationId: "inst-1", signal: second.signal });
    expect(again.url).toBeUndefined();
    expect(await again.done).toEqual({ status: "cancelled" });
    expect(oauth.cancelLogin).toHaveBeenCalledWith({ expectedInstallationId: "inst-1", loginId: "login-2" });
    expect(oauth.login).not.toHaveBeenCalled();
  });

  it("can be cancelled while the servers load: no login, and cancel returns once its session is deleted (review)", async () => {
    const { client, session } = signInClient();
    // The servers keep loading (the real wait can last up to 30 s).
    session.rpc.mcp.list.mockImplementation(async () => ({ servers: [{ name: "Work IQ Mail", status: "pending" }] }));
    // Deleting takes longer than a turn of the loop, so the sign-in returns before its session is gone.
    let deleted = false;
    client.deleteSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      deleted = true;
    });
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const abort = new AbortController();
    const starting = runtime.signIn({ serverName: "Work IQ Mail", sessionId: "aria-helper-1", signal: abort.signal });
    await vi.waitFor(() => expect(session.rpc.mcp.list).toHaveBeenCalledTimes(2));
    const asked = Date.now();
    abort.abort();
    const start = await starting;
    expect(Date.now() - asked).toBeLessThan(2_000);
    expect(start.url).toBeUndefined();
    expect(session.rpc.mcp.oauth.login).not.toHaveBeenCalled();
    expect(deleted).toBe(false);
    await start.cancel();
    expect(deleted).toBe(true);
    expect(await start.done).toEqual({ status: "cancelled" });
    expect(session.disconnect).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledTimes(1);

    // Cancelled before it starts: its servers aren't even asked for.
    const calls = session.rpc.mcp.list.mock.calls.length;
    const before = new AbortController();
    before.abort();
    const none = await runtime.signIn({ serverName: "Work IQ Mail", sessionId: "aria-helper-2", signal: before.signal });
    expect(await none.done).toEqual({ status: "cancelled" });
    expect(session.rpc.mcp.list.mock.calls.length).toBe(calls);
    expect(session.rpc.mcp.oauth.login).not.toHaveBeenCalled();
  });
});

describe("CopilotRuntime: ARIA's own session for the inspector (PLAN.md §5.3)", () => {
  /** SDK events as the runtime sends them: a typed message has no `source` (and here no `messageId`), and what the model
   * sees (`transformedContent`) isn't the message as sent (`content`). */
  function sdkEvents() {
    let n = 0;
    const at = (i: number) => new Date(Date.UTC(2026, 9, 17, 9, 0, i)).toISOString();
    const make = (type: string, data: Record<string, unknown>) => ({ id: `ev-${++n}`, parentId: null, timestamp: at(n), type, data });
    const prompt = `<updates since your last message>\n- [done] "Dark mode" (App): done.\n</updates>\n\n${"Tell me about my day. ".repeat(500)}`;
    const answer = `You have three meetings today. The invite says:\n\n\`\`\`text\n${"agenda line\n".repeat(550)}`;
    return {
      prompt,
      answer,
      events: [
        make("user.message", { content: prompt, transformedContent: `<current_datetime>2026-10-17T09:00:00</current_datetime>\n${prompt}` }),
        make("user.message", { content: "<system_notification>A background task finished.</system_notification>", source: "system", transformedContent: "<system_notification>…" }),
        make("tool.execution_start", { toolCallId: "t1", toolName: "Work-IQ-Calendar-ListCalendarView", mcpServerName: "Work IQ Calendar", mcpToolName: "ListCalendarView", arguments: { start: "2026-10-17" } }),
        make("permission.requested", { requestId: "p1", permissionRequest: { kind: "mcp", serverName: "Work IQ Calendar", toolName: "Work-IQ-Calendar-ListCalendarView", args: {}, readOnly: false, toolCallId: "t1" } }),
        make("permission.completed", { requestId: "p1", result: { kind: "approved" } }),
        make("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "e".repeat(25_000) } }),
        make("assistant.message", { messageId: "m1", content: answer }),
        make("session.compaction_complete", { success: true, messagesRemoved: 40, summaryContent: "Earlier: the user asked about Moonrise." }),
      ],
    };
  }

  function conductorClient(events: unknown[]) {
    const session = {
      sessionId: "aria-conductor",
      getEvents: vi.fn(async () => events),
      send: vi.fn(async () => "msg-1"),
      disconnect: vi.fn(async () => {}),
    };
    let config: Record<string, any> = {};
    const client = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      getSessionMetadata: vi.fn(async () => undefined),
      createSession: vi.fn(async (c: Record<string, any>) => {
        config = c;
        return session;
      }),
      resumeSession: vi.fn(async () => session),
    };
    return { client, session, config: () => config };
  }

  const conductorConfig = (onEvent: (event: RuntimeEvent) => void): ConductorConfig => ({
    sessionId: "aria-conductor",
    name: "ARIA",
    model: "claude-haiku-5.5",
    workingDirectory: "C:\\Users\\me\\Documents\\GitHub",
    systemPrompt: "You are ARIA.",
    tools: [],
    availableTools: [],
    disabledMcpServers: [],
    policy: { decide: () => ({ approve: true }) },
    onEvent,
  });

  it("maps the runtime's real event shapes the same way live and from getEvents()", async () => {
    const sdk = sdkEvents();
    const { prompt, events } = sdk;
    expect(sdk.answer.length).toBeGreaterThan(6_000);
    const { client, session, config } = conductorClient(events);
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const live: TranscriptEntry[] = [];
    const handle = await runtime.openConductor(conductorConfig((event) => (event.type === "transcript" ? live.push(...event.entries) : undefined)));
    for (const event of events) config().onEvent(event);

    expect(config().githubMcpToolConfig).toEqual({});
    const history = await handle.getTranscript();
    expect(session.getEvents).toHaveBeenCalledTimes(1);
    // What arrived live, merged by id, is what the history gives.
    expect(mergeEntries([], live)).toEqual(history);
    const [typed, added, tool, permission, answer, compaction] = history;
    // Your message as sent, whole (over 10,000 characters), not what the model saw.
    expect(prompt.length).toBeGreaterThan(10_000);
    expect(typed).toEqual({ kind: "user", id: "ev-1", at: Date.parse("2026-10-17T09:00:01Z"), text: prompt });
    expect(added).toMatchObject({ kind: "user", source: "system", text: "<system_notification>A background task finished.</system_notification>" });
    expect(tool).toMatchObject({ kind: "tool", name: "Work IQ Calendar/ListCalendarView", success: true, resultCut: 5_000 });
    expect((tool as { result: string }).result).toHaveLength(20_000);
    expect(permission).toMatchObject({ kind: "permission", approved: true, toolCallId: "t1" });
    // Its answer whole, as in the chat (6,000+ characters, an open code block included).
    expect(answer).toEqual({ kind: "assistant", id: "m1", at: Date.parse("2026-10-17T09:00:07Z"), text: sdk.answer });
    expect(compaction).toMatchObject({ kind: "info", detail: "Earlier: the user asked about Moonrise." });
  });
});
