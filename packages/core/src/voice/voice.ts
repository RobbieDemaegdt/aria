/**
 * Voice service (Phase 6D, PLAN.md §4.7, §5.5, §10 Phase 6D, D69, D70):
 * - Validates and transcribes push-to-talk 16 kHz mono WAV audio via local `whisper.cpp` (`execFile`, `shell: false`)
 *   or an OpenAI-compatible cloud speech-to-text endpoint (`/audio/transcriptions`).
 * - Synthesizes speech via an OpenAI-compatible cloud TTS endpoint (`/audio/speech`) when `ttsProvider === "cloud"`.
 * - Cloud API keys are read/written through an injected `VoiceSecretStore` (backed by Electron's `safeStorage` in the
 *   desktop app, per PLAN.md §0.4 #6) and never returned in plaintext settings.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AttentionSettings } from "@aria/protocol";
import { ignoreCleanupFailure } from "../util/ignore.ts";

const execFileAsync = promisify(execFile);

export const MAX_WAV_BYTES = 10 * 1024 * 1024;
export const MIN_WAV_BYTES = 44;
export const DEFAULT_VOICE_CLOUD_ENDPOINT = "https://api.openai.com/v1";
export const DEFAULT_STT_CLOUD_MODEL = "whisper-1";
export const DEFAULT_TTS_CLOUD_MODEL = "tts-1";
export const DEFAULT_TTS_CLOUD_VOICE = "alloy";
const VOICE_TIMEOUT_MS = 30_000;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/gu;

export interface VoiceSecretStore {
  hasKey(): boolean;
  getKey(): string | undefined;
  setKey(key: string | null): void;
}

export type VoiceTranscriber = (wavBuffer: Buffer, settings: AttentionSettings) => Promise<string>;
export type VoiceSynthesizer = (text: string, settings: AttentionSettings) => Promise<{ audioBase64: string; mimeType: string }>;

export interface VoiceServiceDeps {
  settings(): AttentionSettings;
  secretStore?: VoiceSecretStore;
  fetch?: typeof globalThis.fetch;
  transcriber?: VoiceTranscriber;
  synthesizer?: VoiceSynthesizer;
  env?: NodeJS.ProcessEnv;
}

/**
 * Encodes 16-bit mono PCM samples (`Int16Array` or `Float32Array` in [-1, 1]) into a standard 44-byte RIFF/WAVE buffer.
 */
export function encodeMonoWav(samples: Int16Array | Float32Array, sampleRate = 16_000): Buffer {
  const pcm =
    samples instanceof Int16Array
      ? samples
      : Int16Array.from(samples, (s) => {
          const clamped = Math.max(-1, Math.min(1, Number.isFinite(s) ? s : 0));
          return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
        });
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(1, 22); // NumChannels = 1 (mono)
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buf.writeUInt16LE(2, 32); // BlockAlign
  buf.writeUInt16LE(16, 34); // BitsPerSample = 16
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  }
  return buf;
}

/**
 * Validates that a decoded buffer is a bounded RIFF/WAVE file (D70).
 */
export function assertValidWavBuffer(buf: Buffer): void {
  if (buf.length < MIN_WAV_BYTES) {
    throw new Error("The recorded audio is too short to transcribe.");
  }
  if (buf.length > MAX_WAV_BYTES) {
    throw new Error("The recorded audio exceeds the 10 MB push-to-talk limit.");
  }
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Push-to-talk expects a valid WAV audio recording.");
  }
}

/**
 * Validates a cloud STT/TTS base endpoint URL (D70): must be `https://` or loopback `http://127.0.0.1` / `http://localhost`
 * (for a local `whisper-server`), with no embedded credentials.
 */
export function normalizeVoiceCloudEndpoint(raw?: string): string {
  const input = raw?.trim() || DEFAULT_VOICE_CLOUD_ENDPOINT;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("The cloud voice endpoint must be a valid URL (e.g. https://api.openai.com/v1).");
  }
  if (url.username || url.password) {
    throw new Error("The cloud voice endpoint must not contain a username or password.");
  }
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (!isHttps && !isLoopbackHttp) {
    throw new Error("The cloud voice endpoint must use https:// (or http://127.0.0.1 for a local Whisper server).");
  }
  return url.toString().replace(/\/+$/u, "");
}

function assertAbsoluteFile(filePath: string | undefined, label: string): string {
  const trimmed = filePath?.trim();
  if (!trimmed) {
    throw new Error(`Set the ${label} in Customize › Notifications first.`);
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`The ${label} must be an absolute file path.`);
  }
  let stat;
  try {
    stat = statSync(trimmed);
  } catch {
    throw new Error(`The ${label} wasn't found at "${trimmed}".`);
  }
  if (!stat.isFile()) {
    throw new Error(`The ${label} at "${trimmed}" must be a file, not a folder.`);
  }
  return trimmed;
}

/**
 * Cleans raw `whisper.cpp` or cloud STT output: strips `[00:00:00.000 --> 00:00:02.000]` timestamp prefixes,
 * blank-audio markers like `[BLANK_AUDIO]`, and control/invisible characters.
 */
export function cleanTranscriptText(raw: string): string {
  const lines = raw
    .replace(CONTROL_CHARS, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/u, "").trim())
    .filter((line) => line.length > 0 && !/^(\[BLANK_AUDIO\]|\(blank audio\)|\[silence\])$/iu.test(line));
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  hasCloudApiKey(): boolean {
    return Boolean(this.deps.secretStore?.hasKey());
  }

  setCloudApiKey(apiKey: string | null): void {
    if (!this.deps.secretStore) {
      throw new Error("Encrypted key storage isn't available in this environment.");
    }
    const trimmed = apiKey?.trim() ?? "";
    this.deps.secretStore.setKey(trimmed.length > 0 ? trimmed : null);
  }

  async transcribeAudio(input: { audioBase64: string; mimeType?: string }): Promise<{ text: string }> {
    let wavBuffer: Buffer;
    try {
      wavBuffer = Buffer.from(input.audioBase64, "base64");
    } catch {
      throw new Error("Invalid base64 audio payload.");
    }
    assertValidWavBuffer(wavBuffer);

    const settings = this.deps.settings();
    const provider = settings.sttProvider ?? "whisper.cpp";

    if (provider === "cloud") {
      const text = await this.transcribeWithCloud(wavBuffer, settings);
      return { text };
    }

    const env = this.deps.env ?? process.env;
    const configuredBin = settings.whisperExecutablePath?.trim() || env.ARIA_WHISPER_BIN?.trim();
    const configuredModel = settings.whisperModelPath?.trim() || env.ARIA_WHISPER_MODEL?.trim();

    if (!configuredBin && !configuredModel && this.deps.transcriber) {
      const text = cleanTranscriptText(await this.deps.transcriber(wavBuffer, settings));
      return { text };
    }

    const binPath = assertAbsoluteFile(configuredBin, "whisper.cpp executable path");
    const modelPath = assertAbsoluteFile(configuredModel, "whisper.cpp GGML model path");
    const text = await this.transcribeWithWhisperCpp(wavBuffer, binPath, modelPath);
    return { text };
  }

  private async transcribeWithWhisperCpp(wavBuffer: Buffer, binPath: string, modelPath: string): Promise<string> {
    const tempWav = path.join(os.tmpdir(), `aria-ptt-${randomUUID()}.wav`);
    await writeFile(tempWav, wavBuffer);
    try {
      const args = ["-m", modelPath, "-f", tempWav, "-nt", "-np"];
      const isNodeScript = /\.(?:c|m)?js$/iu.test(binPath);
      // In the app, process.execPath is ARIA itself: a script given to it wouldn't run, it would open ARIA.
      const file = isNodeScript ? (process.versions.electron ? "node" : process.execPath) : binPath;
      const fullArgs = isNodeScript ? [binPath, ...args] : args;
      const { stdout } = await execFileAsync(file, fullArgs, {
        timeout: VOICE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      return cleanTranscriptText(String(stdout ?? ""));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`whisper.cpp transcription failed: ${msg}`, { cause: error });
    } finally {
      await unlink(tempWav).catch(ignoreCleanupFailure);
    }
  }

  private async transcribeWithCloud(wavBuffer: Buffer, settings: AttentionSettings): Promise<string> {
    const endpoint = normalizeVoiceCloudEndpoint(settings.voiceCloudEndpoint);
    const apiKey = this.deps.secretStore?.getKey();
    const isLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/iu.test(endpoint);
    if (!apiKey && !isLoopback) {
      throw new Error("Save a cloud voice API key in Customize › Notifications before using cloud speech-to-text.");
    }
    const model = settings.sttCloudModel?.trim() || DEFAULT_STT_CLOUD_MODEL;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "speech.wav");
    form.append("model", model);

    const fetchFn = this.deps.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetchFn(`${endpoint}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = bodyText.replace(CONTROL_CHARS, " ").trim().slice(0, 200);
      throw new Error(`Cloud speech-to-text returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    const json = (await response.json()) as { text?: unknown };
    if (typeof json?.text !== "string") {
      throw new Error("Cloud speech-to-text returned an unexpected response without a text field.");
    }
    return cleanTranscriptText(json.text);
  }

  async synthesizeSpeech(input: { text: string }): Promise<{ audioBase64: string; mimeType: string }> {
    const cleaned = input.text.replace(CONTROL_CHARS, " ").trim().slice(0, 500);
    if (!cleaned) throw new Error("Nothing to speak.");
    const settings = this.deps.settings();

    if (this.deps.synthesizer && !settings.voiceCloudEndpoint && !this.hasCloudApiKey()) {
      return this.deps.synthesizer(cleaned, settings);
    }

    const endpoint = normalizeVoiceCloudEndpoint(settings.voiceCloudEndpoint);
    const apiKey = this.deps.secretStore?.getKey();
    const isLoopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/iu.test(endpoint);
    if (!apiKey && !isLoopback) {
      throw new Error("Save a cloud voice API key in Customize › Notifications before using cloud TTS.");
    }
    const model = settings.ttsCloudModel?.trim() || DEFAULT_TTS_CLOUD_MODEL;
    const voice = settings.ttsVoice?.trim() || DEFAULT_TTS_CLOUD_VOICE;
    const speed = Math.max(0.5, Math.min(2.0, settings.ttsRate ?? 1.0));

    const fetchFn = this.deps.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetchFn(`${endpoint}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: cleaned, voice, speed, response_format: "mp3" }),
      redirect: "error",
      signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = bodyText.replace(CONTROL_CHARS, " ").trim().slice(0, 200);
      throw new Error(`Cloud TTS returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType: contentType,
    };
  }
}
