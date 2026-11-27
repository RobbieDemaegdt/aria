import { CopilotClient, type CopilotClientOptions, type ModelInfo, type SessionConfig } from "@github/copilot-sdk";

export type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

/**
 * The dev shell runs inside the Copilot desktop app, which injects COPILOT_* variables (session id, trampoline
 * port/token, feature flags) and GH_TOKEN. A real ARIA launched by the user would not have them, and passing them
 * on would make the spawned runtime behave like a nested child of that app. So by default the runtime gets the
 * current environment minus those variables. Use --inherit-env (or ARIA_SPIKE_INHERIT_ENV=1) to compare.
 */
const STRIPPED_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
const STRIPPED_PREFIX = "COPILOT_";

export const inheritEnv = process.argv.includes("--inherit-env") || process.env.ARIA_SPIKE_INHERIT_ENV === "1";

export function runtimeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (!inheritEnv && (STRIPPED_KEYS.has(upper) || upper.startsWith(STRIPPED_PREFIX))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export function strippedEnvKeys(): string[] {
  if (inheritEnv) return [];
  return Object.keys(process.env).filter((k) => STRIPPED_KEYS.has(k.toUpperCase()) || k.toUpperCase().startsWith(STRIPPED_PREFIX));
}

export async function startClient(options: CopilotClientOptions & { extraEnv?: Record<string, string> } = {}): Promise<CopilotClient> {
  const { extraEnv, ...rest } = options;
  const client = new CopilotClient({
    env: runtimeEnv(extraEnv),
    logLevel: "warning",
    useLoggedInUser: true,
    ...rest,
  });
  await client.start();
  return client;
}

export function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

export interface ModelChoice {
  model: string;
  reasoningEffort?: ReasoningEffort;
  info?: ModelInfo;
}

/** Billing is token-priced (billing.tokenPrices per 1M tokens); billing.multiplier is not populated (Phase 0 finding). */
function priceOf(m: ModelInfo): number {
  if (m.billing?.multiplier !== undefined) return m.billing.multiplier;
  const prices = m.billing?.tokenPrices;
  return prices ? (prices.inputPrice ?? 0) + (prices.outputPrice ?? 0) : Number.POSITIVE_INFINITY;
}

/**
 * Model for spike sessions: --model / ARIA_SPIKE_MODEL, else the cheapest enabled non-auto model (preferring one
 * that supports reasoning effort, so effort can be tested). Effort: --effort / ARIA_SPIKE_EFFORT, else the lowest
 * level the model supports other than "none".
 */
export async function pickModel(client: CopilotClient, { skip = [] as string[] } = {}): Promise<ModelChoice> {
  const models = await client.listModels();
  const requested = argValue("--model") ?? process.env.ARIA_SPIKE_MODEL;
  let info: ModelInfo | undefined;
  if (requested && skip.length === 0) {
    info = models.find((m) => m.id === requested);
    if (!info) throw new Error(`Model "${requested}" not in listModels(): ${models.map((m) => m.id).join(", ")}`);
  } else {
    const candidates = models
      .filter((m) => m.id !== "auto" && m.policy?.state !== "disabled" && !skip.includes(m.id))
      .sort((a, b) => priceOf(a) - priceOf(b) || a.id.localeCompare(b.id));
    info = candidates.find((m) => m.capabilities.supports.reasoningEffort) ?? candidates[0];
    if (!info) throw new Error("No usable model found");
  }
  const requestedEffort = (argValue("--effort") ?? process.env.ARIA_SPIKE_EFFORT) as ReasoningEffort | undefined;
  const efforts = (info.supportedReasoningEfforts ?? []).filter((e) => (e as string) !== "none");
  const reasoningEffort = requestedEffort ?? efforts[0];
  return { model: info.id, ...(reasoningEffort ? { reasoningEffort } : {}), info };
}

export function describeModel(choice: ModelChoice): string {
  const prices = choice.info?.billing?.tokenPrices;
  const price = prices ? ` · ${prices.inputPrice}/${prices.outputPrice} per 1M in/out` : "";
  return `${choice.model}${choice.reasoningEffort ? ` · ${choice.reasoningEffort}` : ""}${price}`;
}

/** Stops the client, falling back to forceStop after a timeout. */
export async function stopClient(client: CopilotClient, timeoutMs = 20_000): Promise<void> {
  const stopped = client.stop().then((errors) => {
    for (const e of errors) console.warn(`[stop] ${e.message}`);
  });
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref());
  if ((await Promise.race([stopped.then(() => "ok" as const), timer])) === "timeout") {
    console.warn("[stop] graceful stop timed out; forcing");
    await client.forceStop();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
