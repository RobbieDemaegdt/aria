/**
 * Which model and effort each of ARIA's slots uses (the Conductor, the Timekeeper, the utility model), from what's stored
 * and what the runtime offers, and what a change to them comes to. The engine reads, saves and announces the settings.
 */
import type { ConductorSettings, TimekeeperSettings, UtilitySettings } from "@aria/protocol";
import type { RuntimeModel } from "../runtime/types.ts";
import { hhmmToMinutes } from "../timekeeper/checks.ts";
import { DEFAULT_TIMEKEEPER_SETTINGS } from "../timekeeper/session.ts";

/** A model's lowest real reasoning effort ("none" switches reasoning off). */
const defaultEffort = (model: RuntimeModel) => model.efforts.find((e) => e !== "none");

/**
 * The Conductor's model and effort: the stored choice if the runtime still offers it (an unsupported effort falls back
 * to the model's default), else the configured default, else the cheapest enabled lightweight model at its lowest
 * effort. Before the catalog is loaded, the stored choice as is.
 */
export function conductorSettingsFrom(stored: ConductorSettings | undefined, models: readonly RuntimeModel[], defaultModel: string | undefined): ConductorSettings {
  if (models.length === 0) return stored?.model ? stored : {};
  const model = stored?.model ? models.find((m) => m.id === stored.model && m.enabled) : undefined;
  if (!model) return defaultSettings(models, defaultModel);
  const effort = stored?.reasoningEffort && model.efforts.includes(stored.reasoningEffort) ? stored.reasoningEffort : defaultEffort(model);
  return { model: model.id, ...(effort ? { reasoningEffort: effort } : {}) };
}

function defaultSettings(models: readonly RuntimeModel[], defaultModel: string | undefined): ConductorSettings {
  const enabled = models.filter((m) => m.enabled);
  const byPrice = (a: RuntimeModel, b: RuntimeModel) => (a.inputPrice ?? 1e9) + (a.outputPrice ?? 1e9) - ((b.inputPrice ?? 1e9) + (b.outputPrice ?? 1e9)) || a.id.localeCompare(b.id);
  const pick =
    enabled.find((m) => m.id === defaultModel) ??
    [...enabled].filter((m) => m.category === "versatile").sort(byPrice)[0] ??
    [...enabled].filter((m) => m.category === "lightweight").sort(byPrice)[0] ??
    [...enabled].sort(byPrice)[0];
  if (!pick) return {};
  const effort = defaultEffort(pick);
  return { model: pick.id, ...(effort ? { reasoningEffort: effort } : {}) };
}

function defaultTimekeeperModel(models: readonly RuntimeModel[], defaultModel: string | undefined): { model?: string; reasoningEffort?: string } {
  const enabled = models.filter((m) => m.enabled);
  const byPrice = (a: RuntimeModel, b: RuntimeModel) =>
    (a.inputPrice ?? 1e9) + (a.outputPrice ?? 1e9) - ((b.inputPrice ?? 1e9) + (b.outputPrice ?? 1e9)) ||
    a.id.localeCompare(b.id);
  const pick =
    enabled.find((m) => m.id === defaultModel) ??
    [...enabled].filter((m) => m.category === "versatile").sort(byPrice)[0] ??
    [...enabled].filter((m) => m.category === "lightweight").sort(byPrice)[0] ??
    [...enabled].sort(byPrice)[0];
  if (!pick) return {};
  const effort = pick.efforts.includes("medium")
    ? "medium"
    : pick.efforts.includes("low")
      ? "low"
      : defaultEffort(pick);
  return { model: pick.id, ...(effort ? { reasoningEffort: effort } : {}) };
}

/** The extra author names and emails of a list: trimmed, blanks dropped, repeats that differ only in case dropped (the first spelling stays). Anything that isn't a string is dropped. */
export function normalizeOwnAuthors(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function timekeeperSettingsFrom(stored: Partial<TimekeeperSettings> | undefined, models: readonly RuntimeModel[], defaultModel: string | undefined): TimekeeperSettings {
  const ownAuthors = normalizeOwnAuthors(stored?.ownAuthors);
  const base: TimekeeperSettings = {
    expectedMinutes: stored?.expectedMinutes ?? DEFAULT_TIMEKEEPER_SETTINGS.expectedMinutes,
    roundingMinutes: stored?.roundingMinutes ?? DEFAULT_TIMEKEEPER_SETTINGS.roundingMinutes,
    workStart: stored?.workStart ?? DEFAULT_TIMEKEEPER_SETTINGS.workStart,
    workEnd: stored?.workEnd ?? DEFAULT_TIMEKEEPER_SETTINGS.workEnd,
    timesheetTime: stored?.timesheetTime ?? DEFAULT_TIMEKEEPER_SETTINGS.timesheetTime ?? "16:30",
    ...(stored?.defaultMailMinutes !== undefined ? { defaultMailMinutes: stored.defaultMailMinutes } : {}),
    ...(ownAuthors.length > 0 ? { ownAuthors } : {}),
  };
  if (models.length === 0) {
    return {
      ...base,
      ...(stored?.model ? { model: stored.model } : {}),
      ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {}),
    };
  }
  const model = stored?.model ? models.find((m) => m.id === stored.model && m.enabled) : undefined;
  if (!model) {
    const def = defaultTimekeeperModel(models, defaultModel);
    return { ...base, ...def };
  }
  const effort =
    stored?.reasoningEffort && model.efforts.includes(stored.reasoningEffort)
      ? stored.reasoningEffort
      : defaultEffort(model);
  return {
    ...base,
    model: model.id,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** What a change to the Timekeeper's settings comes to, or why it isn't allowed. */
export function patchedTimekeeperSettings(current: TimekeeperSettings, patch: Partial<TimekeeperSettings>, models: readonly RuntimeModel[]): TimekeeperSettings {
  const modelId = patch.model ?? current.model;
  let effort = patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort;

  if (modelId && models.length > 0) {
    const found = models.find((m) => m.id === modelId && m.enabled);
    if (!found) throw new Error(`${modelId} isn't an available model.`);
    if (found.efforts.length === 0) {
      effort = undefined;
    } else if (!effort || !found.efforts.includes(effort)) {
      if (patch.reasoningEffort !== undefined) {
        throw new Error(`${found.name} supports these effort levels: ${found.efforts.join(", ")}.`);
      }
      effort = defaultEffort(found);
    }
  }

  const workStart = patch.workStart ?? current.workStart;
  const workEnd = patch.workEnd ?? current.workEnd;
  if (hhmmToMinutes(workEnd) <= hhmmToMinutes(workStart)) {
    throw new Error("Working-day end time must be after start time.");
  }
  const timesheetTime = patch.timesheetTime ?? current.timesheetTime ?? "16:30";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timesheetTime)) {
    throw new Error("Daily draft time must be between 00:00 and 23:59.");
  }

  const defaultMailMinutes = patch.defaultMailMinutes ?? current.defaultMailMinutes;
  if (defaultMailMinutes !== undefined && (!Number.isInteger(defaultMailMinutes) || defaultMailMinutes < 15 || defaultMailMinutes > 480)) {
    throw new Error("Default email duration must be between 15 and 480 minutes.");
  }

  const ownAuthors = normalizeOwnAuthors(patch.ownAuthors !== undefined ? patch.ownAuthors : current.ownAuthors);

  const next: TimekeeperSettings = {
    expectedMinutes: patch.expectedMinutes ?? current.expectedMinutes,
    roundingMinutes: patch.roundingMinutes ?? current.roundingMinutes,
    workStart,
    workEnd,
    timesheetTime,
    ...(defaultMailMinutes !== undefined ? { defaultMailMinutes } : {}),
    ...(ownAuthors.length > 0 ? { ownAuthors } : {}),
    ...(modelId ? { model: modelId } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
  return next;
}

function defaultUtilityModel(models: readonly RuntimeModel[], defaultModel: string | undefined): { model?: string; reasoningEffort?: string } {
  const enabled = models.filter((m) => m.enabled);
  const byPrice = (a: RuntimeModel, b: RuntimeModel) =>
    (a.inputPrice ?? 1e9) + (a.outputPrice ?? 1e9) - ((b.inputPrice ?? 1e9) + (b.outputPrice ?? 1e9)) ||
    a.id.localeCompare(b.id);
  const pick =
    enabled.find((m) => m.id === defaultModel) ??
    [...enabled].filter((m) => m.category === "lightweight").sort(byPrice)[0] ??
    [...enabled].sort(byPrice)[0];
  if (!pick) return {};
  const effort = pick.efforts.includes("low") ? "low" : defaultEffort(pick);
  return { model: pick.id, ...(effort ? { reasoningEffort: effort } : {}) };
}

export function utilitySettingsFrom(stored: Partial<UtilitySettings> | undefined, models: readonly RuntimeModel[], defaultModel: string | undefined): UtilitySettings {
  const enabled = stored?.enabled === true;
  if (models.length === 0) {
    return {
      enabled,
      ...(stored?.model ? { model: stored.model } : {}),
      ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {}),
    };
  }
  const model = stored?.model ? models.find((m) => m.id === stored.model && m.enabled) : undefined;
  if (!model) {
    const def = defaultUtilityModel(models, defaultModel);
    return { enabled, ...def };
  }
  const effort =
    stored?.reasoningEffort && model.efforts.includes(stored.reasoningEffort)
      ? stored.reasoningEffort
      : defaultEffort(model);
  return {
    enabled,
    model: model.id,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** What a change to the utility model's settings comes to, or why it isn't allowed. */
export function patchedUtilitySettings(current: UtilitySettings, patch: Partial<UtilitySettings>, models: readonly RuntimeModel[]): UtilitySettings {
  const enabled = patch.enabled ?? current.enabled;
  const modelId = patch.model ?? current.model;
  let effort = patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort;

  if (modelId && models.length > 0) {
    const found = models.find((m) => m.id === modelId && m.enabled);
    if (!found) throw new Error(`${modelId} isn't an available model.`);
    if (found.efforts.length === 0) {
      effort = undefined;
    } else if (!effort || !found.efforts.includes(effort)) {
      if (patch.reasoningEffort !== undefined) {
        throw new Error(`${found.name} supports these effort levels: ${found.efforts.join(", ")}.`);
      }
      effort = defaultEffort(found);
    }
  }

  const next: UtilitySettings = {
    enabled,
    ...(modelId ? { model: modelId } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
  return next;
}
