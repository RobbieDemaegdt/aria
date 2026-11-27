/** GitHub access in the window (Customize › Notifications): what it is, in a sentence, and whether Try again can help. */
import type { GitHubState, Watch } from "@aria/protocol";

const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function accessText(github: GitHubState): string {
  switch (github.status) {
    case "off":
      return "This run of ARIA has no GitHub.";
    case "starting":
      return "Checking GitHub CLI's sign-in…";
    case "ok":
      return `ARIA reads GitHub as @${github.login ?? "?"} (${github.source ?? "GitHub CLI's sign-in"}). Watches and your inbox use that account.`;
    case "offline":
      return `GitHub can't be reached right now${github.pausedUntil ? `; ARIA tries again at ${at(github.pausedUntil)}` : ""}. Watches wait meanwhile.`;
    case "rate_limited":
      return `GitHub's rate limit is used up${github.pausedUntil ? ` until ${at(github.pausedUntil)}` : ""}. Watches wait meanwhile.`;
    case "unavailable":
      return `${github.message ?? "ARIA couldn't check GitHub CLI's sign-in with GitHub."}${github.pausedUntil ? ` ARIA tries again at ${at(github.pausedUntil)}.` : ""} Watches wait meanwhile.`;
    default:
      return github.message ?? "ARIA can't read GitHub right now.";
  }
}

/** A problem Try again can help with (shown with the button): not a rate limit (it waits for GitHub's reset). */
export const canRetry = (status: GitHubState["status"]) => status === "no_cli" || status === "signed_out" || status === "token_refused" || status === "offline" || status === "unavailable";

/**
 * The inbox watch in a sentence: why it waits (gh's token can't read notifications, another account) or what fails,
 * over its last good count; `problem` offers the inbox's own Try again. Only while GitHub access is fine: otherwise
 * every watch waits for the access (its `paused` is the access's message), and the access line says so.
 */
export function inboxLine(inbox: Pick<Watch, "status" | "paused" | "error"> | undefined, accessOk: boolean): { text: string; problem: boolean } | undefined {
  if (!inbox) return undefined;
  const problem = accessOk ? (inbox.paused ?? inbox.error) : undefined;
  return problem ? { text: problem, problem: true } : { text: `${inbox.status}.`, problem: false };
}
