/**
 * opencode-video-analysis — audio-aware transcription layer.
 *
 * Copyright (C) 2026 Mesum Raza <https://github.com/mesumraza>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of a dual-licensed project: AGPL-3.0-or-later for everyone,
 * plus a commercial licence for closed-source use. See LICENSE, NOTICE and
 * COMMERCIAL.md. Keep this header and the copyright line in any derivative.
 *
 * Two engines behind one config, because they are genuinely different APIs:
 *
 *   "responses"      POST {baseUrl}                      model: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
 *                    prompt + input_audio content parts. Free tier, prompt-driven,
 *                    we ask for timecoded verbatim lines.
 *
 *   "transcriptions" POST https://openrouter.ai/api/v1/audio/transcriptions
 *                    model: nvidia/nemotron-3.5-transcribe
 *                    dedicated STT: long files, diarization, better accuracy (~$0.000017/s).
 *
 * Everything is overridable in the established order:
 *   tool argument → plugin options → env → engine default
 * and the audit records where each value came from, never the secret.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type TranscribeEngine = "responses" | "transcriptions";
export type TranscribeMode = "auto" | "prompt" | "report";

export interface TranscriberConfig {
  enabled: boolean;
  engine: TranscribeEngine;
  id: string;
  base_url: string;
  model: string;
  api_key: string;
  api_key_source: string;
  extra_headers: Record<string, string>;
  language: string | null;
  mode: TranscribeMode;
  diarize: boolean;
  /** Ask the endpoint for timed segments/words (verbose_json on the STT API). */
  timestamps: boolean;
  /** Grain of the cue structure: word timings grouped into cues, or provider segments. */
  granularity: "segment" | "word";
  /** Extra body fields passed straight through (speakers_expected, prompt, temperature…). */
  extra_body: Record<string, unknown>;
}

const RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const MODEL_RESPONSES = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const MODEL_TRANSCRIBE = "nvidia/nemotron-3.5-transcribe";

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

export function resolveTranscriber(
  arg: unknown,
  options: Record<string, any>,
  env: Record<string, string | undefined> = process.env,
): TranscriberConfig {
  // arg: false | true | "auto" | { engine?, model?, baseUrl?, language?, diarize?, mode?, apiKey?, headers?, extraBody? }
  const argObj = typeof arg === "object" && arg ? (arg as Record<string, any>) : {};
  const argOn =
    arg === false ? false
    : arg === true || arg === "on" ? true
    : typeof arg === "object" && arg !== null ? true
    : undefined;

  const optRaw = options.transcribe;
  const optObj = typeof optRaw === "object" && optRaw ? (optRaw as Record<string, any>) : {};
  const optOn = typeof optRaw === "boolean" ? optRaw : undefined;

  const envMode = env.VIDEO_ANALYSIS_TRANSCRIBE; // "on" | "off"
  const envOn = envMode === "off" ? false : envMode === "on" ? true : undefined;

  const explicitEngine = pick(
    typeof argObj.engine === "string" ? (argObj.engine as TranscribeEngine) : undefined,
    typeof optObj.engine === "string" ? (optObj.engine as TranscribeEngine) : undefined,
    env.VIDEO_ANALYSIS_TRANSCRIBE_ENGINE as TranscribeEngine | undefined,
  );

  const explicitUrl = pick(
    typeof argObj.baseUrl === "string" ? argObj.baseUrl : undefined,
    typeof optObj.baseUrl === "string" ? optObj.baseUrl : undefined,
    env.VIDEO_ANALYSIS_TRANSCRIBE_BASE_URL,
    env.VIDEO_ANALYSIS_BASE_URL,
  );

  // Engine is derived from the endpoint when not stated. Default is the dedicated
  // STT service: it is the only path that returns word timings, and word grain is
  // the default cue source. Set engine:"responses" for the free, prompt-driven path.
  const engine: TranscribeEngine =
    explicitEngine ??
    (explicitUrl
      ? explicitUrl.includes("/audio/transcriptions")
        ? "transcriptions"
        : "responses"
      : "transcriptions");

  const base_url =
    explicitUrl ??
    (engine === "transcriptions" ? TRANSCRIPTIONS_URL : RESPONSES_URL);

  const model =
    pick(
      typeof argObj.model === "string" ? argObj.model : undefined,
      typeof optObj.model === "string" ? optObj.model : undefined,
      env.VIDEO_ANALYSIS_TRANSCRIBE_MODEL,
    ) ?? (engine === "transcriptions" ? MODEL_TRANSCRIBE : MODEL_RESPONSES);

  const optKey = pick(
    typeof argObj.apiKey === "string" ? argObj.apiKey : undefined,
    typeof optObj.apiKey === "string" ? optObj.apiKey : undefined,
  );
  const envKey = env.VIDEO_ANALYSIS_TRANSCRIBE_API_KEY;
  const sharedKey = env.VIDEO_ANALYSIS_API_KEY ?? env.OPENROUTER_API_KEY;
  const api_key = optKey ?? envKey ?? sharedKey ?? "";
  const api_key_source = optKey
    ? "plugin-options:apiKey"
    : envKey
      ? "env:VIDEO_ANALYSIS_TRANSCRIBE_API_KEY"
      : env.VIDEO_ANALYSIS_API_KEY
        ? "env:VIDEO_ANALYSIS_API_KEY"
        : env.OPENROUTER_API_KEY
          ? "env:OPENROUTER_API_KEY"
          : "none";

  const id =
    pick(
      typeof argObj.provider === "string" ? argObj.provider : undefined,
      typeof optObj.provider === "string" ? optObj.provider : undefined,
      env.VIDEO_ANALYSIS_TRANSCRIBE_PROVIDER,
    ) ?? (base_url.includes("openrouter.ai") ? "openrouter" : "custom");

  const language =
    pick(
      typeof argObj.language === "string" ? argObj.language : undefined,
      typeof optObj.language === "string" ? optObj.language : undefined,
      env.VIDEO_ANALYSIS_TRANSCRIBE_LANGUAGE,
    ) ?? null;

  const diarize =
    (typeof argObj.diarize === "boolean" ? argObj.diarize : undefined) ??
    (typeof optObj.diarize === "boolean" ? optObj.diarize : undefined) ??
    (env.VIDEO_ANALYSIS_TRANSCRIBE_DIARIZE === "on" || env.VIDEO_ANALYSIS_TRANSCRIBE_DIARIZE === "true");

  const timestamps =
    (typeof argObj.timestamps === "boolean" ? argObj.timestamps : undefined) ??
    (typeof optObj.timestamps === "boolean" ? optObj.timestamps : undefined) ??
    env.VIDEO_ANALYSIS_TRANSCRIBE_TIMESTAMPS !== "off";

  const granularityRaw =
    pick(argObj.granularity, optObj.granularity, env.VIDEO_ANALYSIS_TRANSCRIBE_GRANULARITY) ?? "word";
  const granularity: "segment" | "word" = granularityRaw === "segment" ? "segment" : "word";

  const modeRaw = pick(argObj.mode, optObj.mode, env.VIDEO_ANALYSIS_TRANSCRIBE_MODE) ?? "auto";
  const mode: TranscribeMode = modeRaw === "prompt" || modeRaw === "report" ? modeRaw : "auto";

  const extra_headers = (argObj.headers ?? optObj.headers ?? {}) as Record<string, string>;
  const extra_body = (argObj.extraBody ?? optObj.extraBody ?? {}) as Record<string, unknown>;

  return {
    enabled: (argOn ?? optOn ?? envOn ?? true) && api_key.length > 0,
    engine,
    id,
    base_url,
    model,
    api_key,
    api_key_source,
    extra_headers,
    language,
    mode,
    diarize,
    timestamps,
    granularity,
    extra_body,
  };
}

// ---------------------------------------------------------------- audio

/**
 * Mono 16 kHz MP3 per window. 64 kbps mono at 16 kHz is comfortably enough for
 * speech and keeps each request small; timestamps stay exact because we cut with
 * the same -ss/-t as the video chunk.
 */
export async function extractAudioWindow(opts: {
  input: string;
  outDir: string;
  index: number;
  start: number;
  duration: number;
  signal?: AbortSignal;
}): Promise<{ file: string; duration_ms: number }> {
  const file = join(opts.outDir, `audio_${opts.index}.mp3`);
  const t0 = Date.now();
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss", String(opts.start),
      "-t", String(opts.duration),
      "-i", opts.input,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "libmp3lame",
      "-b:a", "64k",
      file,
    ],
    { signal: opts.signal },
  );
  return { file, duration_ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- calls

export interface TranscriptionAttempt {
  attempt: number;
  at: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  request_shape: string | null;
  error: string | null;
}

export interface TranscriptSegment {
  start_sec: number;
  end_sec: number;
  text: string;
  speaker: string | null;
}

export interface TranscriptWord {
  word: string;
  start_sec: number;
  end_sec: number;
}

export interface TranscriptCue {
  start_sec: number;
  end_sec: number;
  text: string;
  speaker: string | null;
  /** Word timings for this cue, as [start_sec, end_sec, word]. */
  words?: Array<[number, number, string]>;
}

export interface TranscriptResult {
  text: string;
  /** Cues (display/selection units); each cue owns the words spoken inside it. */
  cues: TranscriptCue[];
  cue_count: number;
  word_count: number;
  words_truncated: boolean;
  /** Where cue boundaries came from: the endpoint, our grouping, or the window. */
  cue_source: "provider" | "grouped" | "text";
  language: string | null;
  engine: TranscribeEngine;
  model: string;
  request_shape: string | null;
  calls: number;
  attempts: TranscriptionAttempt[];
  usage: unknown;
  error: string | null;
}

interface Shape {
  name: string;
  body?: Record<string, unknown>;
  form?: boolean;
}

function responseText(body: any): string {
  return String(
    body?.output?.[body.output?.length - 1]?.content?.[0]?.text ??
    body?.text ??
    body?.transcript ??
    body?.results?.map?.((r: any) => r?.text ?? r?.transcript).filter(Boolean).join("\n") ??
    "",
  ).trim();
}

function timeToSec(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const s = value.trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s.replace(/s$/, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn whatever timing the endpoint returned into absolute seconds in the full
 * video. STT endpoints report clip-relative times, so they always need the
 * offset; prompt-driven engines were told to emit absolute times already.
 */
function makeSegment(
  engine: TranscribeEngine,
  offset: number,
  start: number | null,
  end: number | null,
  text: string,
  speaker: string | null,
): TranscriptSegment | null {
  const body = text.trim();
  if (!body) return null;
  if (start === null) return { start_sec: round2(offset), end_sec: round2(offset), text: body, speaker };

  const abs =
    engine === "transcriptions"
      ? offset + start
      : start < offset - 0.5
        ? start + offset
        : start;
  const absEnd =
    end === null ? abs : engine === "transcriptions" ? offset + end : end < offset - 0.5 ? end + offset : end;

  return {
    start_sec: round2(abs),
    end_sec: round2(Math.max(absEnd, abs)),
    text: body,
    speaker,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function segmentsFromBody(body: any, engine: TranscribeEngine, offset: number): TranscriptSegment[] {
  const raw =
    (Array.isArray(body?.segments) && body.segments) ||
    (Array.isArray(body?.results?.[0]?.segments) && body.results[0].segments) ||
    (Array.isArray(body?.words) && body.words) ||
    (Array.isArray(body?.results?.[0]?.words) && body.results[0].words) ||
    null;
  if (!raw) return [];

  const out: TranscriptSegment[] = [];
  for (const s of raw.slice(0, 500)) {
    const seg = makeSegment(
      engine,
      offset,
      timeToSec(s?.start ?? s?.start_time ?? s?.from),
      timeToSec(s?.end ?? s?.end_time ?? s?.to),
      String(s?.text ?? s?.word ?? s?.transcript ?? ""),
      typeof s?.speaker === "string" ? s.speaker : typeof s?.speaker_id === "string" ? s.speaker_id : null,
    );
    if (seg) out.push(seg);
  }
  return out;
}

/** Fallback: mine `mm:ss text` lines from prose (the prompt-driven engine emits these). */
function segmentsFromTimedLines(text: string, engine: TranscribeEngine, offset: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—:]?\s*(.+)$/);
    if (!m) continue;
    const seg = makeSegment(engine, offset, timeToSec(m[1]), null, m[2], null);
    if (seg) out.push(seg);
  }
  return out;
}

/**
 * Request shapes tried in order, because the transcriptions endpoint accepts
 * either a multipart upload or JSON depending on the provider revision. The
 * shape that worked is recorded in the audit so a future run is one-shot.
 */
function shapesFor(cfg: TranscriberConfig, base64: string, instruction: string, filename: string): Shape[] {
  if (cfg.engine === "transcriptions") {
    const common: Record<string, unknown> = {
      model: cfg.model,
      ...(cfg.language ? { language: cfg.language } : {}),
      ...(cfg.diarize ? { diarize: true } : {}),
      // Ask for timings explicitly; verbose_json is the OpenAI-compatible spelling.
      ...(cfg.timestamps
        ? { response_format: "verbose_json", timestamp_granularities: [cfg.granularity] }
        : {}),
      ...cfg.extra_body,
    };
    return [
      { name: "json:input_audio", body: { ...common, input_audio: { data: base64, format: "mp3" } } },
      { name: "json:audio-object", body: { ...common, audio: { data: base64, format: "mp3" } } },
      { name: "json:audio-b64", body: { ...common, audio: base64 } },
      { name: "multipart:file", form: true },
    ];
  }
  return [
    {
      name: "responses:input_audio",
      body: {
        model: cfg.model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: instruction },
              { type: "input_audio", input_audio: { data: base64, format: "mp3" } },
            ],
          },
        ],
        ...cfg.extra_body,
      },
    },
  ];
}

async function sendShape(opts: {
  cfg: TranscriberConfig;
  shape: Shape;
  base64: string;
  audioFile: string;
  filename: string;
  instruction: string;
  signal?: AbortSignal;
}): Promise<{ resp: Response; shape: Shape }> {
  const { cfg, shape } = opts;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.api_key}`,
    ...cfg.extra_headers,
  };

  if (shape.form) {
    // Lazy import keeps the common path free of FormData/Blob dependencies.
    const bytes = Buffer.from(opts.base64, "base64");
    const form = new FormData();
    form.append("model", cfg.model);
    if (cfg.language) form.append("language", cfg.language);
    if (cfg.diarize) form.append("diarize", "true");
    for (const [k, v] of Object.entries(cfg.extra_body)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    form.append("file", new Blob([bytes], { type: "audio/mpeg" }), opts.filename);
    const resp = await fetch(cfg.base_url, { method: "POST", headers, body: form, signal: opts.signal });
    return { resp, shape };
  }

  headers["Content-Type"] = "application/json";
  const resp = await fetch(cfg.base_url, {
    method: "POST",
    headers,
    body: JSON.stringify(shape.body),
    signal: opts.signal,
  });
  return { resp, shape };
}

/**
 * Best-effort by contract: on failure it returns empty text plus the attempt
 * trail, and the caller continues video-only. Never fails the run.
 */
export async function transcribeWindow(opts: {
  cfg: TranscriberConfig;
  audioFile: string;
  startSec: number;
  endSec: number;
  prompt: string;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<TranscriptResult> {
  const { cfg } = opts;
  const attempts: TranscriptionAttempt[] = [];
  const base64 = (await readFile(opts.audioFile)).toString("base64");
  const filename = opts.audioFile.split(/[\\/]/).pop() ?? "audio.mp3";

  const instruction =
    `Transcribe the speech in this audio verbatim, one line per utterance, ` +
    `prefixing each line with its absolute timecode in the full video (this clip starts at ` +
    `${opts.startSec}s, so add ${opts.startSec} to any clip-relative time). ` +
    `Preserve names exactly as spoken. ` +
    `${cfg.language ? `Language: ${cfg.language}. ` : ""}` +
    `Do not summarise; do not add commentary.\n\n` +
    `Topic context for names/terms: ${opts.prompt}`;

  const shapes = shapesFor(cfg, base64, instruction, filename);
  let lastError: string | null = null;
  let calls = 0;

  // Outer loop = retry rounds; inner loop = shape discovery within a round.
  const rounds = opts.maxAttempts ?? 2;
  for (let round = 1; round <= rounds; round++) {
    for (const shape of shapes) {
      const t0 = Date.now();
      let status: number | null = null;
      calls += 1;
      try {
        const { resp } = await sendShape({
          cfg,
          shape,
          base64,
          audioFile: opts.audioFile,
          filename,
          instruction,
          signal: opts.signal,
        });
        status = resp.status;
        const body = (await resp.json().catch(() => ({}))) as Record<string, any>;

        if (!resp.ok) {
          lastError = `transcriber ${cfg.id}/${cfg.engine} (${resp.status}): ${JSON.stringify(body).slice(0, 300)}`;
          attempts.push({ attempt: calls, at: new Date().toISOString(), ok: false, http_status: status, duration_ms: Date.now() - t0, request_shape: shape.name, error: lastError });
          // 4xx that is not a shape problem will not improve on retry.
          if (resp.status === 401 || resp.status === 403 || resp.status === 402) {
            return {
              text: "", language: cfg.language, engine: cfg.engine, model: cfg.model,
              request_shape: shape.name, calls, attempts, usage: null, cues: [], cue_count: 0, cue_source: "text", word_count: 0, words_truncated: false, error: lastError,
            };
          }
          continue; // try the next shape
        }

        const text = responseText(body);
        attempts.push({ attempt: calls, at: new Date().toISOString(), ok: true, http_status: status, duration_ms: Date.now() - t0, request_shape: shape.name, error: null });

        if (!text) {
          lastError = "transcriber returned an empty transcript";
          continue;
        }

        const words = wordsOf(body, cfg.engine, opts.startSec);
        const cues = segmentsFromBody(body, cfg.engine, opts.startSec);

        const MAX_WORDS = 3000;
        const keptWords = words ? words.slice(0, MAX_WORDS) : null;

        const haveWords = Boolean(keptWords && keptWords.length);
        const useWordsAsGrain = cfg.granularity === "word" && haveWords;

        const baseCues: TranscriptCue[] = useWordsAsGrain
          ? cuesFromWords(keptWords!)
          : cues.length
            ? cues
            : haveWords
              ? cuesFromWords(keptWords!)
              : withSegments(body, text, cfg, opts.startSec);

        const finalCues = attachWords(baseCues, keptWords);
        const cue_source: TranscriptResult["cue_source"] = useWordsAsGrain || (!cues.length && haveWords)
          ? "grouped"
          : cues.length
            ? "provider"
            : "text";

        return {
          text,
          cues: finalCues,
          cue_count: finalCues.length,
          word_count: words?.length ?? 0,
          words_truncated: Boolean(words && words.length > MAX_WORDS),
          cue_source,
          language: cfg.language,
          engine: cfg.engine,
          model: cfg.model,
          request_shape: shape.name,
          calls,
          attempts,
          usage: body?.usage ?? null,
          error: null,
        };
      } catch (e) {
        lastError = (e as Error).message;
        attempts.push({ attempt: calls, at: new Date().toISOString(), ok: false, http_status: status, duration_ms: Date.now() - t0, request_shape: shape.name, error: lastError });
        if ((e as Error).name === "AbortError") {
          return {
            text: "", cues: [], cue_count: 0, cue_source: "text", word_count: 0, words_truncated: false,
            language: cfg.language, engine: cfg.engine, model: cfg.model,
            request_shape: shape.name, calls, attempts, usage: null, error: lastError,
          };
        }
      }
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, 1200 * round));
  }

  return {
    text: "", cues: [], cue_count: 0, cue_source: "text", word_count: 0, words_truncated: false,
    language: cfg.language, engine: cfg.engine, model: cfg.model,
    request_shape: attempts[attempts.length - 1]?.request_shape ?? null,
    calls, attempts, usage: null, error: lastError,
  };
}

/** Body timings win; otherwise mine timecoded lines; otherwise one span for the window. */
function withSegments(
  body: any,
  text: string,
  cfg: TranscriberConfig,
  offset: number,
): TranscriptSegment[] {
  const fromBody = segmentsFromBody(body, cfg.engine, offset);
  if (fromBody.length > 0) return fromBody;

  const fromLines = segmentsFromTimedLines(text, cfg.engine, offset);
  if (fromLines.length > 0) return fromLines;

  // No timings anywhere: keep the text but say so, rather than inventing times.
  return cfg.timestamps ? [] : [{ start_sec: round2(offset), end_sec: round2(offset), text, speaker: null }];
}

function wordsOf(body: any, engine: TranscribeEngine, offset: number): TranscriptWord[] | null {
  const raw =
    (Array.isArray(body?.words) && body.words) ||
    (Array.isArray(body?.results?.[0]?.words) && body.results[0].words) ||
    null;
  if (!raw) return null;

  const out: TranscriptWord[] = [];
  for (const w of raw.slice(0, 5000)) {
    const text = String(w?.word ?? w?.text ?? "").trim();
    const start = timeToSec(w?.start ?? w?.start_time);
    if (!text || start === null) continue;
    const end = timeToSec(w?.end ?? w?.end_time) ?? start;
    const shift = engine === "transcriptions" ? offset : start < offset - 0.5 ? offset : 0;
    out.push({ word: text, start_sec: round2(start + shift), end_sec: round2(Math.max(end + shift, start + shift)) });
  }
  return out.length ? out : null;
}

/**
 * Word timings are the most precise form, but 5k words is not useful prose.
 * Group them into readable lines on pauses, punctuation, or a length cap — each
 * line keeping the exact start of its first word and end of its last.
 */
function cuesFromWords(words: TranscriptWord[], maxChars = 110, gapSec = 0.6): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let cur: TranscriptWord[] = [];

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.word).join(" ").replace(/\s+([,.!?;:])/g, "$1").trim();
    cues.push({ start_sec: cur[0].start_sec, end_sec: cur[cur.length - 1].end_sec, text, speaker: null });
    cur = [];
  };

  for (const w of words) {
    const prev = cur[cur.length - 1];
    const gap = prev ? w.start_sec - prev.end_sec : 0;
    const wouldBeLong = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length > maxChars;
    const endsUtterance = prev ? /[.!?]$/.test(prev.word) : false;

    if (cur.length && (gap >= gapSec || wouldBeLong || endsUtterance)) flush();
    cur.push(w);
  }
  flush();
  return cues;
}

/**
 * Put each word under the cue that contains it, so a cue is self-contained:
 * you read the phrase and its exact word timings in one place.
 */
function attachWords(cues: TranscriptCue[], words: TranscriptWord[] | null): TranscriptCue[] {
  if (!words || words.length === 0) return cues;
  const out: TranscriptCue[] = cues.map((c) => ({ ...c }));
  if (out.length === 0) return out;

  for (const w of words) {
    const mid = (w.start_sec + w.end_sec) / 2;
    let idx = out.findIndex((l) => mid >= l.start_sec && mid <= l.end_sec);
    if (idx === -1) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      out.forEach((l, i) => {
        const d = Math.min(Math.abs(mid - l.start_sec), Math.abs(mid - l.end_sec));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      idx = best;
    }
    (out[idx].words ??= []).push([w.start_sec, w.end_sec, w.word]);
  }
  return out;
}

// ---------------------------------------------------------------- prompt glue

/** Audio ground truth wins for names and wording; video wins for visuals. */
export function transcriptBlock(transcript: string | null, tailBefore?: string): string {
  if (!transcript) return "";
  const parts = [
    "Audio transcript for this segment (verbatim; trust it for speech, names and numbers; ignore spelling in on-screen text if it disagrees):",
    transcript,
  ];
  if (tailBefore) parts.push(`Transcript tail from the previous segment (continuity only): ${tailBefore}`);
  return `${parts.join("\n")}\n\n`;
}

/** Compact form for the stitcher: keeps quotes honest without re-sending everything. */
export function transcriptDigest(perSegment: Array<{ label: string; text: string }>, maxChars = 4000): string {
  const joined = perSegment
    .filter((s) => s.text)
    .map((s) => `### Transcript ${s.label}\n${s.text}`)
    .join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…(truncated)` : joined;
}

/**
 * Audit shape this module feeds (schema 1.5):
 *
 * input.transcription{ enabled, engine, id, base_url, model, api_key_source,
 *                      language, mode, diarize, timestamps, granularity }
 * chain[i].transcription{ ok, engine, model, request_shape, chars, duration_ms,
 *                         calls, attempts[], usage, error,
 *                         audio{ ok, duration_ms, file, error } }
 * segments[i].transcript{ text, chars, engine, model,
 *                         cues[]{ start_sec, end_sec, text, speaker,
 *                                 words[]{ [start_sec, end_sec, "word"] } },
 *                         cue_count, word_count, words_truncated,
 *                         cue_source: "grouped"|"provider"|"text", timed }
 * overall.transcript{ text, chars, segments_covered, cue_count, engine, model, timed }
 *
 * Cues are the only phrase-level unit here; there is no "sentence" concept.
 * Word timings are nested under the cue that contains them.
 */