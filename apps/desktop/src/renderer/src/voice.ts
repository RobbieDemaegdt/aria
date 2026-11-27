/**
 * Renderer voice helpers (Phase 6D, PLAN.md §4.7, §5.5, §10 Phase 6D, D69, D70):
 * - Spoken announcements via `window.speechSynthesis` (Windows voices) or cloud TTS (`window.aria.synthesizeSpeech`).
 * - Push-to-talk 16 kHz 16-bit mono WAV recording via Web Audio API (`getUserMedia` + `AudioContext`), with a
 *   deterministic synthetic WAV fallback when running under the E2E fake runtime / test hooks on headless machines.
 */
import type { AttentionSettings } from "@aria/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export interface SpokenLogEntry {
  id: string;
  text: string;
  priority: "blocking" | "milestone" | "test";
  provider: "system" | "cloud";
  at: number;
}

declare global {
  interface Window {
    __ariaSpoken?: SpokenLogEntry[];
    __ariaTestMicWavBase64?: string;
    ariaTestMic?: boolean;
  }
}

const MAX_SPOKEN_LOG = 100;
const MAX_SPEECH_QUEUE = 3;
const MAX_RECORD_SECONDS = 60;
const TARGET_SAMPLE_RATE = 16_000;

function recordSpokenLog(entry: SpokenLogEntry): void {
  if (typeof window === "undefined") return;
  const list = (window.__ariaSpoken ??= []);
  list.push(entry);
  if (list.length > MAX_SPOKEN_LOG) list.splice(0, list.length - MAX_SPOKEN_LOG);
}

export function listSystemVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

function speakWithSystemVoice(text: string, settings: AttentionSettings): Promise<void> {
  if (
    typeof window === "undefined" ||
    isFakeRuntimeWindow() ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 8_000);
    try {
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      const rate = settings.ttsRate ?? 1;
      utterance.rate = Math.max(0.5, Math.min(2.0, Number.isFinite(rate) ? rate : 1));
      if (settings.ttsVoice?.trim()) {
        const target = settings.ttsVoice.trim().toLowerCase();
        const match = synth.getVoices().find((v) => v.name.toLowerCase() === target || v.voiceURI.toLowerCase() === target);
        if (match) utterance.voice = match;
      }
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
      if (!synth.speaking && !synth.pending) finish();
    } catch {
      finish();
    }
  });
}

interface QueuedAnnouncement {
  event: { id: string; text: string; priority: "blocking" | "milestone" | "test" };
  settings: AttentionSettings;
  resolve: () => void;
}

const speechQueue: QueuedAnnouncement[] = [];
let speechRunning = false;

async function playOneAnnouncement(
  event: { id: string; text: string; priority: "blocking" | "milestone" | "test" },
  settings: AttentionSettings,
): Promise<void> {
  const text = event.text.trim();
  const provider = settings.ttsProvider ?? "system";
  recordSpokenLog({
    id: event.id,
    text,
    priority: event.priority,
    provider,
    at: Date.now(),
  });

  if (provider === "cloud") {
    try {
      const { audioBase64, mimeType } = await window.aria.synthesizeSpeech({ text });
      if (typeof Audio !== "undefined" && audioBase64 && !isFakeRuntimeWindow()) {
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(`data:${mimeType || "audio/mpeg"};base64,${audioBase64}`);
          const stopAudio = () => {
            try {
              audio.pause();
              audio.removeAttribute("src");
              audio.load();
            } catch {
              // The audio is discarded either way.
            }
          };
          const timer = setTimeout(() => {
            stopAudio();
            reject(new Error("Audio playback timed out"));
          }, 15_000);
          audio.onended = () => {
            clearTimeout(timer);
            resolve();
          };
          audio.onerror = () => {
            clearTimeout(timer);
            stopAudio();
            reject(new Error("Audio playback failed"));
          };
          audio.play().catch((err) => {
            clearTimeout(timer);
            stopAudio();
            reject(err);
          });
        });
        return;
      }
      if (isFakeRuntimeWindow() && audioBase64) return;
    } catch {
      // Fall back to system speechSynthesis if cloud TTS or audio playback fails.
    }
  }
  await speakWithSystemVoice(text, settings);
}

async function drainSpeechQueue(): Promise<void> {
  if (speechRunning) return;
  speechRunning = true;
  try {
    while (speechQueue.length > 0) {
      const next = speechQueue.shift()!;
      try {
        await playOneAnnouncement(next.event, next.settings);
      } finally {
        next.resolve();
      }
    }
  } finally {
    speechRunning = false;
  }
}

export function speakAnnouncement(
  event: { id: string; text: string; priority: "blocking" | "milestone" | "test" },
  settings: AttentionSettings,
): Promise<void> {
  const text = event.text.trim();
  if (!text) return Promise.resolve();
  return new Promise<void>((resolve) => {
    while (speechQueue.length >= MAX_SPEECH_QUEUE) {
      const dropped = speechQueue.shift();
      dropped?.resolve();
    }
    speechQueue.push({ event, settings, resolve });
    void drainSpeechQueue();
  });
}

/**
 * Encodes Float32 mono samples in [-1, 1] into a base64-encoded 44-byte RIFF/WAVE 16-bit PCM payload.
 */
export function encodeWavBase64(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): string {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(samples[i]!) ? samples[i]! : 0));
    const pcm = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    view.setInt16(44 + i * 2, pcm, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function downsampleBuffer(samples: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (inputRate === targetRate || inputRate <= 0) return samples;
  const ratio = inputRate / targetRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j]!;
      count++;
    }
    result[i] = count > 0 ? sum / count : (samples[start] ?? 0);
  }
  return result;
}

export interface PushToTalkSession {
  /** Stops recording and returns the base64-encoded 16 kHz mono WAV audio. */
  stop(): Promise<{ audioBase64: string; mimeType: string }>;
  /** Cancels recording and releases microphone resources without returning audio. */
  cancel(): void;
}

function isFakeRuntimeWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.ariaTestMic === true || Boolean(window.__ariaTestMicWavBase64)) return true;
  if (typeof document !== "undefined" && (document.title.includes("fake runtime") || document.title.includes("test hooks"))) {
    return true;
  }
  return false;
}

function createSyntheticPushToTalkSession(): PushToTalkSession {
  return {
    async stop() {
      if (typeof window !== "undefined" && window.__ariaTestMicWavBase64) {
        return {
          audioBase64: window.__ariaTestMicWavBase64,
          mimeType: "audio/wav",
        };
      }
      const samples = new Float32Array(TARGET_SAMPLE_RATE / 4); // 250 ms of 440 Hz tone
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE) * 0.15;
      }
      return {
        audioBase64: encodeWavBase64(samples, TARGET_SAMPLE_RATE),
        mimeType: "audio/wav",
      };
    },
    cancel() {
      // The test window's sample isn't recording anything.
    },
  };
}

export async function startPushToTalkRecording(): Promise<PushToTalkSession> {
  if (isFakeRuntimeWindow()) {
    return createSyntheticPushToTalkSession();
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone recording isn't available on this device.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not access the microphone: ${detail}`, { cause: err });
  }

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  const maxSamples = ctx.sampleRate * MAX_RECORD_SECONDS;
  let cleanedUp = false;

  processor.onaudioprocess = (event) => {
    if (cleanedUp || totalSamples >= maxSamples) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    totalSamples += copy.length;
  };

  source.connect(processor);
  processor.connect(ctx.destination);

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      processor.disconnect();
      source.disconnect();
    } catch {
      // Already disconnected: the recording is over either way.
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Already stopped: the recording is over either way.
      }
    }
    void ctx.close().catch(() => {
      // Already closed: the recording is over either way.
    });
  };

  return {
    async stop() {
      const inputRate = ctx.sampleRate || TARGET_SAMPLE_RATE;
      cleanup();
      const merged = new Float32Array(Math.max(totalSamples, Math.round(inputRate * 0.1)));
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const resampled = downsampleBuffer(merged, inputRate, TARGET_SAMPLE_RATE);
      return {
        audioBase64: encodeWavBase64(resampled, TARGET_SAMPLE_RATE),
        mimeType: "audio/wav",
      };
    },
    cancel() {
      cleanup();
    },
  };
}

const HOLD_THRESHOLD_MS = 250;

export interface UsePushToTalkResult {
  recording: boolean;
  transcribing: boolean;
  pttError: string | null;
  clearPttError(): void;
  onPointerDown(): void;
  onPointerUp(): void;
  handleKeyDown(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; preventDefault(): void; stopPropagation(): void }): boolean;
  handleKeyUp(e: { key: string; code: string; preventDefault(): void; stopPropagation(): void }): boolean;
  cancel(): void;
}

export function usePushToTalk(onTranscribed: (transcript: string) => void): UsePushToTalkResult {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pttError, setPttError] = useState<string | null>(null);
  const sessionRef = useRef<PushToTalkSession | null>(null);
  const startingRef = useRef<Promise<PushToTalkSession | null> | null>(null);
  const pressStartRef = useRef<number | null>(null);
  const hotkeyStartRef = useRef<number | null>(null);
  const onTranscribedRef = useRef(onTranscribed);
  onTranscribedRef.current = onTranscribed;

  const cancel = useCallback(() => {
    pressStartRef.current = null;
    hotkeyStartRef.current = null;
    const active = sessionRef.current;
    sessionRef.current = null;
    startingRef.current = null;
    setRecording(false);
    active?.cancel();
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const stopAndTranscribe = useCallback(async () => {
    pressStartRef.current = null;
    hotkeyStartRef.current = null;
    let active = sessionRef.current;
    if (!active && startingRef.current) {
      active = await startingRef.current;
    }
    sessionRef.current = null;
    startingRef.current = null;
    setRecording(false);
    if (!active) return;

    setTranscribing(true);
    setPttError(null);
    try {
      const { audioBase64, mimeType } = await active.stop();
      const result = await window.aria.transcribeAudio({ audioBase64, mimeType });
      const cleaned = result.text.trim();
      if (cleaned) {
        onTranscribedRef.current(cleaned);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
      setPttError(msg);
    } finally {
      setTranscribing(false);
    }
  }, []);

  useEffect(() => {
    if (!recording || typeof window === "undefined") return;
    const onWindowPointerUp = () => {
      const startedAt = pressStartRef.current;
      pressStartRef.current = null;
      if (startedAt !== null && Date.now() - startedAt >= HOLD_THRESHOLD_MS) {
        void stopAndTranscribe();
      }
    };
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    const onWindowKeyUp = (e: KeyboardEvent) => {
      if (hotkeyStartRef.current !== null && (e.code === "Space" || e.key === "Control" || e.key === "Shift")) {
        const startedAt = hotkeyStartRef.current;
        hotkeyStartRef.current = null;
        if (Date.now() - startedAt >= HOLD_THRESHOLD_MS) {
          e.preventDefault();
          e.stopPropagation();
          void stopAndTranscribe();
        }
      }
    };
    const onWindowBlur = () => {
      cancel();
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowBlur);
    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowBlur);
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [recording, stopAndTranscribe, cancel]);

  const start = useCallback(async () => {
    if (sessionRef.current || startingRef.current || transcribing) return;
    setPttError(null);
    setRecording(true);
    const promise = startPushToTalkRecording()
      .then((s) => {
        if (startingRef.current === promise) {
          sessionRef.current = s;
          startingRef.current = null;
          return s;
        }
        s.cancel();
        return null;
      })
      .catch((err) => {
        startingRef.current = null;
        sessionRef.current = null;
        setRecording(false);
        const msg = err instanceof Error ? err.message : String(err);
        setPttError(msg);
        return null;
      });
    startingRef.current = promise;
    await promise;
  }, [transcribing]);

  const onPointerDown = useCallback(() => {
    if (transcribing) return;
    if (recording || sessionRef.current || startingRef.current) {
      void stopAndTranscribe();
      return;
    }
    pressStartRef.current = Date.now();
    void start();
  }, [recording, transcribing, start, stopAndTranscribe]);

  const onPointerUp = useCallback(() => {
    const startedAt = pressStartRef.current;
    pressStartRef.current = null;
    if (startedAt !== null && Date.now() - startedAt >= HOLD_THRESHOLD_MS) {
      void stopAndTranscribe();
    }
  }, [stopAndTranscribe]);

  const handleKeyDown = useCallback(
    (e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; preventDefault(): void; stopPropagation(): void }): boolean => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || transcribing) return true;
        if (recording || sessionRef.current || startingRef.current) {
          void stopAndTranscribe();
        } else {
          hotkeyStartRef.current = Date.now();
          void start();
        }
        return true;
      }
      if (e.key === "Escape" && (recording || sessionRef.current || startingRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
        return true;
      }
      return false;
    },
    [recording, transcribing, start, stopAndTranscribe, cancel],
  );

  const handleKeyUp = useCallback(
    (e: { key: string; code: string; preventDefault(): void; stopPropagation(): void }): boolean => {
      if (hotkeyStartRef.current !== null && (e.code === "Space" || e.key === "Control" || e.key === "Shift")) {
        const startedAt = hotkeyStartRef.current;
        hotkeyStartRef.current = null;
        if (Date.now() - startedAt >= HOLD_THRESHOLD_MS) {
          e.preventDefault();
          e.stopPropagation();
          void stopAndTranscribe();
          return true;
        }
      }
      return false;
    },
    [stopAndTranscribe],
  );

  return {
    recording,
    transcribing,
    pttError,
    clearPttError: () => setPttError(null),
    onPointerDown,
    onPointerUp,
    handleKeyDown,
    handleKeyUp,
    cancel,
  };
}

