import type { OutlookMailTriageMode, PhonePushProvider, PhonePushScope, SpokenAnnouncementsScope, SttProvider, TtsProvider, UpdateCheckResult } from "@aria/protocol";
import { useEffect, useState } from "react";
import { accessText, canRetry, inboxLine } from "../github";
import { useAria } from "../store";
import { listSystemVoices, speakAnnouncement } from "../voice";

/** GitHub access (who ARIA reads it as: GitHub CLI's token, PLAN.md §4.6) and the inbox switch (D37). */
function GitHubSection() {
  const github = useAria((s) => s.github);
  const inbox = useAria((s) => s.watches.find((w) => w.kind === "inbox" && w.state === "active"));
  const retry = useAria((s) => s.retryGitHub);
  const setInbox = useAria((s) => s.setInboxWatch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setError(await call());
    setBusy(false);
  };
  const retryInbox = useAria((s) => s.retryInbox);
  const problem = canRetry(github.status);
  const inboxNow = inboxLine(inbox, github.status === "ok");
  return (
    <section className="space-y-1.5" data-testid="github-section">
      <div className="font-medium">GitHub</div>
      <p className={`text-xs ${problem ? "text-warn" : "text-muted"}`} data-testid="github-access" data-status={github.status}>
        {accessText(github)}
      </p>
      {github.ignored?.length ? (
        <p className="text-xs text-muted" data-testid="github-ignored">
          {github.ignored.join(" and ")} {github.ignored.length === 1 ? "is" : "are"} set in ARIA's environment but not used: ARIA reads GitHub with GitHub CLI's own sign-in (`gh auth login`), so a token meant for something
          else (a Copilot app shell sets one) can't stand in for yours.
        </p>
      ) : null}
      {problem && (
        <button data-testid="github-retry" disabled={busy} onClick={() => void run(retry)} className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40">
          Try again
        </button>
      )}
      {github.status !== "off" && (
        <>
          <label className="flex items-center gap-2 pt-1 font-medium">
            <input type="checkbox" data-testid="github-inbox" checked={github.inbox} disabled={busy} onChange={(e) => void run(() => setInbox(e.target.checked))} />
            Watch my GitHub notifications
          </label>
          <p className="text-xs text-muted">
            A review request shows up as a card in the chat (and pops up while you're away); the rest doesn't interrupt you. Titles from your inbox (anyone can write them) are shown to you and never sent to ARIA.
          </p>
          {inboxNow && (
            <p className={`text-xs ${inboxNow.problem ? "text-warn" : "text-muted"}`} data-testid="github-inbox-status" data-problem={inboxNow.problem}>
              {inboxNow.text}
            </p>
          )}
          {/* The inbox's own Try again: only for its own wait (GitHub access is fine), and it asks only the inbox again. */}
          {inboxNow?.problem && (
            <button
              data-testid="github-inbox-retry"
              disabled={busy}
              onClick={() => void run(retryInbox)}
              className="rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40"
            >
              Try again
            </button>
          )}
        </>
      )}
      {error && <div className="text-xs text-bad">{error}</div>}
    </section>
  );
}

/**
 * Voice section in Customize › Notifications (Phase 6D, PLAN.md §4.7, §5.5, §10 Phase 6D):
 * Spoken announcements (`speechSynthesis` or cloud TTS) and Push-to-talk transcription (`whisper.cpp` or cloud STT).
 */
function VoiceSection({ onSaved }: { onSaved: (msg: string) => void }) {
  const attention = useAria((s) => s.attention);
  const setAttention = useAria((s) => s.setAttention);
  const setVoiceCloudApiKey = useAria((s) => s.setVoiceCloudApiKey);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listSystemVoices());
  const [ttsVoice, setTtsVoice] = useState(attention.ttsVoice ?? "");
  const [ttsRate, setTtsRate] = useState(String(attention.ttsRate ?? 1));
  const [whisperBin, setWhisperBin] = useState(attention.whisperExecutablePath ?? "");
  const [whisperModel, setWhisperModel] = useState(attention.whisperModelPath ?? "");
  const [cloudEndpoint, setCloudEndpoint] = useState(attention.voiceCloudEndpoint ?? "");
  const [sttModel, setSttModel] = useState(attention.sttCloudModel ?? "");
  const [ttsModel, setTtsModel] = useState(attention.ttsCloudModel ?? "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTtsVoice(attention.ttsVoice ?? "");
    setTtsRate(String(attention.ttsRate ?? 1));
    setWhisperBin(attention.whisperExecutablePath ?? "");
    setWhisperModel(attention.whisperModelPath ?? "");
    setCloudEndpoint(attention.voiceCloudEndpoint ?? "");
    setSttModel(attention.sttCloudModel ?? "");
    setTtsModel(attention.ttsCloudModel ?? "");
  }, [
    attention.ttsVoice,
    attention.ttsRate,
    attention.whisperExecutablePath,
    attention.whisperModelPath,
    attention.voiceCloudEndpoint,
    attention.sttCloudModel,
    attention.ttsCloudModel,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const refresh = () => setVoices(listSystemVoices());
    window.speechSynthesis.addEventListener?.("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", refresh);
  }, []);

  const spoken = attention.spokenAnnouncements ?? "off";
  const ttsProvider = attention.ttsProvider ?? "system";
  const sttProvider = attention.sttProvider ?? "whisper.cpp";
  const rateNum = Number(ttsRate);
  const rateValid = Number.isFinite(rateNum) && rateNum >= 0.5 && rateNum <= 2.0;

  return (
    <section className="space-y-3" data-testid="voice-section">
      <div className="font-medium">Voice & Push-to-talk</div>
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-fg">
          Spoken announcements
          <select
            data-testid="voice-spoken"
            value={spoken}
            onChange={(e) => {
              const next = e.target.value as SpokenAnnouncementsScope;
              void setAttention({ spokenAnnouncements: next }).then((ok) => {
                if (ok) {
                  onSaved(
                    next === "off"
                      ? "Spoken announcements are off."
                      : next === "blocking"
                        ? "ARIA will speak when something needs you."
                        : "ARIA will speak milestones and blocking items.",
                  );
                }
              });
            }}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="off">Off</option>
            <option value="blocking">Only when something needs me (questions, approvals, failures, reminders)</option>
            <option value="all">Milestones and blocking items (task done, CI/PR updates, and items needing me)</option>
          </select>
        </label>
        <p className="text-xs text-muted">
          Short spoken announcements ("Dark mode is done, 2 files changed"). Respects Focus mode for milestones and stays quiet while the PC is locked.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-fg">
          Speech output (TTS)
          <select
            data-testid="voice-tts-provider"
            value={ttsProvider}
            onChange={(e) => {
              const next = e.target.value as TtsProvider;
              void setAttention({ ttsProvider: next }).then((ok) => {
                if (ok) onSaved(next === "system" ? "Using Windows system voice." : "Using cloud TTS.");
              });
            }}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="system">System voice (Windows speechSynthesis · free)</option>
            <option value="cloud">Cloud TTS (OpenAI-compatible)</option>
          </select>
        </label>

        <label className="block text-xs font-medium text-fg">
          Push-to-talk transcription (STT)
          <select
            data-testid="voice-stt-provider"
            value={sttProvider}
            onChange={(e) => {
              const next = e.target.value as SttProvider;
              void setAttention({ sttProvider: next }).then((ok) => {
                if (ok) onSaved(next === "whisper.cpp" ? "Using local whisper.cpp for push-to-talk." : "Using cloud speech-to-text for push-to-talk.");
              });
            }}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="whisper.cpp">Local whisper.cpp</option>
            <option value="cloud">Cloud speech-to-text (OpenAI-compatible)</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="min-w-[180px] flex-1 font-medium text-fg">
          Voice name {ttsProvider === "system" && voices.length > 0 ? `(e.g. ${voices[0]!.name})` : "(optional)"}
          <input
            type="text"
            data-testid="voice-tts-voice"
            value={ttsVoice}
            placeholder={ttsProvider === "cloud" ? "alloy" : "Default system voice"}
            onChange={(e) => setTtsVoice(e.target.value)}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>
        <label className="w-24 font-medium text-fg">
          Speed (0.5–2)
          <input
            type="number"
            step="0.1"
            min="0.5"
            max="2.0"
            data-testid="voice-tts-rate"
            value={ttsRate}
            onChange={(e) => setTtsRate(e.target.value)}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          data-testid="voice-tts-save"
          disabled={!rateValid}
          onClick={() => {
            void setAttention({ ttsVoice: ttsVoice.trim(), ttsRate: rateNum }).then((ok) => {
              if (ok) onSaved("Saved voice output preferences.");
            });
          }}
          className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
        >
          Save voice
        </button>
        <button
          type="button"
          data-testid="voice-test-tts"
          onClick={() => {
            void speakAnnouncement(
              { id: `test-${Date.now()}`, text: "ARIA voice check: Dark mode toggle is done, tests pass.", priority: "test" },
              { ...attention, ttsVoice: ttsVoice.trim(), ttsRate: rateValid ? rateNum : 1 },
            );
          }}
          className="rounded border border-line px-2.5 py-1 text-muted hover:border-accent hover:text-fg"
        >
          Test voice
        </button>
      </div>

      {sttProvider === "whisper.cpp" && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs" data-testid="voice-whisper-config">
          <div className="font-medium text-fg">Local whisper.cpp paths</div>
          <label className="block text-muted">
            Executable path (<code className="font-mono">whisper-cli.exe</code> or <code className="font-mono">main.exe</code>)
            <input
              type="text"
              data-testid="voice-whisper-bin"
              value={whisperBin}
              placeholder="C:\tools\whisper\whisper-cli.exe"
              onChange={(e) => setWhisperBin(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="block text-muted">
            GGML model path (<code className="font-mono">ggml-base.en.bin</code>)
            <input
              type="text"
              data-testid="voice-whisper-model"
              value={whisperModel}
              placeholder="C:\tools\whisper\models\ggml-base.en.bin"
              onChange={(e) => setWhisperModel(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted">
              Hold or click the mic button in the chat or quick prompt bar (or press <kbd className="font-mono">Ctrl+Shift+Space</kbd>) to dictate.
            </span>
            <button
              type="button"
              data-testid="voice-whisper-save"
              onClick={() => {
                void setAttention({
                  whisperExecutablePath: whisperBin.trim(),
                  whisperModelPath: whisperModel.trim(),
                }).then((ok) => {
                  if (ok) onSaved("Saved whisper.cpp paths.");
                });
              }}
              className="rounded bg-accent px-2.5 py-1 text-white hover:bg-accent/90"
            >
              Save paths
            </button>
          </div>
        </div>
      )}

      {(sttProvider === "cloud" || ttsProvider === "cloud") && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs" data-testid="voice-cloud-config">
          <div className="font-medium text-fg">Cloud voice endpoint & credentials</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="block text-muted sm:col-span-1">
              Endpoint base URL
              <input
                type="text"
                data-testid="voice-cloud-endpoint"
                value={cloudEndpoint}
                placeholder="https://api.openai.com/v1"
                onChange={(e) => setCloudEndpoint(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="block text-muted">
              STT model
              <input
                type="text"
                data-testid="voice-stt-model"
                value={sttModel}
                placeholder="whisper-1"
                onChange={(e) => setSttModel(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="block text-muted">
              TTS model
              <input
                type="text"
                data-testid="voice-tts-model"
                value={ttsModel}
                placeholder="tts-1"
                onChange={(e) => setTtsModel(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="voice-cloud-save"
              onClick={() => {
                void setAttention({
                  voiceCloudEndpoint: cloudEndpoint.trim(),
                  sttCloudModel: sttModel.trim(),
                  ttsCloudModel: ttsModel.trim(),
                }).then((ok) => {
                  if (ok) onSaved("Saved cloud voice endpoint settings.");
                });
              }}
              className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent"
            >
              Save endpoint
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <label className="min-w-[200px] flex-1 text-muted">
              API key ({attention.hasVoiceCloudApiKey ? "saved in OS keychain" : "not set"})
              <input
                type="password"
                data-testid="voice-cloud-key"
                value={apiKeyInput}
                placeholder={attention.hasVoiceCloudApiKey ? "••••••••••••••••" : "Enter API key…"}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              data-testid="voice-cloud-key-save"
              disabled={busy || !apiKeyInput.trim()}
              onClick={async () => {
                setBusy(true);
                const ok = await setVoiceCloudApiKey(apiKeyInput.trim());
                setBusy(false);
                if (ok) {
                  setApiKeyInput("");
                  onSaved("Saved cloud voice API key in OS keychain.");
                }
              }}
              className="rounded bg-accent px-2.5 py-1 text-white disabled:opacity-40"
            >
              Save key
            </button>
            {attention.hasVoiceCloudApiKey && (
              <button
                type="button"
                data-testid="voice-cloud-key-clear"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await setVoiceCloudApiKey(null);
                  setBusy(false);
                  if (ok) onSaved("Cleared cloud voice API key.");
                }}
                className="rounded border border-line px-2.5 py-1 text-muted hover:border-bad hover:text-bad disabled:opacity-40"
              >
                Clear key
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Phone push notifications section in Customize › Notifications (Phase 8B, PLAN.md §4.7, §10 Phase 8B, D73).
 */
function PhonePushSection({ onSaved }: { onSaved: (msg: string) => void }) {
  const attention = useAria((s) => s.attention);
  const setAttention = useAria((s) => s.setAttention);
  const setPhonePushSecrets = useAria((s) => s.setPhonePushSecrets);
  const testPhonePush = useAria((s) => s.testPhonePush);

  const provider = attention.phonePushProvider ?? "off";
  const scope = attention.phonePushScope ?? "blocking";
  const [ntfyUrl, setNtfyUrl] = useState(attention.ntfyServerUrl ?? "https://ntfy.sh");
  const [ntfyTopic, setNtfyTopic] = useState(attention.ntfyTopic ?? "");
  const [ntfyToken, setNtfyToken] = useState("");
  const [pushoverAppToken, setPushoverAppToken] = useState("");
  const [pushoverUserKey, setPushoverUserKey] = useState("");
  const [pushoverDevice, setPushoverDevice] = useState(attention.pushoverDevice ?? "");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setNtfyUrl(attention.ntfyServerUrl ?? "https://ntfy.sh");
    setNtfyTopic(attention.ntfyTopic ?? "");
    setPushoverDevice(attention.pushoverDevice ?? "");
  }, [attention.ntfyServerUrl, attention.ntfyTopic, attention.pushoverDevice]);

  return (
    <section className="space-y-3" data-testid="phone-push-section">
      <div className="font-medium">Phone push notifications</div>
      <p className="text-xs text-muted">
        Pushes sanitized plain-text notifications to your phone when you're away from your desk (including while your PC screen is locked). Milestones coalesce on a 30-second window.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-fg">
          Provider
          <select
            data-testid="phone-push-provider"
            value={provider}
            onChange={(e) => {
              const next = e.target.value as PhonePushProvider;
              setTestResult(null);
              void setAttention({ phonePushProvider: next }).then((ok) => {
                if (ok) {
                  onSaved(
                    next === "off"
                      ? "Phone push notifications are off."
                      : next === "ntfy"
                        ? "Phone push provider set to ntfy."
                        : "Phone push provider set to Pushover.",
                  );
                }
              });
            }}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="off">Off</option>
            <option value="ntfy">ntfy (ntfy.sh or self-hosted)</option>
            <option value="pushover">Pushover</option>
          </select>
        </label>

        <label className="block text-xs font-medium text-fg">
          What to push while away
          <select
            data-testid="phone-push-scope"
            value={scope}
            onChange={(e) => {
              const next = e.target.value as PhonePushScope;
              void setAttention({ phonePushScope: next }).then((ok) => {
                if (ok) {
                  onSaved(
                    next === "blocking"
                      ? "Phone pushes only when something needs you."
                      : "Phone pushes milestones and blocking items.",
                  );
                }
              });
            }}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="blocking">Only when something needs me (blocking)</option>
            <option value="all">Milestones and blocking items (respects Focus mode)</option>
          </select>
        </label>
      </div>

      {provider === "ntfy" && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs">
          <div className="font-medium text-fg">ntfy settings</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-muted">
              Server URL
              <input
                type="text"
                data-testid="phone-ntfy-url"
                value={ntfyUrl}
                placeholder="https://ntfy.sh"
                onChange={(e) => setNtfyUrl(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="block text-muted">
              Topic name
              <input
                type="text"
                data-testid="phone-ntfy-topic"
                value={ntfyTopic}
                placeholder="aria-alerts"
                onChange={(e) => setNtfyTopic(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="phone-ntfy-save"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await setAttention({
                  ntfyServerUrl: ntfyUrl.trim(),
                  ntfyTopic: ntfyTopic.trim(),
                });
                setBusy(false);
                if (ok) onSaved("Saved ntfy server and topic.");
              }}
              className="rounded bg-accent px-2.5 py-1 text-white disabled:opacity-40"
            >
              Save ntfy settings
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <label className="min-w-[200px] flex-1 text-muted">
              Access token (optional · {attention.hasNtfyToken ? "saved in OS keychain" : "not set"})
              <input
                type="password"
                data-testid="phone-ntfy-token"
                value={ntfyToken}
                placeholder={attention.hasNtfyToken ? "••••••••••••••••" : "tk_… (optional)"}
                onChange={(e) => setNtfyToken(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              data-testid="phone-ntfy-token-save"
              disabled={busy || !ntfyToken.trim()}
              onClick={async () => {
                setBusy(true);
                const ok = await setPhonePushSecrets({ ntfyToken: ntfyToken.trim() });
                setBusy(false);
                if (ok) {
                  setNtfyToken("");
                  onSaved("Saved ntfy access token in OS keychain.");
                }
              }}
              className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
            >
              Save token
            </button>
            {attention.hasNtfyToken && (
              <button
                type="button"
                data-testid="phone-ntfy-token-clear"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await setPhonePushSecrets({ ntfyToken: null });
                  setBusy(false);
                  if (ok) onSaved("Cleared ntfy access token.");
                }}
                className="rounded border border-line px-2.5 py-1 text-muted hover:border-bad hover:text-bad disabled:opacity-40"
              >
                Clear token
              </button>
            )}
          </div>
        </div>
      )}

      {provider === "pushover" && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs">
          <div className="font-medium text-fg">
            Pushover credentials ({attention.hasPushoverCredentials ? "saved in OS keychain" : "not set"})
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="block text-muted">
              Application API token
              <input
                type="password"
                data-testid="phone-pushover-token"
                value={pushoverAppToken}
                placeholder={attention.hasPushoverCredentials ? "••••••••••••" : "App token…"}
                onChange={(e) => setPushoverAppToken(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="block text-muted">
              User key
              <input
                type="password"
                data-testid="phone-pushover-user"
                value={pushoverUserKey}
                placeholder={attention.hasPushoverCredentials ? "••••••••••••" : "User key…"}
                onChange={(e) => setPushoverUserKey(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="block text-muted">
              Device name (optional)
              <input
                type="text"
                data-testid="phone-pushover-device"
                value={pushoverDevice}
                placeholder="All devices"
                onChange={(e) => setPushoverDevice(e.target.value)}
                className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="phone-pushover-save"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await setAttention({ pushoverDevice: pushoverDevice.trim() });
                if (pushoverAppToken.trim() || pushoverUserKey.trim()) {
                  await setPhonePushSecrets({
                    ...(pushoverAppToken.trim() ? { pushoverAppToken: pushoverAppToken.trim() } : {}),
                    ...(pushoverUserKey.trim() ? { pushoverUserKey: pushoverUserKey.trim() } : {}),
                  });
                  setPushoverAppToken("");
                  setPushoverUserKey("");
                }
                setBusy(false);
                onSaved("Saved Pushover settings.");
              }}
              className="rounded bg-accent px-2.5 py-1 text-white disabled:opacity-40"
            >
              Save Pushover settings
            </button>
            {attention.hasPushoverCredentials && (
              <button
                type="button"
                data-testid="phone-pushover-clear"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await setPhonePushSecrets({ pushoverAppToken: null, pushoverUserKey: null });
                  setBusy(false);
                  if (ok) onSaved("Cleared Pushover credentials.");
                }}
                className="rounded border border-line px-2.5 py-1 text-muted hover:border-bad hover:text-bad disabled:opacity-40"
              >
                Clear credentials
              </button>
            )}
          </div>
        </div>
      )}

      {provider !== "off" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            data-testid="phone-push-test"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setTestResult(null);
              const res = await testPhonePush();
              setBusy(false);
              setTestResult({
                ok: res.ok,
                text: res.ok ? "Test notification sent to your phone." : (res.error ?? "Phone notification test failed."),
              });
            }}
            className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
          >
            Test phone notification
          </button>
          {testResult && (
            <span
              data-testid="phone-push-test-result"
              className={testResult.ok ? "text-ok" : "text-bad"}
            >
              {testResult.text}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Two-way Telegram relay section in Customize › Notifications (Phase 8B, PLAN.md §4.7, §10 Phase 8B, D74).
 */
function TelegramSection({ onSaved }: { onSaved: (msg: string) => void }) {
  const attention = useAria((s) => s.attention);
  const telegram = useAria((s) => s.telegram);
  const setAttention = useAria((s) => s.setAttention);
  const setTelegramBotToken = useAria((s) => s.setTelegramBotToken);
  const testTelegramRelay = useAria((s) => s.testTelegramRelay);

  const enabled = attention.telegramEnabled === true;
  const outboundScope = attention.telegramOutboundScope ?? "all";
  const [chatId, setChatId] = useState(attention.telegramChatId ?? "");
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setChatId(attention.telegramChatId ?? "");
  }, [attention.telegramChatId]);

  const statusText =
    telegram.state === "polling"
      ? `Polling${telegram.botUsername ? ` (@${telegram.botUsername})` : ""}`
      : telegram.state === "starting"
        ? "Starting…"
        : telegram.state === "error"
          ? `Error: ${telegram.error ?? "connection failed"}`
          : "Off";

  return (
    <section className="space-y-3" data-testid="telegram-section">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Telegram two-way relay</div>
        <span
          data-testid="telegram-status"
          data-state={telegram.state}
          className={`rounded px-2 py-0.5 text-xs ${
            telegram.state === "polling"
              ? "bg-ok/15 text-ok"
              : telegram.state === "error"
                ? "bg-bad/15 text-bad"
                : "bg-raised text-muted"
          }`}
        >
          {statusText}
        </span>
      </div>

      <label className="flex items-center gap-2 font-medium text-xs">
        <input
          type="checkbox"
          data-testid="telegram-enabled"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            void setAttention({ telegramEnabled: next }).then((ok) => {
              if (ok) {
                onSaved(next ? "Telegram two-way relay is enabled." : "Telegram two-way relay is off.");
              }
            });
          }}
        />
        Enable two-way Telegram relay
      </label>
      <p className="text-xs text-muted">
        Chat with ARIA, answer task questions (<code className="font-mono">Q-1</code>), approve permissions (<code className="font-mono">approve P-1</code>), or message a task (<code className="font-mono">@slug</code>) from a private 1:1 Telegram bot chat. Only messages from your numeric Chat / User ID are accepted.
      </p>

      <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block text-muted">
            Authorized numeric Chat / User ID
            <input
              type="text"
              data-testid="telegram-chat-id"
              value={chatId}
              placeholder="123456789"
              onChange={(e) => setChatId(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="block text-muted">
            Outbound notifications scope
            <select
              data-testid="telegram-outbound-scope"
              value={outboundScope}
              onChange={(e) => {
                const next = e.target.value as PhonePushScope;
                void setAttention({ telegramOutboundScope: next }).then((ok) => {
                  if (ok) onSaved("Updated Telegram outbound scope.");
                });
              }}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
            >
              <option value="all">Milestones and blocking items</option>
              <option value="blocking">Only blocking items (questions, approvals, failures)</option>
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="telegram-save"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await setAttention({ telegramChatId: chatId.trim() });
              setBusy(false);
              if (ok) onSaved("Saved Telegram Chat ID.");
            }}
            className="rounded bg-accent px-2.5 py-1 text-white disabled:opacity-40"
          >
            Save Telegram settings
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2 pt-1">
          <label className="min-w-[200px] flex-1 text-muted">
            Bot token ({attention.hasTelegramBotToken ? "saved in OS keychain" : "not set"})
            <input
              type="password"
              data-testid="telegram-bot-token"
              value={botToken}
              placeholder={attention.hasTelegramBotToken ? "••••••••••••••••" : "123456:ABC-DEF…"}
              onChange={(e) => setBotToken(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-fg outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            data-testid="telegram-token-save"
            disabled={busy || !botToken.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await setTelegramBotToken(botToken.trim());
              setBusy(false);
              if (ok) {
                setBotToken("");
                onSaved("Saved Telegram bot token in OS keychain.");
              }
            }}
            className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
          >
            Save token
          </button>
          {attention.hasTelegramBotToken && (
            <button
              type="button"
              data-testid="telegram-token-clear"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await setTelegramBotToken(null);
                setBusy(false);
                if (ok) onSaved("Cleared Telegram bot token.");
              }}
              className="rounded border border-line px-2.5 py-1 text-muted hover:border-bad hover:text-bad disabled:opacity-40"
            >
              Clear token
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="telegram-test"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setTestResult(null);
              const res = await testTelegramRelay();
              setBusy(false);
              setTestResult({
                ok: res.ok,
                text: res.ok
                  ? `Connected${res.botUsername ? ` as @${res.botUsername}` : ""} and sent test message.`
                  : (res.error ?? "Telegram relay test failed."),
              });
            }}
            className="rounded border border-line px-2.5 py-1 text-fg hover:border-accent disabled:opacity-40"
          >
            Test Telegram relay
          </button>
          {testResult && (
            <span
              data-testid="telegram-test-result"
              className={testResult.ok ? "text-ok" : "text-bad"}
            >
              {testResult.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Proactive Outlook email alerts section in Customize › Notifications.
 */
function OutlookSection({ onSaved }: { onSaved: (msg: string) => void }) {
  const attention = useAria((s) => s.attention);
  const setAttention = useAria((s) => s.setAttention);

  const enabled = attention.outlookWatchEnabled !== false;
  const triageMode = attention.outlookTriageMode ?? "rules_and_utility";
  const [pollMinutes, setPollMinutes] = useState(String(attention.outlookPollMinutes ?? 5));
  const [vipInput, setVipInput] = useState((attention.outlookVipSenders ?? []).join(", "));
  const [ignoreInput, setIgnoreInput] = useState((attention.outlookIgnoreSenders ?? []).join(", "));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPollMinutes(String(attention.outlookPollMinutes ?? 5));
    setVipInput((attention.outlookVipSenders ?? []).join(", "));
    setIgnoreInput((attention.outlookIgnoreSenders ?? []).join(", "));
  }, [attention.outlookPollMinutes, attention.outlookVipSenders, attention.outlookIgnoreSenders]);

  const pollVal = Number(pollMinutes);
  const pollValid = Number.isInteger(pollVal) && pollVal >= 1 && pollVal <= 60;

  return (
    <section className="space-y-3" data-testid="outlook-section">
      <div className="font-medium">Outlook email alerts</div>
      <label className="flex items-center gap-2 font-medium text-xs">
        <input
          type="checkbox"
          data-testid="outlook-watch-enabled"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            void setAttention({ outlookWatchEnabled: next }).then((ok) => {
              if (ok) {
                onSaved(next ? "Outlook email watcher is on." : "Outlook email watcher is off.");
              }
            });
          }}
        />
        Watch unread Outlook emails and ping me when something needs my attention
      </label>
      <p className="text-xs text-muted">
        Polls <code className="font-mono">Work IQ Mail</code> for unread emails, filters out automated noise, and uses plain-code rules + your optional Utility model to surface emails that need a reply or action from you.
      </p>

      <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-xs">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block text-muted">
            Triage mode
            <select
              data-testid="outlook-triage-mode"
              value={triageMode}
              onChange={(e) => {
                const next = e.target.value as OutlookMailTriageMode;
                void setAttention({ outlookTriageMode: next }).then((ok) => {
                  if (ok) {
                    onSaved(
                      next === "rules_and_utility"
                        ? "Using plain-code filter + Utility model triage."
                        : "Using plain-code rules only (zero AI credits).",
                    );
                  }
                });
              }}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
            >
              <option value="rules_and_utility">Two-stage: plain-code pre-filter + Utility model triage</option>
              <option value="rules_only">Plain-code rules only (zero AI credits)</option>
            </select>
          </label>
          <label className="block text-muted">
            Check interval (1–60 minutes)
            <input
              type="number"
              min={1}
              max={60}
              data-testid="outlook-poll-minutes"
              value={pollMinutes}
              onChange={(e) => setPollMinutes(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
            />
          </label>
        </div>

        <label className="block text-muted">
          VIP senders (comma-separated emails or names — always ping as Urgent)
          <input
            type="text"
            data-testid="outlook-vip-senders"
            value={vipInput}
            placeholder="alice@example.com, Thomas"
            onChange={(e) => setVipInput(e.target.value)}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>

        <label className="block text-muted">
          Ignored senders or subjects (comma-separated)
          <input
            type="text"
            data-testid="outlook-ignore-senders"
            value={ignoreInput}
            placeholder="newsletter@, Daily Digest"
            onChange={(e) => setIgnoreInput(e.target.value)}
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent"
          />
        </label>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            data-testid="outlook-save"
            disabled={busy || !pollValid}
            onClick={async () => {
              setBusy(true);
              const vips = vipInput
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 50);
              const ignores = ignoreInput
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 50);
              const ok = await setAttention({
                outlookPollMinutes: pollVal,
                outlookVipSenders: vips,
                outlookIgnoreSenders: ignores,
              });
              setBusy(false);
              if (ok) onSaved("Saved Outlook email watcher settings.");
            }}
            className="rounded bg-accent px-2.5 py-1 text-white disabled:opacity-40"
          >
            Save Outlook settings
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Customize › Notifications (PLAN.md §4.5, §5.5, D25): Focus mode, and when the "while you were away" card shows.
 * Toasts only ever come while you're away from ARIA.
 */
/** What Check now found, in a line. */
function checkResultText(result: UpdateCheckResult): string {
  if (result.status === "available") return `ARIA v${result.update.version} is available: the bar at the top of the window has it.`;
  if (result.status === "latest") return "You have the latest version.";
  return `Couldn't check. ${result.reason}`;
}

/** Updates (D80): whether ARIA checks for a newer release by itself, and Check now. */
function UpdatesSection({ onSaved }: { onSaved: (msg: string) => void }) {
  const auto = useAria((s) => s.attention.autoUpdateCheck !== false);
  const appVersion = useAria((s) => s.appVersion);
  const setAttention = useAria((s) => s.setAttention);
  const checkForUpdates = useAria((s) => s.checkForUpdates);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const toggle = async (on: boolean) => {
    if (await setAttention({ autoUpdateCheck: on })) {
      onSaved(on ? "ARIA checks for updates by itself." : "ARIA checks for updates only when you press Check now.");
    }
  };
  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      setResult(await checkForUpdates());
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="space-y-1.5" data-testid="updates-section">
      <div className="font-medium">Updates</div>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" data-testid="update-auto-check" checked={auto} onChange={(e) => void toggle(e.target.checked)} />
        Check for ARIA updates automatically
      </label>
      <p className="text-xs text-muted">
        ARIA reads its latest release on GitHub, without signing in, when it starts, every 6 hours and after the PC wakes. A newer one shows in a bar at the top of the window and in the tray menu. Off: only when you press Check now.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          data-testid="update-check-now"
          disabled={checking}
          onClick={() => void check()}
          className="rounded border border-line px-2 py-1 text-fg hover:border-accent disabled:opacity-40"
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        <span className="text-muted">You have ARIA v{appVersion}.</span>
        {result && (
          <span data-testid="update-check-result" data-status={result.status} className={result.status === "failed" ? "text-bad" : result.status === "available" ? "text-warn" : "text-ok"}>
            {checkResultText(result)}
          </span>
        )}
      </div>
    </section>
  );
}

export function CustomizeNotifications() {
  const attention = useAria((s) => s.attention);
  const setAttention = useAria((s) => s.setAttention);
  const actionError = useAria((s) => s.actionError);
  const [minutes, setMinutes] = useState(String(attention.awayMinutes ?? 15));
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (attention.awayMinutes !== null) setMinutes(String(attention.awayMinutes));
  }, [attention.awayMinutes]);
  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= 1 && value <= 1440;
  const save = async (patch: Parameters<typeof setAttention>[0], done: string) => {
    setSaved(null);
    if (await setAttention(patch)) setSaved(done);
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 p-6 text-sm">
        <section className="space-y-1">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" data-testid="notifications-focus" checked={attention.focusMode} onChange={(e) => void save({ focusMode: e.target.checked }, e.target.checked ? "Focus mode is on." : "Focus mode is off.")} />
            Focus mode
          </label>
          <p className="text-xs text-muted">
            While you're away, only questions, approvals, plans, budget pauses and failures pop up. Finished tasks wait for the "while you were away" card, which then shows when you come back, however long you were gone. Also in the chat header and the tray menu.
          </p>
        </section>
        <section className="space-y-1.5">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              data-testid="away-enabled"
              checked={attention.awayMinutes !== null}
              onChange={(e) => void save({ awayMinutes: e.target.checked ? (valid ? value : 15) : null }, e.target.checked ? "The summary is on." : "The summary is off (it still shows after Focus mode held something back).")}
            />
            "While you were away" summary
          </label>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>When I come back after</span>
            <input
              data-testid="away-minutes"
              aria-label="Minutes away"
              type="number"
              min={1}
              max={1440}
              value={minutes}
              disabled={attention.awayMinutes === null}
              onChange={(e) => {
                setMinutes(e.target.value);
                setSaved(null);
              }}
              className="w-20 rounded border border-line bg-canvas px-2 py-1 text-fg outline-none focus:border-accent disabled:opacity-50"
            />
            <span>minutes or more away, one card sums up what finished, failed and needs you.</span>
            <button
              data-testid="away-save"
              disabled={attention.awayMinutes === null || !valid || value === attention.awayMinutes}
              onClick={() => void save({ awayMinutes: value }, `Saved: after ${value} minute${value === 1 ? "" : "s"}.`)}
              className="rounded bg-accent px-2 py-1 text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {!valid && attention.awayMinutes !== null && <div className="text-xs text-bad">Between 1 and 1440 minutes.</div>}
        </section>
        <GitHubSection />
        <OutlookSection onSaved={(msg) => setSaved(msg)} />
        <PhonePushSection onSaved={(msg) => setSaved(msg)} />
        <TelegramSection onSaved={(msg) => setSaved(msg)} />
        <VoiceSection onSaved={(msg) => setSaved(msg)} />
        <section className="space-y-2" data-testid="desktop-section">
          <div className="font-medium">Desktop & shortcuts</div>
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              data-testid="start-at-login"
              checked={attention.startAtLogin === true}
              onChange={(e) =>
                void save(
                  { startAtLogin: e.target.checked },
                  e.target.checked ? "ARIA will start when you sign in to Windows." : "Start at login is off.",
                )
              }
            />
            Start ARIA when I sign in to Windows
          </label>
          <p className="text-xs text-muted">
            Launches ARIA automatically on Windows sign-in. Also available in the system tray menu.
          </p>
          <label className={`flex items-center gap-2 pl-5 font-medium ${attention.startAtLogin === true ? "" : "opacity-50"}`}>
            <input
              type="checkbox"
              data-testid="start-minimized"
              checked={attention.startMinimized !== false}
              disabled={attention.startAtLogin !== true}
              onChange={(e) =>
                void save(
                  { startMinimized: e.target.checked },
                  e.target.checked
                    ? "ARIA will start minimized in the system tray on sign-in."
                    : "ARIA will open its main window on sign-in.",
                )
              }
            />
            Start minimized in the system tray on sign-in
          </label>
          <p className="pl-5 text-xs text-muted">
            Starts quietly in the tray when Windows boots without popping up the main window until you open it or press <kbd className="font-mono">Ctrl+Alt+Space</kbd>.
          </p>
          <label className="flex items-center gap-2 pt-1 font-medium">
            <input
              type="checkbox"
              data-testid="quick-prompt-hotkey"
              checked={attention.quickPromptHotkey !== false}
              onChange={(e) =>
                void save(
                  { quickPromptHotkey: e.target.checked },
                  e.target.checked
                    ? "Global Ctrl+Alt+Space quick prompt hotkey is on."
                    : "Global Ctrl+Alt+Space hotkey is off (Ctrl+Space still works inside the ARIA window).",
                )
              }
            />
            Global quick prompt bar hotkey (<kbd className="rounded border border-line px-1 py-px font-mono text-xs">Ctrl+Alt+Space</kbd>)
          </label>
          <p className="text-xs text-muted">
            Opens the Spotlight-style quick prompt bar from anywhere without conflicting with editor completion like Visual Studio IntelliSense (<kbd className="font-mono">Ctrl+Space</kbd> still works while ARIA is focused).
          </p>
        </section>
        <UpdatesSection onSaved={(msg) => setSaved(msg)} />
        <section className="space-y-1 text-xs text-muted">
          <div className="font-medium text-fg">Toasts</div>
          <p>
            Toasts come only while you're away: the window isn't in front, the screen is locked, the PC sleeps, or there's been no input for 5 minutes. While ARIA is in front, the cards and the "needs you" count show everything.
          </p>
          <p>Windows may only show toasts for an installed app (one with a Start Menu shortcut). While ARIA runs from its source folder they may not appear; the chat and the tray dot still show everything.</p>
        </section>
        {saved && (
          <div className="text-xs text-ok" data-testid="notifications-saved">
            {saved}
          </div>
        )}
        {actionError && <div className="text-xs text-bad">{actionError}</div>}
      </div>
    </div>
  );
}
