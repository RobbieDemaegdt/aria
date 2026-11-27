/**
 * The Conductor's system prompt (PLAN.md §9.4): the template from Customize › Prompts (or the built-in one), filled in.
 * Appended to the runtime's default system message. Things that change while the session lives (profiles, the profile
 * rule) are in the tool descriptions instead, which ARIA refreshes.
 */
import { DEFAULT_CONDUCTOR_PROMPT, renderTemplate } from "../prompts/templates.ts";

export interface PromptContext {
  /** Folders where the user's projects live, e.g. C:\Users\…\Documents\GitHub. */
  projectRoots: string[];
  /** Global and project memory notes formatted for the Conductor's system prompt (Phase 6A, completing D23). */
  memory?: string;
}

export function conductorPrompt({ projectRoots, memory }: PromptContext, template: string = DEFAULT_CONDUCTOR_PROMPT): string {
  return renderTemplate(template, {
    projectRoots: projectRoots.join("; ") || "(no project folder configured)",
    memory: memory ?? "",
  });
}
