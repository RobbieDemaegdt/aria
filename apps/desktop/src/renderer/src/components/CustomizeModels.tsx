import type { ModelOption, Profile, ProfilePolicy, TaskMode, TimesheetRounding } from "@aria/protocol";
import { Pencil, Plus, Star, Trash } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { selectAgents, useAria } from "../store";
import { AgentSelectOptions } from "./AgentOptions";

const PRICE_WORDS: Record<string, string> = { low: "Low cost", medium: "Medium cost", high: "High cost", very_high: "Very high cost" };
const CATEGORY_ORDER = ["lightweight", "versatile", "powerful"];
const CATEGORY_LABELS: Record<string, string> = { lightweight: "Lightweight", versatile: "Versatile", powerful: "Powerful", other: "Other" };

/** The box of extra commit authors holds one name or email per line. The engine keeps at most 50 of at most 200 characters (`SetTimekeeperSettingsInput`). */
export const authorLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
export const authorLinesOk = (lines: readonly string[]): boolean => lines.length <= 50 && lines.every((l) => l.length <= 200);

const priceWord = (m: ModelOption) => (m.priceCategory ? (PRICE_WORDS[m.priceCategory] ?? m.priceCategory) : "Price unknown");
const effortLabel = (e: string) => (e === "none" ? "None (no reasoning)" : e === "xhigh" ? "Extra high" : e[0]!.toUpperCase() + e.slice(1));

/** Customize › Models (PLAN.md §4.12): the ARIA (Conductor) slot and worker profiles. Billing is token-based (§4.11). */
export function CustomizeModels() {
  const models = useAria((s) => s.models);
  const conductor = useAria((s) => s.conductor);
  const save = useAria((s) => s.saveConductorModel);
  const actionError = useAria((s) => s.actionError);
  const clearError = useAria((s) => s.clearError);
  const [model, setModel] = useState(conductor.model ?? "");
  const [effort, setEffort] = useState(conductor.reasoningEffort ?? "");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // The catalog comes with the app state and the engine's `models` event, so there's nothing to fetch here.
  useEffect(() => {
    clearError();
  }, [clearError]);

  useEffect(() => {
    setModel(conductor.model ?? "");
    setEffort(conductor.reasoningEffort ?? "");
  }, [conductor.model, conductor.reasoningEffort]);

  const selected = models.find((m) => m.id === model);

  useEffect(() => {
    if (!selected) return;
    if (selected.efforts.length === 0) setEffort("");
    else if (!selected.efforts.includes(effort)) setEffort(selected.efforts.find((e) => e !== "none") ?? selected.efforts[0]!);
  }, [selected, effort]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, ModelOption[]>();
    for (const m of models) {
      const key = m.category && CATEGORY_ORDER.includes(m.category) ? m.category : "other";
      byCategory.set(key, [...(byCategory.get(key) ?? []), m]);
    }
    return [...CATEGORY_ORDER, "other"].filter((k) => byCategory.has(k)).map((k) => ({ key: k, models: byCategory.get(k)! }));
  }, [models]);

  const unchanged = model === (conductor.model ?? "") && effort === (conductor.reasoningEffort ?? "");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 p-6">
        <section className="space-y-4 rounded-lg border border-line bg-panel p-4" data-testid="conductor-model">
          <div>
            <div className="font-medium">ARIA (the chat)</div>
            <div className="text-xs text-muted">
              The model and reasoning effort ARIA uses to understand you and answer. A fast model with low effort is a good start: the heavy
              work happens in background tasks later.
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="conductor-model" className="block text-xs text-muted">
              Model
            </label>
            <select
              id="conductor-model"
              data-testid="model-select"
              aria-describedby={selected ? "conductor-model-price" : undefined}
              value={model}
              onChange={(e) => {
                setSaved(false);
                setModel(e.target.value);
              }}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 outline-none focus:border-accent"
            >
              {!selected && <option value="">{models.length ? "Choose a model" : "Loading models…"}</option>}
              {groups.map((g) => (
                <optgroup key={g.key} label={CATEGORY_LABELS[g.key]}>
                  {g.models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.enabled}>
                      {m.name} · {priceWord(m)}
                      {m.enabled ? "" : " (not available)"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selected && (
              <span id="conductor-model-price" className="block text-xs text-muted" data-testid="model-price">
                {priceWord(selected)} · {selected.inputPrice ?? "?"} / {selected.outputPrice ?? "?"} AI credits per 1M input / output tokens
              </span>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-muted">Reasoning effort</span>
            <select
              data-testid="effort-select"
              value={effort}
              disabled={!selected || selected.efforts.length === 0}
              onChange={(e) => {
                setSaved(false);
                setEffort(e.target.value);
              }}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 outline-none focus:border-accent disabled:opacity-60"
            >
              {selected && selected.efforts.length === 0 && <option value="">Not configurable for this model</option>}
              {selected?.efforts.map((e) => (
                <option key={e} value={e}>
                  {effortLabel(e)}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-3">
            <button
              data-testid="save-model"
              disabled={!selected || unchanged || saving}
              onClick={async () => {
                setSaved(false);
                setSaving(true);
                try {
                  if (await save(model, effort || undefined)) setSaved(true);
                } finally {
                  setSaving(false);
                }
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="text-xs text-ok" data-testid="saved">Saved. Applies from your next message.</span>}
            {actionError && <span className="text-xs text-bad">{actionError}</span>}
          </div>
        </section>

        <WorkerProfiles groups={groups} />

        <DailyBudgetSlot />

        <TimekeeperSlot groups={groups} />

        <UtilitySlot groups={groups} />
      </div>
    </div>
  );
}

/** Phase 9 (PLAN.md §4.11, D75): Optional daily AI-credit budget across all tasks and budget warning threshold. */
function DailyBudgetSlot() {
  const budget = useAria((s) => s.budget);
  const saveBudget = useAria((s) => s.saveBudgetSettings);
  const [dailyCap, setDailyCap] = useState(
    budget?.dailyBudgetCredits !== undefined && budget?.dailyBudgetCredits !== null
      ? String(budget.dailyBudgetCredits)
      : "",
  );
  const [warnPct, setWarnPct] = useState(String(budget?.budgetWarningPercent ?? 80));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDailyCap(
      budget?.dailyBudgetCredits !== undefined && budget?.dailyBudgetCredits !== null
        ? String(budget.dailyBudgetCredits)
        : "",
    );
    setWarnPct(String(budget?.budgetWarningPercent ?? 80));
  }, [budget?.dailyBudgetCredits, budget?.budgetWarningPercent]);

  const parsedCap = dailyCap.trim() ? Number(dailyCap.trim()) : null;
  const capOk = parsedCap === null || (Number.isFinite(parsedCap) && parsedCap >= 0.1 && parsedCap <= 100_000);
  const parsedWarn = Math.round(Number(warnPct));
  const warnOk = Number.isFinite(parsedWarn) && parsedWarn >= 50 && parsedWarn <= 99;
  const currentCap = budget?.dailyBudgetCredits ?? null;
  const currentWarn = budget?.budgetWarningPercent ?? 80;
  const unchanged = parsedCap === currentCap && parsedWarn === currentWarn;

  return (
    <section className="space-y-4 rounded-lg border border-line bg-panel p-4" data-testid="daily-budget">
      <div>
        <div className="font-medium">Daily budget &amp; alerts</div>
        <div className="text-xs text-muted">
          Optional daily AI-credit cap across all background tasks, plus the percentage threshold at which ARIA warns
          you before a task or daily budget is reached.
        </div>
      </div>

      {budget && (
        <div className="rounded-md border border-line bg-canvas/50 px-3 py-2 text-xs" data-testid="daily-budget-status">
          <span className="font-medium">Today ({budget.date}):</span>{" "}
          <span>
            {budget.usedCredits} AI credits used
            {budget.dailyBudgetCredits
              ? ` of ${budget.dailyBudgetCredits} daily budget (${Math.round((budget.usedCredits / budget.dailyBudgetCredits) * 100)}%)`
              : " (no daily cap)"}
          </span>
          {budget.limitReached && <span className="ml-2 text-bad">· Daily budget reached</span>}
          {!budget.limitReached && budget.warningReached && <span className="ml-2 text-warn">· Near daily budget</span>}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-muted">Daily AI-credit budget (optional)</span>
          <input
            data-testid="daily-budget-cap"
            inputMode="decimal"
            value={dailyCap}
            onChange={(e) => {
              setSaved(false);
              setDailyCap(e.target.value);
            }}
            placeholder="No daily limit"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          {!capOk && (
            <span className="block text-xs text-bad" data-testid="daily-budget-cap-error">
              Enter 0.1 to 100,000 credits, or leave empty for no daily limit.
            </span>
          )}
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted">Warning threshold (%)</span>
          <input
            data-testid="daily-budget-warn-pct"
            inputMode="numeric"
            value={warnPct}
            onChange={(e) => {
              setSaved(false);
              setWarnPct(e.target.value);
            }}
            placeholder="80"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          {!warnOk && (
            <span className="block text-xs text-bad" data-testid="daily-budget-warn-error">
              Warning threshold must be between 50% and 99%.
            </span>
          )}
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          data-testid="save-daily-budget"
          disabled={!capOk || !warnOk || unchanged || saving}
          onClick={async () => {
            setSaved(false);
            setSaving(true);
            try {
              if (
                await saveBudget({
                  dailyBudgetCredits: parsedCap,
                  budgetWarningPercent: parsedWarn,
                })
              ) {
                setSaved(true);
              }
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="text-xs text-ok" data-testid="daily-budget-saved">
            Saved.
          </span>
        )}
      </div>
    </section>
  );
}

/** Phase 6B (PLAN.md §4.12, §10 Phase 6B): Optional Utility model slot for AI-written summaries (morning brief). */
function UtilitySlot({ groups }: { groups: Array<{ key: string; models: ModelOption[] }> }) {
  const models = useAria((s) => s.models);
  const utility = useAria((s) => s.utility);
  const saveUtility = useAria((s) => s.saveUtilitySettings);
  const [enabled, setEnabled] = useState(utility.enabled);
  const [model, setModel] = useState(utility.model ?? "");
  const [effort, setEffort] = useState(utility.reasoningEffort ?? "");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(utility.enabled);
    setModel(utility.model ?? "");
    setEffort(utility.reasoningEffort ?? "");
  }, [utility.enabled, utility.model, utility.reasoningEffort]);

  const selected = models.find((m) => m.id === model);
  useEffect(() => {
    if (!selected) return;
    if (selected.efforts.length === 0) setEffort("");
    else if (!selected.efforts.includes(effort)) setEffort(selected.efforts.find((e) => e !== "none") ?? selected.efforts[0]!);
  }, [selected, effort]);

  const unchanged =
    enabled === utility.enabled &&
    model === (utility.model ?? "") &&
    effort === (utility.reasoningEffort ?? "");

  return (
    <section className="space-y-4 rounded-lg border border-line bg-panel p-4" data-testid="utility-model">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">Utility model (optional summaries)</div>
          <div className="text-xs text-muted">
            Optional cheap model for writing a short prose overview on your Morning brief card. When off (default),
            ARIA uses its deterministic plain-code digest at zero credit cost.
          </div>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg">
          <input
            type="checkbox"
            data-testid="utility-enabled"
            checked={enabled}
            onChange={(e) => {
              setSaved(false);
              setEnabled(e.target.checked);
            }}
          />
          <span>{enabled ? "Enabled" : "Off (plain-code digest)"}</span>
        </label>
      </div>

      {enabled && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted">Model</span>
            <select
              data-testid="utility-model-select"
              value={model}
              onChange={(e) => {
                setSaved(false);
                setModel(e.target.value);
              }}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              {!selected && <option value="">{models.length ? "Choose a model" : "Loading models…"}</option>}
              {groups.map((g) => (
                <optgroup key={g.key} label={CATEGORY_LABELS[g.key]}>
                  {g.models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.enabled}>
                      {m.name} · {priceWord(m)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted">Reasoning effort</span>
            <select
              data-testid="utility-effort-select"
              value={effort}
              disabled={!selected || selected.efforts.length === 0}
              onChange={(e) => {
                setSaved(false);
                setEffort(e.target.value);
              }}
              className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60"
            >
              {selected && selected.efforts.length === 0 && <option value="">Not configurable</option>}
              {selected?.efforts.map((e) => (
                <option key={e} value={e}>
                  {effortLabel(e)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          data-testid="utility-save"
          disabled={(enabled && !selected) || unchanged || saving}
          onClick={async () => {
            setSaved(false);
            setSaving(true);
            try {
              if (
                await saveUtility({
                  enabled,
                  ...(model ? { model } : {}),
                  ...(effort ? { reasoningEffort: effort } : {}),
                })
              ) {
                setSaved(true);
              }
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="text-xs text-ok" data-testid="utility-saved">
            Saved.
          </span>
        )}
      </div>
    </section>
  );
}

/** Phase 5C (PLAN.md §4.12, §4.14): the Timekeeper's model + effort slot and daily timesheet settings. */
function TimekeeperSlot({ groups }: { groups: Array<{ key: string; models: ModelOption[] }> }) {
  const models = useAria((s) => s.models);
  const timekeeper = useAria((s) => s.timekeeper);
  const saveTimekeeper = useAria((s) => s.saveTimekeeperSettings);
  const [model, setModel] = useState(timekeeper.model ?? "");
  const [effort, setEffort] = useState(timekeeper.reasoningEffort ?? "");
  const [expectedHours, setExpectedHours] = useState(String((timekeeper.expectedMinutes ?? 480) / 60));
  const [rounding, setRounding] = useState<TimesheetRounding>(timekeeper.roundingMinutes ?? 15);
  const [workStart, setWorkStart] = useState(timekeeper.workStart ?? "09:00");
  const [workEnd, setWorkEnd] = useState(timekeeper.workEnd ?? "17:00");
  const [timesheetTime, setTimesheetTime] = useState(timekeeper.timesheetTime ?? "16:30");
  const storedAuthors = (timekeeper.ownAuthors ?? []).join("\n");
  const [authorsText, setAuthorsText] = useState(storedAuthors);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModel(timekeeper.model ?? "");
    setEffort(timekeeper.reasoningEffort ?? "");
    setExpectedHours(String((timekeeper.expectedMinutes ?? 480) / 60));
    setRounding(timekeeper.roundingMinutes ?? 15);
    setWorkStart(timekeeper.workStart ?? "09:00");
    setWorkEnd(timekeeper.workEnd ?? "17:00");
    setTimesheetTime(timekeeper.timesheetTime ?? "16:30");
    setAuthorsText(storedAuthors);
  }, [timekeeper.model, timekeeper.reasoningEffort, timekeeper.expectedMinutes, timekeeper.roundingMinutes, timekeeper.workStart, timekeeper.workEnd, timekeeper.timesheetTime, storedAuthors]);

  const selected = models.find((m) => m.id === model);
  useEffect(() => {
    if (!selected) return;
    if (selected.efforts.length === 0) setEffort("");
    else if (!selected.efforts.includes(effort)) setEffort(selected.efforts.find((e) => e !== "none") ?? selected.efforts[0]!);
  }, [selected, effort]);

  const parsedExpectedMinutes = Math.round(Number(expectedHours) * 60);
  const expectedOk = Number.isFinite(parsedExpectedMinutes) && parsedExpectedMinutes >= 60 && parsedExpectedMinutes <= 1440;
  const authors = authorLines(authorsText);
  const authorsOk = authorLinesOk(authors);
  const unchanged =
    authors.join("\n") === storedAuthors &&
    model === (timekeeper.model ?? "") &&
    effort === (timekeeper.reasoningEffort ?? "") &&
    parsedExpectedMinutes === timekeeper.expectedMinutes &&
    rounding === timekeeper.roundingMinutes &&
    workStart === timekeeper.workStart &&
    workEnd === timekeeper.workEnd &&
    timesheetTime === (timekeeper.timesheetTime ?? "16:30");

  return (
    <section className="space-y-4 rounded-lg border border-line bg-panel p-4" data-testid="timekeeper-model">
      <div>
        <div className="font-medium">Timekeeper (daily timesheet)</div>
        <div className="text-xs text-muted">
          The model, reasoning effort, and daily schedule the Timekeeper uses when preparing your timesheet draft. Plain code checks all times,
          rounding, overlaps, duplicates, and task → project/customer IDs.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-muted">Model</span>
          <select
            data-testid="timekeeper-model-select"
            value={model}
            onChange={(e) => {
              setSaved(false);
              setModel(e.target.value);
            }}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {!selected && <option value="">{models.length ? "Choose a model" : "Loading models…"}</option>}
            {groups.map((g) => (
              <optgroup key={g.key} label={CATEGORY_LABELS[g.key]}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.enabled}>
                    {m.name} · {priceWord(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted">Reasoning effort</span>
          <select
            data-testid="timekeeper-effort-select"
            value={effort}
            disabled={!selected || selected.efforts.length === 0}
            onChange={(e) => {
              setSaved(false);
              setEffort(e.target.value);
            }}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60"
          >
            {selected && selected.efforts.length === 0 && <option value="">Not configurable</option>}
            {selected?.efforts.map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && (
        <div className="text-xs text-muted" data-testid="timekeeper-model-price">
          {priceWord(selected)} · {selected.inputPrice ?? "?"} / {selected.outputPrice ?? "?"} AI credits per 1M input / output tokens
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <label className="block space-y-1">
          <span className="text-xs text-muted">Expected hours / day</span>
          <input
            data-testid="timekeeper-expected-hours"
            inputMode="decimal"
            value={expectedHours}
            onChange={(e) => {
              setSaved(false);
              setExpectedHours(e.target.value);
            }}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Rounding (minutes)</span>
          <select
            data-testid="timekeeper-rounding"
            value={rounding}
            onChange={(e) => {
              setSaved(false);
              setRounding(Number(e.target.value) as TimesheetRounding);
            }}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
          >
            {[1, 5, 10, 15, 30].map((step) => (
              <option key={step} value={step}>
                {step} min
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Workday start</span>
          <input
            data-testid="timekeeper-work-start"
            value={workStart}
            onChange={(e) => {
              setSaved(false);
              setWorkStart(e.target.value);
            }}
            placeholder="09:00"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Workday end</span>
          <input
            data-testid="timekeeper-work-end"
            value={workEnd}
            onChange={(e) => {
              setSaved(false);
              setWorkEnd(e.target.value);
            }}
            placeholder="17:00"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Daily draft time</span>
          <input
            data-testid="timekeeper-draft-time"
            value={timesheetTime}
            onChange={(e) => {
              setSaved(false);
              setTimesheetTime(e.target.value);
            }}
            placeholder="16:30"
            className="w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted">Other commit authors that count as yours</span>
        <textarea
          data-testid="timekeeper-own-authors"
          rows={2}
          value={authorsText}
          onChange={(e) => {
            setSaved(false);
            setAuthorsText(e.target.value);
          }}
          placeholder="One name or email per line"
          className="w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-sm outline-none focus:border-accent"
        />
        <span className="block text-xs text-muted">
          Commits under your git name or email, your GitHub login, and the tasks' own branches always count. Add a work identity or a bot account here. A line has to match the
          commit author's name or email exactly (capitals don't matter).
        </span>
        {!authorsOk && (
          <span className="block text-xs text-bad" data-testid="timekeeper-own-authors-error">
            At most 50 lines, of 200 characters each.
          </span>
        )}
      </label>

      <div className="flex items-center gap-3">
        <button
          data-testid="save-timekeeper-model"
          disabled={!selected || !expectedOk || !authorsOk || unchanged || saving}
          onClick={async () => {
            setSaved(false);
            setSaving(true);
            try {
              if (
                await saveTimekeeper({
                  model,
                  ...(effort ? { reasoningEffort: effort } : {}),
                  expectedMinutes: parsedExpectedMinutes,
                  roundingMinutes: rounding,
                  workStart,
                  workEnd,
                  timesheetTime,
                  ownAuthors: authors,
                })
              ) {
                setSaved(true);
              }
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="text-xs text-ok" data-testid="timekeeper-saved">
            Saved.
          </span>
        )}
      </div>
    </section>
  );
}

type ProfileDraft = { id?: string; name: string; description: string; model: string; reasoningEffort: string; agent: string; mode: TaskMode; instructions: string; budget: string };

const toDraft = (p?: Profile): ProfileDraft => ({
  ...(p ? { id: p.id } : {}),
  name: p?.name ?? "",
  description: p?.description ?? "",
  model: p?.model ?? "",
  reasoningEffort: p?.reasoningEffort ?? "",
  agent: p?.agent ?? "",
  mode: p?.mode ?? "autopilot",
  instructions: p?.instructions ?? "",
  budget: p?.budgetCredits !== undefined ? String(p.budgetCredits) : "",
});

function ProfileForm({ initial, groups, onDone }: { initial?: Profile; groups: Array<{ key: string; models: ModelOption[] }>; onDone: () => void }) {
  const models = useAria((s) => s.models);
  const agents = useAria(selectAgents);
  const saveProfile = useAria((s) => s.saveProfile);
  const actionError = useAria((s) => s.actionError);
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(initial));
  const [busy, setBusy] = useState(false);
  const selected = models.find((m) => m.id === draft.model);
  const invocableAgents = agents.filter((a) => a.userInvocable !== false);
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    if (!selected) return;
    if (selected.efforts.length === 0) set({ reasoningEffort: "" });
    else if (!selected.efforts.includes(draft.reasoningEffort)) set({ reasoningEffort: selected.efforts.find((e) => e !== "none") ?? selected.efforts[0]! });
  }, [selected, draft.reasoningEffort]);
  const budget = draft.budget.trim() ? Number(draft.budget) : null;
  const budgetOk = budget === null || (Number.isFinite(budget) && budget > 0 && budget <= 10_000);
  const valid = draft.name.trim() && selected && budgetOk;
  const field = "w-full rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent";
  return (
    <form
      className="space-y-2 rounded-md border border-accent/40 bg-canvas/40 p-3"
      data-testid="profile-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        const saved = await saveProfile({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          model: draft.model,
          ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
          agent: draft.agent.trim() ? draft.agent.trim() : null,
          mode: draft.mode,
          ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
          budgetCredits: budget,
        });
        setBusy(false);
        if (saved) onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Name</span>
          <input data-testid="profile-name" className={field} value={draft.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Use it for</span>
          <input className={field} value={draft.description} maxLength={300} onChange={(e) => set({ description: e.target.value })} placeholder="Small fixes, docs…" />
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Model</span>
          <select data-testid="profile-model" className={field} value={draft.model} onChange={(e) => set({ model: e.target.value })}>
            {!selected && <option value="">Choose a model</option>}
            {groups.map((g) => (
              <optgroup key={g.key} label={CATEGORY_LABELS[g.key]}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.enabled}>
                    {m.name} · {priceWord(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Reasoning effort</span>
          <select data-testid="profile-effort" className={field} value={draft.reasoningEffort} disabled={!selected || selected.efforts.length === 0} onChange={(e) => set({ reasoningEffort: e.target.value })}>
            {selected && selected.efforts.length === 0 && <option value="">Not configurable</option>}
            {selected?.efforts.map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Mode</span>
          <select className={field} value={draft.mode} onChange={(e) => set({ mode: e.target.value as TaskMode })}>
            <option value="autopilot">Autopilot: works until it's done</option>
            <option value="interactive">Interactive: stops after each reply</option>
            <option value="plan">Plan first: you approve its plan before it starts</option>
          </select>
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-muted">Pause a task at (AI credits)</span>
          <input data-testid="profile-budget" className={field} inputMode="decimal" value={draft.budget} onChange={(e) => set({ budget: e.target.value })} placeholder="No limit" aria-invalid={!budgetOk} />
          {!budgetOk && (
            <span className="block text-xs text-bad" data-testid="profile-budget-error">
              A number of credits above 0 and up to 10,000, or empty for no limit.
            </span>
          )}
        </label>
      </div>
      <label className="block space-y-0.5">
        <span className="text-xs text-muted">Default agent (optional)</span>
        <select data-testid="profile-agent" className={field} value={draft.agent} onChange={(e) => set({ agent: e.target.value })}>
          <AgentSelectOptions agents={invocableAgents} currentAgent={draft.agent} />
        </select>
      </label>
      {selected && (
        <div className="text-xs text-muted">
          {priceWord(selected)} · {selected.inputPrice ?? "?"} / {selected.outputPrice ?? "?"} AI credits per 1M input / output tokens
        </div>
      )}
      <label className="block space-y-0.5">
        <span className="text-xs text-muted">Extra instructions for the worker (optional)</span>
        <textarea className={`${field} resize-y`} rows={2} value={draft.instructions} maxLength={4000} onChange={(e) => set({ instructions: e.target.value })} />
      </label>
      {actionError && <div className="text-xs text-bad">{actionError}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-md px-3 py-1 text-sm text-muted hover:text-fg">
          Cancel
        </button>
        <button data-testid="profile-save" type="submit" disabled={busy || !valid} className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

/** D47: the profile Fix it's new tasks use (a task that continues keeps its own). */
function FixItUses() {
  const profiles = useAria((s) => s.profiles);
  const ciFixProfileId = useAria((s) => s.ciFixProfileId);
  const setCiFix = useAria((s) => s.setCiFixProfile);
  const [error, setError] = useState<string | null>(null);
  const fallback = profiles.find((p) => p.isDefault)?.name ?? "Default";
  return (
    <label className="block text-sm" data-testid="fix-it-uses">
      <span className="text-xs text-muted">Fix it uses</span>
      <select
        data-testid="fix-it-uses-select"
        value={ciFixProfileId ?? ""}
        onChange={async (e) => setError(await setCiFix(e.target.value || null))}
        className="mt-0.5 block rounded-md border border-line bg-canvas px-2 py-1 text-sm"
      >
        <option value="">The default profile ({fallback})</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="mt-0.5 block text-xs text-muted">For Fix it's new tasks: when a task takes over another's branch, or starts from a red default branch. A task Fix it continues keeps its own profile and model.</span>
      {error && <span className="block text-xs text-bad">{error}</span>}
    </label>
  );
}

/** Worker profiles and who picks them (PLAN.md §4.12). */
function WorkerProfiles({ groups }: { groups: Array<{ key: string; models: ModelOption[] }> }) {
  const profiles = useAria((s) => s.profiles);
  const policy = useAria((s) => s.profilePolicy);
  const editingProfileId = useAria((s) => s.ui.editingProfileId);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const setPolicy = useAria((s) => s.setProfilePolicy);
  const setDefault = useAria((s) => s.setDefaultProfile);
  const deleteProfile = useAria((s) => s.deleteProfile);
  const [editing, setEditing] = useState<string | "new" | null>(editingProfileId ?? null);

  useEffect(() => {
    if (editingProfileId) {
      setEditing(editingProfileId);
    }
  }, [editingProfileId]);

  const finishEditing = () => {
    setEditing(null);
    if (editingProfileId) setCustomizePage("models", null);
  };
  const policies: Array<{ value: ProfilePolicy; label: string; hint: string }> = [
    { value: "me", label: "Me", hint: "ARIA uses the default profile unless you name one (\"use Deep for this\")." },
    { value: "aria", label: "ARIA, within my profiles", hint: "ARIA picks one of your profiles and says which one and why. Never a model outside them." },
    { value: "ask", label: "Ask me", hint: "ARIA proposes the task and a profile on a card, and the task starts when you press Start there." },
  ];
  return (
    <section className="space-y-4 rounded-lg border border-line bg-panel p-4" data-testid="worker-profiles">
      <div>
        <div className="font-medium">Background tasks (worker profiles)</div>
        <div className="text-xs text-muted">Each task runs with one of these: a model, an effort, a mode and a budget you chose.</div>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs text-muted">Who picks the profile for a task ARIA starts?</legend>
        {policies.map((p) => (
          <label key={p.value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="profile-policy" data-testid={`policy-${p.value}`} className="mt-1" checked={policy === p.value} onChange={() => void setPolicy(p.value)} />
            <span>
              {p.label}
              <span className="block text-xs text-muted">{p.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <FixItUses />

      <div className="space-y-2">
        {profiles.map((p) =>
          editing === p.id ? (
            <ProfileForm key={p.id} initial={p} groups={groups} onDone={finishEditing} />
          ) : (
            <div key={p.id} className="flex items-start gap-2 rounded-md border border-line px-3 py-2" data-testid="profile" data-profile={p.name}>
              <button
                title={p.isDefault ? "The default profile" : "Make this the default"}
                data-testid="profile-default"
                onClick={() => !p.isDefault && void setDefault(p.id)}
                className={`mt-0.5 ${p.isDefault ? "text-warn" : "text-muted hover:text-warn"}`}
              >
                <Star className={`h-4 w-4 ${p.isDefault ? "fill-current" : ""}`} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {p.name}
                  {p.isDefault && <span className="ml-2 text-xs font-normal text-muted">default</span>}
                </div>
                <div className="text-xs text-muted">
                  {p.model}
                  {p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""} · {p.mode}
                  {p.agent ? ` · agent: ${p.agent}` : ""} · {p.budgetCredits ? `pauses at ${p.budgetCredits} credits` : "no budget"}
                </div>
                {p.description && <div className="text-xs text-muted/80">{p.description}</div>}
              </div>
              <button data-testid="profile-edit" onClick={() => setEditing(p.id)} className="rounded p-1 text-muted hover:text-fg" title="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              {profiles.length > 1 && (
                <button data-testid="profile-delete" onClick={() => void deleteProfile(p.id)} className="rounded p-1 text-muted hover:text-bad" title="Delete">
                  <Trash className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ),
        )}
        {editing === "new" ? (
          <ProfileForm groups={groups} onDone={finishEditing} />
        ) : (
          <button data-testid="profile-add" onClick={() => setEditing("new")} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            <Plus className="h-3.5 w-3.5" /> Add profile
          </button>
        )}
      </div>
    </section>
  );
}
