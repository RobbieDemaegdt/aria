/**
 * Customize › Prompts (PLAN.md §5.3): ARIA's system prompt, the worker brief template and each profile's
 * instructions, with every saved version kept. The newest version is the one in use; rolling back or resetting saves
 * the older text again as a new version, so nothing is ever lost.
 */
import type { Profile, PromptInfo, PromptVersion } from "@aria/protocol";
import type { Store } from "../store/store.ts";
import { PROMPT_SPECS, templateProblem } from "./templates.ts";

/** Profile instructions are plain text (no placeholders), at most as long as the profile form allows. */
const INSTRUCTIONS_MAX = 4_000;

export class PromptLibrary {
  constructor(
    private readonly deps: {
      db: () => Store;
      profiles: () => Profile[];
      /** Changes a profile's instructions (the profile keeps them; the library keeps their history). */
      setInstructions: (profileId: string, text: string) => void;
    },
  ) {}

  private profileOf(name: string): Profile | undefined {
    if (!name.startsWith("profile:")) return undefined;
    const id = name.slice("profile:".length);
    return this.deps.profiles().find((p) => p.id === id);
  }

  private spec(name: string) {
    if (name === "conductor" || name === "brief") return PROMPT_SPECS[name];
    const profile = this.profileOf(name);
    if (!profile) throw new Error("That prompt doesn't exist anymore.");
    return { label: `Profile: ${profile.name}`, placeholders: [] as string[], required: [] as string[], defaultText: "" };
  }

  /** The text in use: the newest saved version, or the built-in one; a profile's own instructions. */
  active(name: string): string {
    const profile = this.profileOf(name);
    if (profile) return profile.instructions ?? "";
    return this.deps.db().latestPrompt(name)?.text ?? this.spec(name).defaultText;
  }

  info(name: string): PromptInfo {
    const spec = this.spec(name);
    return {
      name,
      label: spec.label,
      text: this.active(name),
      defaultText: spec.defaultText,
      version: this.deps.db().latestPrompt(name)?.version ?? 0,
      placeholders: spec.placeholders,
      required: spec.required,
    };
  }

  list(): PromptInfo[] {
    return ["conductor", "brief", ...this.deps.profiles().map((p) => `profile:${p.id}`)].map((name) => this.info(name));
  }

  history(name: string): PromptVersion[] {
    this.spec(name);
    return this.deps.db().listPromptVersions(name);
  }

  /** Saves a new version (nothing when the text is the same as the one in use). */
  save(name: string, text: string, note?: string): PromptInfo {
    const spec = this.spec(name);
    const profile = this.profileOf(name);
    const value = profile ? text.trim() : text.replace(/\r\n/g, "\n");
    if (profile && value.length > INSTRUCTIONS_MAX) throw new Error(`Profile instructions can be at most ${INSTRUCTIONS_MAX} characters.`);
    const problem = templateProblem(value, spec, { allowEmpty: Boolean(profile) });
    if (problem) throw new Error(problem);
    const current = this.active(name);
    if (value === current) return this.info(name);
    this.baseline(name, current, spec.defaultText);
    this.deps.db().addPromptVersion(name, value, note?.trim() || undefined);
    if (profile) this.deps.setInstructions(profile.id, value);
    return this.info(name);
  }

  rollback(name: string, version: number): PromptInfo {
    const old = this.history(name).find((v) => v.version === version);
    if (!old) throw new Error(`There's no version ${version}.`);
    return this.save(name, old.text, `Back to version ${version}`);
  }

  reset(name: string): PromptInfo {
    return this.save(name, this.spec(name).defaultText, "Back to the built-in text");
  }

  /** A profile's instructions were changed with the profile (Customize › Models): that's a version too. */
  recordProfileEdit(profileId: string, before: string, after: string): void {
    const name = `profile:${profileId}`;
    if (before === after) return;
    this.baseline(name, before, "");
    this.deps.db().addPromptVersion(name, after, "Saved with the profile");
  }

  /** Before the first saved version, the text in use until then (if it isn't the built-in one) becomes version 1, so
   * you can always go back to it. */
  private baseline(name: string, current: string, defaultText: string): void {
    if (this.deps.db().latestPrompt(name) || !current.trim() || current === defaultText) return;
    this.deps.db().addPromptVersion(name, current, "Before your first change");
  }
}
