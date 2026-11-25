/**
 * opencode-video-analysis — auditable, perspective-aware video analysis for OpenCode.
 *
 * Copyright (C) 2026 Mesum Raza <https://github.com/mesumraza>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of a dual-licensed project: AGPL-3.0-or-later for everyone,
 * plus a commercial licence for closed-source use. See LICENSE, NOTICE and
 * COMMERCIAL.md. Keep this header and the copyright line in any derivative.
 */
import { Plugin } from "@opencode/plugin";
import { readFile, mkdtemp, rm, stat, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cwd } from "node:process";
import {
  type TranscriberConfig,
  type TranscriptionAttempt,
  type TranscriptCue,
  type TranscriptSegment,
  extractAudioWindow,
  resolveTranscriber,
  transcriptBlock,
  transcriptDigest,
  transcribeWindow,
  type TranscriptResult,
} from "./transcription";
import { auditIndex, auditRunMeta, readSections, resolveSectionNames } from "./audit-reader";

const execFileAsync = promisify(execFile);

export const PLUGIN_ID = "opencode-video-analysis";
export const PLUGIN_VERSION = "2.7.0";
export const SCHEMA_VERSION = "1.5";

/** Seconds of video handed to the model per call. */
const CHUNK_SEC = 60;
/** Overlap between consecutive chunks so a beat on the boundary is not cut in half. */
const OVERLAP_SEC = 5;
/** Downscale + drop fps so each chunk fits the provider payload ceiling. */
const CHUNK_VF = "scale='min(1280,iw)':-2,fps=2";
/** Retries per API call (rate limits / provider 5xx). */
const MAX_ATTEMPTS = 3;
/** Hard ceiling for a background run. */
const JOB_MAX_MS = 45 * 60 * 1000;
/** Finished jobs older than this are pruned from storage. */
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded memory of what the caller wants to see. */
const MAX_ENTITIES_IN_PROMPT = 18;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/responses";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";

const ENTITY_BLOCK_OPEN = "---ENTITIES---";
const ENTITY_BLOCK_CLOSE = "---END---";

// ---------------------------------------------------------------- types

type Status = "completed" | "completed_with_errors" | "failed" | "cancelled";
type EntityKind = "person" | "object" | "place" | "ui_element" | "logo" | "text" | "other";
type RegistryStatus = "populated" | "empty_no_recurring_subjects" | "extraction_failed";

type FindingKind = "defect" | "beat" | "quote" | "claim" | "topic" | "timestamp" | "other";
type FindingSource = "model" | "heuristic";

interface Finding {
  timestamp: string | null;
  /** Absolute seconds when known, otherwise null. Used for ordering. */
  at_sec: number | null;
  /** Declared by the model against the user's request; the plugin never asserts a defect on its own. */
  kind: FindingKind;
  source: FindingSource;
  chunk_index: number | null;
  text: string;
}

interface Range {
  from_sec: number;
  to_sec: number;
  label: string;
}

interface ApiAttempt {
  attempt: number;
  at: string;
  ok: boolean;
  http_status: number | null;
  duration_ms: number;
  error: string | null;
}

interface AudioExtraction {
  ok: boolean;
  duration_ms: number;
  file: string;
  error: string | null;
}

interface TranscriptionRecord {
  ok: boolean;
  engine: string;
  model: string;
  request_shape: string | null;
  chars: number;
  duration_ms: number;
  calls: number;
  attempts: TranscriptionAttempt[];
  usage: unknown;
  error: string | null;
  audio: AudioExtraction | null;
}

interface SegmentTranscript {
  text: string;
  engine: string;
  model: string;
  chars: number;
  /** Cues (display units); each cue carries its own word timings when available. */
  cues: TranscriptCue[];
  cue_count: number;
  word_count: number;
  words_truncated: boolean;
  /** "provider" | "grouped" | "text" — where cue boundaries came from. */
  cue_source: string;
  timed: boolean;
}

interface Scene {
  chunk_index: number;
  start_sec: number;
  end_sec: number;
  time_range: string;
  setting: string;
  activity: string;
  on_screen_text: string[];
}

interface Appearance {
  chunk_index: number;
  start_sec: number;
  end_sec: number;
  cue: string;
}

interface Entity {
  id: string;
  kind: EntityKind;
  label: string | null;
  descriptors: string[];
  aliases: string[];
  appearances: Appearance[];
  first_seen_sec: number;
  last_seen_sec: number;
  confidence: number;
}

interface Registry {
  status: RegistryStatus;
  kinds_considered: EntityKind[];
  note: string | null;
  blocks_parsed: number;
  blocks_failed: number;
  observations_unmatched: number;
  entities_skipped: number;
  transcript_retries: number;
  entity_repairs: number;
}

interface Observation {
  observer: string | null;
  intent: string | null;
  focus: string[];
  assumptions: string[];
  questions: string[];
  source: "request" | "default";
}

interface ProviderConfig {
  id: string;
  base_url: string;
  model: string;
  api_key: string;
  api_key_source: string;
  extra_headers: Record<string, string>;
}

interface SegmentChain {
  chunk_index: number;
  time_range: string;
  start_sec: number;
  end_sec: number;
  offset_sec: number;
  status: "completed" | "failed";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ffmpeg: {
    ok: boolean;
    duration_ms: number;
    filter: string;
    input: string;
    output: string;
    error: string | null;
  } | null;
  api: { calls: number; attempts: ApiAttempt[]; usage: unknown; error: string | null };
  continuity_in: string[];
  summary_out: string | null;
  transcription: TranscriptionRecord | null;
  entities_added: string[];
  entities_matched: string[];
  scenes_count: number;
  entity_block: { ok: boolean; error: string | null; repaired?: boolean };
  analysis_chars: number;
}

interface SegmentView {
  chunk_index: number;
  time_range: string;
  start_sec: number;
  end_sec: number;
  offset_sec: number;
  status: "completed" | "failed";
  findings: Finding[];
  scenes: Scene[];
  entities_seen: string[];
  transcript: SegmentTranscript | null;
  analysis: string | null;
  error: string | null;
}

interface Failure {
  chunk_index: number;
  time_range: string;
  start_sec: number;
  end_sec: number;
  occurred_at: string;
  error: string;
  attempts: number;
  recoverable: boolean;
  suggestion: string;
}

interface ProgressEvent {
  at: string;
  percent: number;
  phase: "probe" | "prepare" | "chunk" | "stitch" | "done";
  status: string;
}

interface JobRef {
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  audit_key: string;
}

type JobStatus = "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";

interface Audit {
  schema_version: string;
  plugin: { id: string; version: string };
  status: Status;
  error: string | null;
  mode: "foreground" | "background";
  job: JobRef | null;

  input: {
    prompt: string;
    model: string;
    video_path: string;
    resolved_path: string | null;
    observation: Observation;
    transcription: {
      enabled: boolean;
      engine: string;
      id: string;
      base_url: string;
      model: string;
      api_key_source: string;
      language: string | null;
      mode: string;
      diarize: boolean;
      timestamps: boolean;
      granularity: string;
      skipped_reason?: string | null;
    };
    provider: {
      id: string;
      base_url: string;
      model: string;
      api_key_source: string;
      header_keys: string[];
    };
    options: {
      chunk_sec: number;
      overlap_sec: number;
      filter: string;
      max_attempts: number;
      stitch: "model" | "none";
    };
    environment: {
      cwd: string;
      platform: string;
      api_key_present: boolean;
      opencode_version: string | null;
      plugin_location: string | null;
    };
    tool_context: {
      session_id: string | null;
      message_id: string | null;
      call_id: string | null;
      agent: string | null;
    };
  };

  video: {
    source: "local" | "url";
    path: string;
    filename: string;
    duration_sec: number;
    size_mb: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    has_audio: boolean | null;
  };

  parsing: {
    strategy: "single" | "chunked";
    total_chunks: number;
    chunks_completed: number;
    chunks_failed: number;
    progress_percent: number;
    continuity: "n-1 summary + entity registry";
    coverage: {
      covered_seconds: number;
      coverage_percent: number;
      covered_ranges: Range[];
      uncovered_ranges: Range[];
    };
    failures: Failure[];
  };

  entities: Entity[];
  registry: Registry;
  scenes: Scene[];
  chain: SegmentChain[];
  segments: SegmentView[];

  overall: {
    analysis: string | null;
    perspective: string | null;
    transcript: {
      text: string;
      chars: number;
      segments_covered: number;
      engine: string;
      model: string;
      timed: boolean;
      cue_count: number;
    } | null;
    findings: Finding[];
    findings_count: number;
    entity_index: Record<string, { kind: EntityKind; label: string | null; appearances: string[] }>;
  };

  progress_log: ProgressEvent[];

  audit: {
    started_at: string;
    finished_at: string;
    elapsed_ms: number;
    probe_ms: number;
    api: { calls: number; video_calls: number; text_calls: number; retries: number; failures: number };
    stitch: {
      used: boolean;
      mode: "video-model" | "text-only" | "fallback-join";
      model: string | null;
      calls: number;
      duration_ms: number;
      attempts: ApiAttempt[];
      error: string | null;
    };
    cleanup: { workdir_used: boolean; workdir_removed: boolean };
    /** Absolute path of the exported audit JSON, when export is enabled. */
    file: string | null;
    /** Present when this run continued an earlier, unfinished job. */
    resume: {
      from_job_id: string;
      chunks_reused: number;
      /** Chunk records inherited from the interrupted run and re-run in this one. */
      chunks_discarded: number;
      config_sha: string;
    } | null;
  };
}

interface JobRecord {
  job_id: string;
  status: JobStatus;
  audit_key: string;
  video_path: string;
  resolved_path: string | null;
  filename: string;
  /** Fingerprint of file+config; a resume is only valid when this matches. */
  config_sha: string;
  resumed_from: string | null;
  created_at: string;
  updated_at: string;
  progress_percent: number;
  progress_log: ProgressEvent[];
  chunks_completed: number;
  total_chunks: number;
  findings_count: number;
  defects_count: number;
  entities_count: number;
  error: string | null;
  audit: Audit | null;
}

// ---------------------------------------------------------------- helpers

function nowIso(): string {
  return new Date().toISOString();
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec * 1000) / 1000);
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

/** Sub-second precision, for transcript lines where 0.16s should not read as 00:00. */
function formatTimePrecise(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${rest}`;
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pct(done: number, total: number): number {
  return total <= 0 ? 0 : round((done / total) * 100, 1);
}

function rangeLabel(from: number, to: number): string {
  return `${formatTime(from)} to ${formatTime(to)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Heuristics only ever recover *timestamps* from prose. They never label a
 * defect: whether something is a bug, a beat or a quote is the request's job,
 * and the model declares that in `highlights`.
 */
function heuristicFindings(analysis: string | null, chunkIndex: number | null = null): Finding[] {
  if (!analysis) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();

  for (const raw of analysis.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const clean = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*•]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (clean.length < 8) continue;

    const ts = clean.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (!ts) continue;

    const key = clean.replace(/\W+/g, "").toLowerCase().slice(0, 70);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      timestamp: ts[1],
      at_sec: parseTime(ts[1]),
      kind: "timestamp",
      source: "heuristic",
      chunk_index: chunkIndex,
      text: clean.slice(0, 300),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function findingKey(f: Finding): string {
  return f.text.replace(/\W+/g, "").toLowerCase().slice(0, 70);
}

/** Model-declared findings first, then heuristic timestamps that add something new. */
function mergeFindings(perChunk: Array<{ chunk_index: number; findings: Finding[] }>): Finding[] {
  const seen = new Set<string>();
  const declared: Finding[] = [];
  const heuristic: Finding[] = [];

  for (const { chunk_index, findings } of perChunk) {
    for (const f of findings) {
      const key = findingKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      const withChunk: Finding = { ...f, chunk_index: f.chunk_index ?? chunk_index };
      (f.source === "model" ? declared : heuristic).push(withChunk);
    }
  }

  const byTime = (a: Finding, b: Finding) =>
    (a.at_sec ?? Number.POSITIVE_INFINITY) - (b.at_sec ?? Number.POSITIVE_INFINITY);
  return [...declared.sort(byTime), ...heuristic.sort(byTime)].slice(0, 40);
}

function computeCoverage(
  duration: number,
  done: Array<{ start_sec: number; end_sec: number }>,
): { covered_seconds: number; coverage_percent: number; covered_ranges: Range[]; uncovered_ranges: Range[] } {
  if (duration <= 0) {
    return { covered_seconds: 0, coverage_percent: 0, covered_ranges: [], uncovered_ranges: [] };
  }
  const sorted = [...done].filter((r) => r.end_sec > r.start_sec).sort((a, b) => a.start_sec - b.start_sec);

  const merged: Array<{ start_sec: number; end_sec: number }> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start_sec <= last.end_sec + 0.001) last.end_sec = Math.max(last.end_sec, r.end_sec);
    else merged.push({ start_sec: r.start_sec, end_sec: r.end_sec });
  }

  const gaps: Array<{ start_sec: number; end_sec: number }> = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start_sec > cursor + 0.001) gaps.push({ start_sec: cursor, end_sec: m.start_sec });
    cursor = Math.max(cursor, m.end_sec);
  }
  if (cursor < duration - 0.001) gaps.push({ start_sec: cursor, end_sec: duration });

  const covered = round(merged.reduce((a, m) => a + (m.end_sec - m.start_sec), 0), 2);
  return {
    covered_seconds: covered,
    coverage_percent: pct(covered, duration),
    covered_ranges: merged.map((m) => ({ from_sec: m.start_sec, to_sec: m.end_sec, label: rangeLabel(m.start_sec, m.end_sec) })),
    uncovered_ranges: gaps.map((g) => ({ from_sec: g.start_sec, to_sec: g.end_sec, label: rangeLabel(g.start_sec, g.end_sec) })),
  };
}

async function probeVideo(filePath: string): Promise<{
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean | null;
}> {
  const out = {
    duration: 0,
    width: null as number | null,
    height: null as number | null,
    fps: null as number | null,
    hasAudio: null as boolean | null,
  };
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
      "-of", "json",
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const dur = parseFloat(parsed.format?.duration ?? "");
    if (Number.isFinite(dur)) out.duration = dur;

    const streams = parsed.streams ?? [];
    out.hasAudio = streams.some((s) => s.codec_type === "audio");

    const s = streams.find((x) => x.codec_type === "video");
    if (s?.width) out.width = s.width;
    if (s?.height) out.height = s.height;
    if (s?.r_frame_rate) {
      const [n, d] = s.r_frame_rate.split("/").map(Number);
      if (Number.isFinite(n) && Number.isFinite(d) && d > 0) out.fps = round(n / d, 2);
    }
  } catch {
    /* best effort */
  }
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      res();
    }, { once: true });
  });
}

function resolveProvider(argModel: string | undefined, options: Record<string, any>): ProviderConfig {
  const env = process.env as Record<string, string | undefined>;

  const optKey = typeof options.apiKey === "string" && options.apiKey ? options.apiKey : undefined;
  const envKey = env.VIDEO_ANALYSIS_API_KEY;
  const openRouterKey = env.OPENROUTER_API_KEY;
  const api_key = optKey ?? envKey ?? openRouterKey ?? "";
  const api_key_source = optKey
    ? "plugin-options:apiKey"
    : envKey
      ? "env:VIDEO_ANALYSIS_API_KEY"
      : openRouterKey
        ? "env:OPENROUTER_API_KEY"
        : "none";

  const base_url =
    (typeof options.baseUrl === "string" && options.baseUrl) || env.VIDEO_ANALYSIS_BASE_URL || DEFAULT_BASE_URL;
  const model =
    argModel || (typeof options.model === "string" && options.model) || env.VIDEO_ANALYSIS_MODEL || DEFAULT_MODEL;
  const id =
    (typeof options.provider === "string" && options.provider) ||
    env.VIDEO_ANALYSIS_PROVIDER ||
    (base_url.includes("openrouter.ai") ? "openrouter" : "custom");
  const extra_headers =
    options.headers && typeof options.headers === "object" ? (options.headers as Record<string, string>) : {};

  return { id, base_url, model, api_key, api_key_source, extra_headers };
}

function normalizeObservation(raw: unknown, prompt: string): Observation {
  const o = (raw ?? {}) as Record<string, any>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : [];
  const observer = typeof o.observer === "string" && o.observer.trim() ? o.observer.trim() : null;
  const intent = typeof o.intent === "string" && o.intent.trim() ? o.intent.trim() : null;
  const focus = strings(o.focus);
  const assumptions = strings(o.assumptions);
  const questions = strings(o.questions);
  const explicit = Boolean(observer || intent || focus.length || assumptions.length || questions.length);

  return {
    observer: observer ?? "a general video analyst",
    intent: intent ?? prompt,
    focus,
    assumptions,
    questions,
    source: explicit ? "request" : "default",
  };
}

interface CallResult {
  text: string;
  calls: number;
  attempts: ApiAttempt[];
  usage: unknown;
}

async function callProvider(opts: {
  provider: ProviderConfig;
  text: string;
  videoDataUri: string | null;
  signal?: AbortSignal;
}): Promise<CallResult> {
  const attempts: ApiAttempt[] = [];
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: opts.text }];
  if (opts.videoDataUri) content.push({ type: "input_video", video_url: opts.videoDataUri });

  const p = opts.provider;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let httpStatus: number | null = null;
    try {
      const resp = await fetch(p.base_url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${p.api_key}`,
          "Content-Type": "application/json",
          ...p.extra_headers,
        },
        body: JSON.stringify({ model: p.model, input: [{ role: "user", content }] }),
        signal: opts.signal,
      });
      httpStatus = resp.status;
      const data = (await resp.json()) as Record<string, any>;

      if (!resp.ok) {
        lastError = `${p.id} (${resp.status}): ${JSON.stringify(data).slice(0, 400)}`;
        attempts.push({ attempt, at: nowIso(), ok: false, http_status: httpStatus, duration_ms: Date.now() - t0, error: lastError });
        const retryable = resp.status === 429 || resp.status >= 500;
        if (!retryable) throw new Error(lastError);
      } else {
        const text = data?.output?.[data.output.length - 1]?.content?.[0]?.text ?? JSON.stringify(data);
        attempts.push({ attempt, at: nowIso(), ok: true, http_status: httpStatus, duration_ms: Date.now() - t0, error: null });
        return { text, calls: attempt, attempts, usage: data?.usage ?? null };
      }
    } catch (e) {
      lastError = (e as Error).message;
      if (!attempts.some((a) => a.attempt === attempt)) {
        attempts.push({ attempt, at: nowIso(), ok: false, http_status: httpStatus, duration_ms: Date.now() - t0, error: lastError });
      }
    }
    if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt, opts.signal);
  }
  const final = new Error(lastError);
  (final as any).attempts = attempts;
  throw final;
}

// ---------------------------------------------------------------- entity registry

const KIND_PREFIX: Record<EntityKind, string> = {
  person: "p",
  object: "o",
  place: "l",
  ui_element: "u",
  logo: "g",
  text: "t",
  other: "e",
};

const KINDS: EntityKind[] = ["person", "object", "place", "ui_element", "logo", "text", "other"];

function coerceKind(v: unknown): EntityKind {
  return typeof v === "string" && (KINDS as string[]).includes(v) ? (v as EntityKind) : "other";
}

const FINDING_KINDS: FindingKind[] = ["defect", "beat", "quote", "claim", "topic", "timestamp", "other"];

function coerceFindingKind(v: unknown): FindingKind {
  return typeof v === "string" && (FINDING_KINDS as string[]).includes(v) ? (v as FindingKind) : "other";
}

interface EntityBlock {
  scenes: Array<{ start_sec: number; end_sec: number; setting: string; activity: string; on_screen_text: string[] }>;
  observed: Array<{ descriptor: string; same_as: string | null; at_sec: number | null }>;
  fresh: Array<{ id: string | null; kind: EntityKind; label: string | null; descriptor: string; at_sec: number | null }>;
  highlights: Array<{ at_sec: number | null; kind: FindingKind; text: string }>;
  note: string | null;
}

/** Split the model's answer into prose + the machine block. */
function parseEntityBlock(raw: string): { analysis: string; block: EntityBlock | null; error: string | null } {
  const openAt = raw.lastIndexOf(ENTITY_BLOCK_OPEN);
  if (openAt === -1) return { analysis: raw.trim(), block: null, error: "no entity block" };

  const analysis = raw.slice(0, openAt).trim();
  let body = raw.slice(openAt + ENTITY_BLOCK_OPEN.length);
  const closeAt = body.indexOf(ENTITY_BLOCK_CLOSE);
  if (closeAt !== -1) body = body.slice(0, closeAt);
  body = body.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    const parsed = JSON.parse(body) as Record<string, any>;
    const scenes = Array.isArray(parsed.scenes)
      ? parsed.scenes
          .map((s: any) => ({
            start_sec: parseTime(s?.start) ?? 0,
            end_sec: parseTime(s?.end) ?? 0,
            setting: typeof s?.setting === "string" ? s.setting : "",
            activity: typeof s?.activity === "string" ? s.activity : "",
            on_screen_text: Array.isArray(s?.on_screen_text)
              ? s.on_screen_text.filter((t: any) => typeof t === "string")
              : [],
          }))
          .filter((s: any) => s.end_sec > s.start_sec)
      : [];

    const observed = Array.isArray(parsed.observed)
      ? parsed.observed
          .map((o: any) => ({
            descriptor: typeof o?.descriptor === "string" ? o.descriptor : "",
            same_as: typeof o?.same_as === "string" && o.same_as.trim() ? o.same_as.trim() : null,
            at_sec: parseTime(o?.at),
          }))
          .filter((o: any) => o.descriptor)
      : [];

    const fresh = Array.isArray(parsed.new)
      ? parsed.new
          .map((n: any) => ({
            id: typeof n?.id === "string" && n.id.trim() ? n.id.trim() : null,
            kind: coerceKind(n?.kind),
            label: typeof n?.label === "string" && n.label.trim() ? n.label.trim() : null,
            descriptor: typeof n?.descriptor === "string" ? n.descriptor : "",
            at_sec: parseTime(n?.at),
          }))
          .filter((n: any) => n.descriptor)
      : [];

    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights
          .map((h: any) => ({
            at_sec: parseTime(h?.at ?? h?.start),
            kind: coerceFindingKind(h?.kind),
            text: typeof h?.text === "string" ? h.text.trim() : "",
          }))
          .filter((h: any) => h.text)
          .slice(0, 20)
      : [];

    return {
      analysis,
      block: {
        scenes,
        observed,
        fresh,
        highlights,
        note: typeof parsed.registry_note === "string" ? parsed.registry_note : null,
      },
      error: null,
    };
  } catch (e) {
    return { analysis, block: null, error: `entity block not JSON: ${(e as Error).message.slice(0, 160)}` };
  }
}

/** Absolute-ise a scene's times: models sometimes report clip-relative ones. */
function absolutize(value: number, chunkStart: number, chunkEnd: number): number {
  if (chunkStart <= 0) return clamp(value, 0, chunkEnd);
  return clamp(value < chunkStart - 0.5 ? value + chunkStart : value, chunkStart, chunkEnd);
}

const DESCRIPTOR_STOPWORDS = new Set([
  "man", "woman", "person", "people", "guy", "lady", "young", "older", "adult",
  "wearing", "wear", "wears", "with", "without", "and", "the", "a", "an", "of", "in", "on", "at",
  "his", "her", "their", "he", "she", "they", "it", "is", "are", "was", "were",
  "holding", "standing", "sitting", "appears", "appearing", "seen", "shown", "visible",
  "inside", "outside", "frame", "shot", "scene", "background", "foreground", "closeup", "close",
  "speaks", "speaking", "talks", "talking", "gestures", "gesturing", "looking", "faces", "facing",
  "very", "some", "same", "other", "another", "also", "then", "from", "to", "into", "over",
  "white", "black", "grey", "gray", "blue", "green", "red", "yellow", "olive", "beige",
]);

/** Colour words are compared separately: two different colours usually mean two people. */
const COLOR_TOKENS = ["white", "black", "grey", "gray", "blue", "green", "red", "yellow", "olive", "beige", "pink", "purple", "brown", "navy", "maroon", "orange"];

function descriptorTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !DESCRIPTOR_STOPWORDS.has(t));
}

function descriptorTokensAll(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function colorsOf(s: string): Set<string> {
  const set = new Set<string>();
  for (const t of descriptorTokensAll(s)) if (COLOR_TOKENS.includes(t)) set.add(t === "gray" ? "grey" : t);
  return set;
}

/**
 * Distinctive overlap only: generic words and colours are excluded, and two
 * descriptors that name different colours are treated as different subjects.
 */
function overlapScore(a: string, b: string): number {
  const ta = new Set(descriptorTokens(a));
  const tb = new Set(descriptorTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const score = hit / Math.min(ta.size, tb.size);

  const ca = colorsOf(a);
  const cb = colorsOf(b);
  if (ca.size > 0 && cb.size > 0) {
    let shared = 0;
    for (const c of ca) if (cb.has(c)) shared++;
    if (shared === 0) return 0; // blue shirt vs olive shirt is not the same person
  }
  // One distinctive hit is too easy (e.g. both "beard"); require two when possible.
  if (hit < 2 && Math.min(ta.size, tb.size) > 2) return 0;
  return score;
}

function nextEntityId(entities: Entity[], kind: EntityKind): string {
  const prefix = KIND_PREFIX[kind];
  let n = 1;
  while (entities.some((e) => e.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Conservative fuzzy match: only when descriptors genuinely agree and labels do not conflict. */
function findMatch(entities: Entity[], descriptor: string, label: string | null): Entity | undefined {
  const lower = label?.toLowerCase() ?? null;
  let best: { e: Entity; score: number } | undefined;
  for (const e of entities) {
    if (lower && e.label && e.label.toLowerCase() !== lower) continue;
    const score = overlapScore(e.descriptors.join(" "), descriptor);
    if (!best || score > best.score) best = { e, score };
  }
  return best && best.score >= 0.7 ? best.e : undefined;
}

function addDescriptor(entity: Entity, descriptor: string): void {
  const d = descriptor.trim();
  if (!d) return;
  const tokens = descriptorTokens(d).join(" ");
  if (!tokens) return;
  if (entity.descriptors.some((x) => descriptorTokens(x).join(" ") === tokens)) return;
  entity.descriptors.push(d.slice(0, 160));
}

const VALID_ID_RE = /^(p|o|l|u|g|t|e)\d+$/;

function mergeEntityBlock(
  entities: Entity[],
  block: EntityBlock,
  chunk: { index: number; start: number; end: number },
): { added: string[]; matched: string[]; unmatched: number; skipped: number; scenes: Scene[] } {
  const added: string[] = [];
  const matched: string[] = [];
  let unmatched = 0;
  let skipped = 0;
  let textAdded = 0;
  const MAX_TEXT_ENTITIES_PER_CHUNK = 3;

  /** Cue-accurate window for an appearance: the stated moment, else the whole chunk. */
  const at = (value: number | null): { start_sec: number; end_sec: number } => {
    if (value === null) return { start_sec: chunk.start, end_sec: chunk.end };
    const start = round(absolutize(value, chunk.start, chunk.end), 2);
    return { start_sec: start, end_sec: round(Math.min(start + 4, chunk.end), 2) };
  };

  /** Record an appearance, collapsing repeat mentions of one subject within the same chunk. */
  const pushAppearance = (entity: Entity, span: { start_sec: number; end_sec: number }, cue: string) => {
    const dupe = entity.appearances.some(
      (a) => a.chunk_index === chunk.index && Math.abs(a.start_sec - span.start_sec) < 2,
    );
    if (!dupe) {
      entity.appearances.push({
        chunk_index: chunk.index,
        start_sec: span.start_sec,
        end_sec: span.end_sec,
        cue: cue.slice(0, 120),
      });
    }
    entity.first_seen_sec = Math.min(entity.first_seen_sec, span.start_sec);
    entity.last_seen_sec = Math.max(entity.last_seen_sec, span.end_sec);
  };

  for (const n of block.fresh) {
    const modelId = n.id && VALID_ID_RE.test(n.id) ? n.id : null;
    let entity: Entity | undefined;
    if (modelId) entity = entities.find((e) => e.id === modelId);
    if (!entity) entity = findMatch(entities, n.descriptor, n.label);

    if (entity) {
      addDescriptor(entity, n.descriptor);
      if (!entity.label && n.label) entity.label = n.label;
      pushAppearance(entity, at(n.at_sec), n.descriptor);
      matched.push(entity.id);
      continue;
    }

    // On-screen text is real but noisy: cap new text entities per chunk so a
    // caption sequence does not become eight entities.
    if (n.kind === "text" && textAdded >= MAX_TEXT_ENTITIES_PER_CHUNK) {
      skipped++;
      continue;
    }

    const id = modelId && !entities.some((e) => e.id === modelId) ? modelId : nextEntityId(entities, n.kind);
    const span = at(n.at_sec);
    entities.push({
      id,
      kind: n.kind,
      label: n.label,
      descriptors: [n.descriptor.slice(0, 160)],
      aliases: [],
      appearances: [{ chunk_index: chunk.index, start_sec: span.start_sec, end_sec: span.end_sec, cue: n.descriptor.slice(0, 120) }],
      first_seen_sec: span.start_sec,
      last_seen_sec: span.end_sec,
      confidence: 0.7,
    });
    if (n.kind === "text") textAdded++;
    added.push(id);
  }

  for (const o of block.observed) {
    let entity = o.same_as ? entities.find((e) => e.id === o.same_as) : undefined;
    if (!entity) entity = findMatch(entities, o.descriptor, null);
    if (!entity) {
      unmatched++;
      continue;
    }
    addDescriptor(entity, o.descriptor);
    if (!entity.aliases.includes(o.descriptor)) entity.aliases.push(o.descriptor.slice(0, 120));
    pushAppearance(entity, at(o.at_sec), o.descriptor);
    matched.push(entity.id);
  }

  const scenes: Scene[] = block.scenes.map((s) => {
    const start = round(absolutize(s.start_sec, chunk.start, chunk.end), 2);
    const rawEnd = round(absolutize(s.end_sec, chunk.start, chunk.end), 2);
    // Models occasionally emit an end before the start after absolutising; keep the range monotonic.
    const end = Math.max(rawEnd, round(Math.min(start + 1, chunk.end), 2));
    return {
      chunk_index: chunk.index,
      start_sec: start,
      end_sec: end,
      time_range: rangeLabel(start, end),
      setting: s.setting,
      activity: s.activity,
      on_screen_text: s.on_screen_text.slice(0, 12),
    };
  });

  return { added, matched, unmatched, skipped, scenes };
}

/** Compact registry passed into the next chunk's prompt. */
function registryPrompt(entities: Entity[]): string {
  if (entities.length === 0) {
    return "Known subjects so far: none. If something recurs, give it an id in the machine block.";
  }
  const recent = [...entities]
    .sort((a, b) => b.last_seen_sec - a.last_seen_sec)
    .slice(0, MAX_ENTITIES_IN_PROMPT);
  const lines = recent.map(
    (e) =>
      `- ${e.id} (${e.kind}${e.label ? `, "${e.label}"` : ""}): ${e.descriptors.slice(0, 4).join("; ")} | seen ${formatTime(e.first_seen_sec)}–${formatTime(e.last_seen_sec)}`,
  );
  return `Known subjects so far (authoritative — reuse these ids instead of re-describing them):\n${lines.join("\n")}`;
}

function observationPrompt(o: Observation): string {
  const parts = [
    `Perspective: analyze as ${o.observer}.`,
    o.intent ? `Intent: ${o.intent}` : "",
    o.focus.length ? `Focus on: ${o.focus.join("; ")}` : "",
    o.assumptions.length ? `Assumptions to test (say if contradicted): ${o.assumptions.join("; ")}` : "",
    o.questions.length ? `Questions to answer: ${o.questions.join("; ")}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function entityIndex(entities: Entity[]): Record<string, { kind: EntityKind; label: string | null; appearances: string[] }> {
  const out: Record<string, { kind: EntityKind; label: string | null; appearances: string[] }> = {};
  for (const e of entities) {
    out[e.id] = {
      kind: e.kind,
      label: e.label,
      appearances: e.appearances.map((a) => `${formatTime(a.start_sec)}–${formatTime(a.end_sec)}`),
    };
  }
  return out;
}

function extractPerspective(analysis: string | null): string | null {
  if (!analysis) return null;
  const m = analysis.match(/###\s*Perspective verdict\s*([\s\S]*)$/i);
  return m ? m[1].trim().slice(0, 4000) : null;
}

// ---------------------------------------------------------------- run

interface RunParams {
  videoPath: string;
  prompt: string;
  observation: Observation;
  provider: ProviderConfig;
  transcriber: TranscriberConfig;
  /** Directory for exported audit JSON, or null to keep it in plugin storage only. */
  auditDir: string | null;
  /** Fingerprint of file+config, stored with the job so a resume can be validated. */
  configSha: string;
  /** Prior audit to continue from (finished chunks are reused, not re-analyzed). */
  resume: Audit | null;
  stitch: "model" | "none";
  mode: "foreground" | "background";
  jobId: string | null;
  signal?: AbortSignal;
  opencodeVersion: string | null;
  pluginLocation: string | null;
  toolContext: Audit["input"]["tool_context"];
  onProgress: (ev: ProgressEvent) => void;
  onCheckpoint?: (audit: Audit) => void;
}

/** Fields that exist only for after-the-fact auditing, never for the agent's answer. */
function compactAudit(a: Audit): Record<string, unknown> {
  const findings = a.overall.findings.slice(0, 30);
  const lines = a.overall.transcript?.text ?? "";
  // Ordered by decision weight: verdict → answer → actions → beats → identity →
  // evidence → trust → context → provenance. Consumers that truncate keep the top.
  return {
    status: a.status,
    error: a.error,
    overall: {
      analysis: a.overall.analysis,
      perspective: a.overall.perspective,
      entity_index: a.overall.entity_index,
    },
    findings,
    findings_total: a.overall.findings_count,
    scenes: a.scenes,
    entities: a.entities,
    transcript: a.overall.transcript
      ? {
          text: lines.length > 8000 ? `${lines.slice(0, 8000)}\n…(truncated, read the detailed audit for the rest)` : lines,
          cue_count: a.overall.transcript.cue_count,
          segments_covered: a.overall.transcript.segments_covered,
          timed: a.overall.transcript.timed,
          chars: a.overall.transcript.chars,
          engine: a.overall.transcript.engine,
          model: a.overall.transcript.model,
        }
      : null,
    parsing: {
      strategy: a.parsing.strategy,
      total_chunks: a.parsing.total_chunks,
      chunks_completed: a.parsing.chunks_completed,
      chunks_failed: a.parsing.chunks_failed,
      progress_percent: a.parsing.progress_percent,
      continuity: a.parsing.continuity,
      coverage: a.parsing.coverage,
      failures: a.parsing.failures,
    },
    video: {
      filename: a.video.filename,
      duration_sec: a.video.duration_sec,
      size_mb: a.video.size_mb,
      width: a.video.width,
      height: a.video.height,
      fps: a.video.fps,
      has_audio: a.video.has_audio,
    },
    audit: {
      file: a.audit.file,
      elapsed_ms: a.audit.elapsed_ms,
      started_at: a.audit.started_at,
      finished_at: a.audit.finished_at,
      api: a.audit.api,
      stitch: { used: a.audit.stitch.used, mode: a.audit.stitch.mode, duration_ms: a.audit.stitch.duration_ms },
    },
    detailed_audit: {
      file: a.audit.file,
      key: a.job?.audit_key ?? null,
      hint: "Per-chunk chain, raw word/cue timings, segment analyses and progress log live in the detailed audit (detail:\"full\" or the file).",
    },
    schema_version: a.schema_version,
    plugin: a.plugin,
  };
}

function auditFileName(resolvedPath: string, filename: string): string {
  const hash = createHash("sha1").update(resolvedPath).digest("hex").slice(0, 8);
  const base = (filename || "video").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${base}-${hash}.audit.json`;
}

/**
 * Resume is only valid when the file and the pipeline that produced the finished
 * chunks are identical. Anything else would mix analyses from different settings.
 */
function configFingerprint(parts: {
  path: string;
  size: number;
  mtimeMs: number;
  chunkSec: number;
  overlapSec: number;
  filter: string;
  visionModel: string;
  sttEngine: string;
  sttModel: string;
  prompt: string;
}): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

async function appendRows(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await appendFile(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

/** Timeline sidecar rows for a set of finished segments: scenes first, then findings. */
function timelineRowsFor(audit: Audit, segments: Segment[]): unknown[] {
  const rows: unknown[] = [];
  for (const seg of segments) {
    for (const scene of audit.scenes.filter((s) => s.chunk_index === seg.chunk_index)) {
      rows.push({ type: "scene", ...scene });
    }
    for (const finding of seg.findings ?? []) rows.push({ type: "finding", ...finding });
  }
  return rows;
}

/** Transcript sidecar rows for a set of finished segments: one line per cue. */
function transcriptRowsFor(segments: Segment[]): unknown[] {
  const rows: unknown[] = [];
  for (const seg of segments) {
    for (const cue of seg.transcript?.cues ?? []) {
      rows.push({ type: "cue", chunk: seg.chunk_index, ...cue });
    }
  }
  return rows;
}

function jsonlBlock(rows: unknown[]): string {
  return rows.length > 0 ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
}

async function runAnalysis(p: RunParams): Promise<Audit> {
  const startedAt = Date.now();
  const isUrl = /^https?:\/\//i.test(p.videoPath);
  const progressLog: ProgressEvent[] = [];
  let workDir: string | null = null;

  const audit: Audit = {
    schema_version: SCHEMA_VERSION,
    plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
    status: "failed",
    error: null,
    mode: p.mode,
    job: p.jobId
      ? { id: p.jobId, status: "running", created_at: new Date(startedAt).toISOString(), updated_at: new Date(startedAt).toISOString(), audit_key: `job/${p.jobId}` }
      : null,
    input: {
      prompt: p.prompt,
      model: p.provider.model,
      video_path: p.videoPath,
      resolved_path: isUrl ? null : resolve(cwd(), p.videoPath),
      observation: p.observation,
      transcription: {
        enabled: p.transcriber.enabled,
        engine: p.transcriber.engine,
        id: p.transcriber.id,
        base_url: p.transcriber.base_url,
        model: p.transcriber.model,
        api_key_source: p.transcriber.api_key_source,
        language: p.transcriber.language,
        mode: p.transcriber.mode,
        diarize: p.transcriber.diarize,
        timestamps: p.transcriber.timestamps,
        granularity: p.transcriber.granularity,
      },
      provider: {
        id: p.provider.id,
        base_url: p.provider.base_url,
        model: p.provider.model,
        api_key_source: p.provider.api_key_source,
        header_keys: Object.keys(p.provider.extra_headers),
      },
      options: {
        chunk_sec: CHUNK_SEC,
        overlap_sec: OVERLAP_SEC,
        filter: CHUNK_VF,
        max_attempts: MAX_ATTEMPTS,
        stitch: p.stitch,
      },
      environment: {
        cwd: cwd(),
        platform: process.platform,
        api_key_present: p.provider.api_key.length > 0,
        opencode_version: p.opencodeVersion,
        plugin_location: p.pluginLocation,
      },
      tool_context: p.toolContext,
    },
    video: {
      source: isUrl ? "url" : "local",
      path: p.videoPath,
      filename: isUrl ? "" : (p.videoPath.split(/[\\/]/).pop() ?? ""),
      duration_sec: 0,
      size_mb: 0,
      width: null,
      height: null,
      fps: null,
      has_audio: null,
    },
    parsing: {
      strategy: "single",
      total_chunks: 0,
      chunks_completed: 0,
      chunks_failed: 0,
      progress_percent: 0,
      continuity: "n-1 summary + entity registry",
      coverage: { covered_seconds: 0, coverage_percent: 0, covered_ranges: [], uncovered_ranges: [] },
      failures: [],
    },
    entities: [],
    registry: {
      status: "empty_no_recurring_subjects",
      kinds_considered: KINDS,
      note: null,
      blocks_parsed: 0,
      blocks_failed: 0,
      observations_unmatched: 0,
      entities_skipped: 0,
      transcript_retries: 0,
      entity_repairs: 0,
    },
    scenes: [],
    overall: { analysis: null, perspective: null, transcript: null, findings: [], findings_count: 0, entity_index: {} },
    segments: [],
    chain: [],
    progress_log: progressLog,
    audit: {
      started_at: new Date(startedAt).toISOString(),
      finished_at: "",
      elapsed_ms: 0,
      probe_ms: 0,
      api: { calls: 0, video_calls: 0, text_calls: 0, retries: 0, failures: 0 },
      stitch: { used: false, mode: "fallback-join", model: null, calls: 0, duration_ms: 0, attempts: [], error: null },
      cleanup: { workdir_used: false, workdir_removed: false },
      file: null,
      resume: null,
    },
  };

  const track = (phase: ProgressEvent["phase"], percent: number, status: string) => {
    const ev: ProgressEvent = { at: nowIso(), percent, phase, status };
    progressLog.push(ev);
    p.onProgress(ev);
  };

  // ---- resume: adopt finished chunks, their entities, scenes and report state
  if (p.resume) {
    const r = p.resume;
    audit.entities = Array.isArray(r.entities) ? r.entities : [];
    audit.registry = { ...audit.registry, ...(r.registry ?? {}) };
    audit.scenes = Array.isArray(r.scenes) ? r.scenes : [];
    audit.overall = { ...audit.overall, ...(r.overall ?? {}) };
    audit.audit.api = { ...(r.audit?.api ?? audit.audit.api) };

    // Keep finished chunks only, one record per chunk. Records left behind by the
    // interrupted run are dropped here (not replayed) because the chunk loop
    // re-analyzes every chunk that is not "completed"; keeping them would report a
    // chunk twice and leave a failure that no longer exists. An older audit written
    // by the pre-fix build can itself hold duplicates, so de-dupe by chunk_index.
    const finishedOnly = <T extends { chunk_index: number; status: string }>(rows: T[]): T[] => {
      const byChunk = new Map<number, T>();
      for (const row of rows) {
        if (row.status !== "completed") continue;
        byChunk.set(row.chunk_index, row);
      }
      return [...byChunk.values()].sort((a, b) => a.chunk_index - b.chunk_index);
    };

    const priorSegments = Array.isArray(r.segments) ? r.segments : [];
    const keptSegments = finishedOnly(priorSegments);
    const discardedSegments = priorSegments.length - keptSegments.length;

    audit.segments = keptSegments;
    audit.chain = finishedOnly(Array.isArray(r.chain) ? r.chain : []);
    audit.parsing.chunks_completed = keptSegments.length;
    audit.parsing.chunks_failed = 0;
    audit.parsing.failures = [];
    audit.overall.transcript = null; // rebuilt from reused segments below

    if (keptSegments.length > 0) {
      audit.audit.resume = {
        from_job_id: r.job?.id ?? "unknown",
        chunks_reused: keptSegments.length,
        chunks_discarded: discardedSegments,
        config_sha: p.configSha,
      };
    }
  }

  const finish = async (a: Audit) => {
    if (workDir) {
      const dir = workDir;
      workDir = null;
      a.audit.cleanup.workdir_removed = await rm(dir, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false);
    }

    a.audit.finished_at = nowIso();
    a.audit.elapsed_ms = Date.now() - startedAt;
    a.video.size_mb = round(a.video.size_mb, 2);

    // Counters are derived from the segment records here, never trusted from a
    // checkpoint: a resumed run adopts records written by an earlier job, and the
    // two lists must stay one record per chunk in chunk order.
    a.segments.sort((x, y) => x.chunk_index - y.chunk_index);
    a.chain.sort((x, y) => x.chunk_index - y.chunk_index);
    a.parsing.chunks_completed = a.segments.filter((s) => s.status === "completed").length;
    a.parsing.chunks_failed = a.segments.filter((s) => s.status === "failed").length;

    a.parsing.progress_percent = pct(a.parsing.chunks_completed, a.parsing.total_chunks || 1);
    a.overall.findings_count = a.overall.findings.length;
    a.overall.entity_index = entityIndex(a.entities);

    if (a.entities.length > 0) a.registry.status = "populated";
    else if (a.registry.blocks_parsed === 0) a.registry.status = "extraction_failed";
    else a.registry.status = "empty_no_recurring_subjects";
    if (a.registry.blocks_parsed === 0 && a.registry.blocks_failed > 0) {
      a.registry.note = "Model never returned a parseable entity block; scenes and prose analysis are still valid.";
    }

    if (a.job) {
      a.job.status = a.status;
      a.job.updated_at = a.audit.finished_at;
    }

    // Optional on-disk export so the audit has a real path, not just a storage key.
    if (p.auditDir) {
      try {
        await mkdir(p.auditDir, { recursive: true });
        const target = join(
          p.auditDir,
          auditFileName(a.input.resolved_path ?? a.video.path, a.video.filename),
        );
        a.audit.file = target;
        await writeFile(target, JSON.stringify(a, null, 2), "utf8");
      } catch {
        a.audit.file = null;
      }
    }

    track("done", a.parsing.progress_percent, `${a.status}: ${a.parsing.chunks_completed}/${a.parsing.total_chunks} chunks`);
    return a;
  };

  if (!p.provider.api_key) {
    audit.error = `No API key for provider "${p.provider.id}". Set VIDEO_ANALYSIS_API_KEY or OPENROUTER_API_KEY, or plugin option apiKey.`;
    return finish(audit);
  }

  // ------------------------------------------------------------- URL mode
  if (isUrl) {
    audit.parsing.strategy = "single";
    audit.parsing.total_chunks = 1;
    track("chunk", 0, "analyzing remote video");
    try {
      const res = await callProvider({ provider: p.provider, text: `${observationPrompt(p.observation)}\n\n${p.prompt}`, videoDataUri: p.videoPath, signal: p.signal });
      audit.audit.api.calls += res.calls;
      audit.audit.api.video_calls += 1;
      audit.audit.api.retries += Math.max(0, res.calls - 1);

      const parsed = parseEntityBlock(res.text);
      const scenes = parsed.block?.scenes?.length ?? 0;
      if (parsed.block) audit.registry.blocks_parsed += 1;
      else audit.registry.blocks_failed += 1;

      audit.parsing.chunks_completed = 1;
      audit.overall.analysis = parsed.analysis;
      audit.overall.perspective = extractPerspective(parsed.analysis);
      audit.overall.findings = mergeFindings([
        {
          chunk_index: 1,
          findings: [
            ...(parsed.block?.highlights ?? []).map((h) => ({
              timestamp: h.at_sec !== null ? formatTime(h.at_sec) : null,
              at_sec: h.at_sec,
              kind: h.kind,
              source: "model" as const,
              chunk_index: 1,
              text: h.text.slice(0, 300),
            })),
            ...heuristicFindings(parsed.analysis, 1),
          ],
        },
      ]);
      audit.status = "completed";

      const t = nowIso();
      audit.chain.push({
        chunk_index: 1, time_range: "remote", start_sec: 0, end_sec: 0, offset_sec: 0, status: "completed",
        started_at: t, finished_at: t, duration_ms: res.attempts.reduce((a, x) => a + x.duration_ms, 0),
        ffmpeg: null,
        api: { calls: res.calls, attempts: res.attempts, usage: res.usage, error: null },
        continuity_in: [], summary_out: null, transcription: null, entities_added: [], entities_matched: [], scenes_count: scenes,
        entity_block: { ok: parsed.block !== null, error: parsed.error }, analysis_chars: parsed.analysis.length,
      });
      audit.segments.push({
        chunk_index: 1, time_range: "remote", start_sec: 0, end_sec: 0, offset_sec: 0, status: "completed",
        findings: audit.overall.findings, scenes: [], entities_seen: [], transcript: null, analysis: parsed.analysis, error: null,
      });
      return finish(audit);
    } catch (e) {
      audit.error = (e as Error).message;
      audit.status = "failed";
      audit.parsing.chunks_failed = 1;
      audit.audit.api.failures += 1;
      audit.audit.api.calls += ((e as any).attempts?.length ?? 0);
      audit.segments.push({
        chunk_index: 1, time_range: "remote", start_sec: 0, end_sec: 0, offset_sec: 0,
        status: "failed", findings: [], scenes: [], entities_seen: [], transcript: null, analysis: null,
        error: (e as Error).message.slice(0, 500),
      });
      return finish(audit);
    }
  }

  // ---------------------------------------------------------- local mode
  const fullPath = audit.input.resolved_path!;
  audit.video.filename = fullPath.split(/[\\/]/).pop() ?? "";

  try {
    const info = await stat(fullPath);
    audit.video.size_mb = info.size / (1024 * 1024);

    track("probe", 0, "probing video metadata");
    const probeStart = Date.now();
    const meta = await probeVideo(fullPath);
    audit.audit.probe_ms = Date.now() - probeStart;

    audit.video.duration_sec = round(meta.duration, 3);
    audit.video.width = meta.width;
    audit.video.height = meta.height;
    audit.video.fps = meta.fps;
    audit.video.has_audio = meta.hasAudio;

    const audioAvailable = meta.hasAudio === true;
    if (p.transcriber.enabled && !audioAvailable) {
      // Explicit downgrade, not a failure: silent footage is a legitimate input.
      audit.input.transcription.enabled = false;
      (audit.input.transcription as any).skipped_reason = "source has no audio stream";
    }

    const duration = meta.duration > 0 ? meta.duration : 1;

    const windows: Array<{ start: number; end: number }> = [];
    if (meta.duration <= CHUNK_SEC) {
      windows.push({ start: 0, end: round(Math.min(duration, CHUNK_SEC), 3) });
    } else {
      const step = CHUNK_SEC - OVERLAP_SEC;
      for (let t = 0; t < meta.duration; t += step) {
        const end = Math.min(t + CHUNK_SEC, meta.duration);
        windows.push({ start: round(t, 3), end: round(end, 3) });
        if (end >= meta.duration) break;
      }
    }

    audit.parsing.total_chunks = windows.length;
    audit.parsing.strategy = windows.length === 1 ? "single" : "chunked";
    track("prepare", 0, `planned ${windows.length} chunk(s) over ${formatTime(meta.duration)}`);
    p.onCheckpoint?.(audit);

    // Append-only sidecars: one line per event, so a long run never rewrites them.
    const jsonlBase = p.auditDir
      ? join(p.auditDir, auditFileName(audit.input.resolved_path!, audit.video.filename).replace(/\.audit\.json$/, ""))
      : null;
    const timelineFile = jsonlBase ? `${jsonlBase}.timeline.jsonl` : null;
    const transcriptFile = jsonlBase ? `${jsonlBase}.transcript.jsonl` : null;
    if (jsonlBase && p.auditDir) {
      await mkdir(p.auditDir, { recursive: true });
      const timelineManifest = {
        type: "manifest",
        schema_version: SCHEMA_VERSION,
        plugin: PLUGIN_ID,
        run: p.jobId ?? "foreground",
        video: audit.video.filename,
        started_at: audit.audit.started_at,
      };
      const transcriptManifest = {
        type: "manifest",
        engine: p.transcriber.engine,
        model: p.transcriber.model,
      };
      if (p.resume) {
        // A resumed run rebuilds both sidecars from the chunks it reused — the
        // cancelled run may have left a partial file or only a manifest — then
        // appends each newly analyzed chunk. Rewriting (not appending) at this
        // point is what keeps the sidecars free of duplicates.
        const reused = [...audit.segments].sort((a, b) => a.chunk_index - b.chunk_index);
        await writeFile(
          timelineFile!,
          `${JSON.stringify(timelineManifest)}\n${jsonlBlock(timelineRowsFor(audit, reused))}`,
          "utf8",
        );
        await writeFile(
          transcriptFile!,
          `${JSON.stringify(transcriptManifest)}\n${jsonlBlock(transcriptRowsFor(reused))}`,
          "utf8",
        );
      } else {
        await writeFile(timelineFile!, `${JSON.stringify(timelineManifest)}\n`, "utf8");
        await writeFile(transcriptFile!, `${JSON.stringify(transcriptManifest)}\n`, "utf8");
      }
    }

    const summaries: string[] = [];
    let prevTranscriptTail: string | null = null;

    // Rebuild continuity inputs from reused chunks, so a resumed run keeps the
    // same context a continuous run would have had.
    for (const s of [...audit.segments].sort((a, b) => a.chunk_index - b.chunk_index)) {
      if (s.status !== "completed") continue;
      const one = (s.analysis ?? "").replace(/\s+/g, " ").trim();
      summaries.push(`- ${s.time_range}: ${one.length > 300 ? one.slice(0, 300) + "…" : one}`);
      if (s.transcript?.text) prevTranscriptTail = s.transcript.text.slice(-220);
    }

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const idx = i + 1;
      const label = rangeLabel(w.start, w.end);
      const segStart = nowIso();
      const t0 = Date.now();

      track("chunk", pct(i, windows.length), `chunk ${idx}/${windows.length} (${label}) starting`);

      // Resume: this chunk is already finished in the adopted audit.
      if (audit.segments.some((s) => s.chunk_index === idx && s.status === "completed")) {
        track("chunk", pct(idx, windows.length), `chunk ${idx}/${windows.length} reused from resume`);
        continue;
      }

      const chain: SegmentChain = {
        chunk_index: idx, time_range: label, start_sec: w.start, end_sec: w.end, offset_sec: w.start,
        status: "failed", started_at: segStart, finished_at: "", duration_ms: 0,
        ffmpeg: null,
        api: { calls: 0, attempts: [], usage: null, error: null },
        continuity_in: [...summaries],
        summary_out: null,
        transcription: null,
        entities_added: [],
        entities_matched: [],
        scenes_count: 0,
        entity_block: { ok: false, error: null },
        analysis_chars: 0,
      };

      let analysis: string | null = null;

      try {
        let dataUri: string;
        if (windows.length === 1) {
          const buf = await readFile(fullPath);
          const ext = extname(fullPath).slice(1).toLowerCase() || "mp4";
          const mime = ext === "mov" ? "video/quicktime" : `video/${ext}`;
          dataUri = `data:${mime};base64,${buf.toString("base64")}`;
        } else {
          workDir ??= await mkdtemp(join(tmpdir(), "va2_"));
          audit.audit.cleanup.workdir_used = true;
          const outFile = join(workDir, `chunk_${idx}.mp4`);
          const ffStart = Date.now();
          try {
            await execFileAsync(
              "ffmpeg",
              ["-y", "-ss", String(w.start), "-t", String(round(w.end - w.start, 3)), "-i", fullPath, "-vf", CHUNK_VF, "-c:v", "libx264", "-crf", "28", "-an", outFile],
              { signal: p.signal },
            );
            chain.ffmpeg = { ok: true, duration_ms: Date.now() - ffStart, filter: CHUNK_VF, input: fullPath, output: outFile, error: null };
          } catch (e) {
            chain.ffmpeg = { ok: false, duration_ms: Date.now() - ffStart, filter: CHUNK_VF, input: fullPath, output: outFile, error: (e as Error).message.slice(0, 400) };
            throw new Error(`ffmpeg failed for ${label}: ${chain.ffmpeg.error}`);
          }
          const buf = await readFile(outFile);
          dataUri = `data:video/mp4;base64,${buf.toString("base64")}`;
        }

        // ---- audio pass (best effort; video analysis never depends on it) ----
        let transcriptText: string | null = null;
        let transcriptRecord: TranscriptionRecord | null = null;
        let transcriptCues: TranscriptCue[] = [];
        let transcriptWordCount = 0;
        let transcriptWordsTruncated = false;
        let transcriptCueSource = "text";

        if (p.transcriber.enabled && audioAvailable) {
          const tStart = Date.now();
          let audio: AudioExtraction | null = null;
          try {
            workDir ??= await mkdtemp(join(tmpdir(), "va2_"));
            audit.audit.cleanup.workdir_used = true;
            const ex = await extractAudioWindow({
              input: fullPath,
              outDir: workDir,
              index: idx,
              start: w.start,
              duration: round(w.end - w.start, 3),
              signal: p.signal,
            });
            audio = { ok: true, duration_ms: ex.duration_ms, file: ex.file, error: null };

            const tr = await transcribeWindow({
              cfg: p.transcriber,
              audioFile: ex.file,
              startSec: w.start,
              endSec: w.end,
              prompt: p.prompt,
              signal: p.signal,
            });

            // Short transcript for a long window smells like an early stop, which is
            // what a forced language can cause. One retry with language left to auto.
            let finalTr = tr;
            const spanSec = Math.max(1, w.end - w.start);
            const expectedChars = Math.max(40, spanSec * 4);
            if (tr.text.length < expectedChars && p.transcriber.language) {
              audit.registry.transcript_retries += 1;
              const retry = await transcribeWindow({
                cfg: { ...p.transcriber, language: null },
                audioFile: ex.file,
                startSec: w.start,
                endSec: w.end,
                prompt: p.prompt,
                signal: p.signal,
              });
              const retryRecord = retry.attempts.map((a) => ({ ...a, attempt: a.attempt + tr.calls }));
              if (retry.text.length > tr.text.length) {
                finalTr = { ...retry, calls: retry.calls + tr.calls, attempts: [...tr.attempts, ...retryRecord] };
              } else {
                finalTr = { ...tr, calls: tr.calls + retry.calls, attempts: [...tr.attempts, ...retryRecord] };
              }
            }

            transcriptCues = finalTr.cues;
            transcriptWordCount = finalTr.word_count;
            transcriptWordsTruncated = finalTr.words_truncated;
            transcriptCueSource = finalTr.cue_source;
            if (finalTr.text) transcriptText = finalTr.text;
            transcriptRecord = {
              ok: Boolean(finalTr.text),
              engine: finalTr.engine,
              model: finalTr.model,
              request_shape: finalTr.request_shape,
              chars: finalTr.text.length,
              duration_ms: Date.now() - tStart,
              calls: finalTr.calls,
              attempts: finalTr.attempts,
              usage: finalTr.usage,
              error: finalTr.error,
              audio,
            };
          } catch (e) {
            transcriptRecord = {
              ok: false,
              engine: p.transcriber.engine,
              model: p.transcriber.model,
              request_shape: null,
              chars: 0,
              duration_ms: Date.now() - tStart,
              calls: 0,
              attempts: [],
              usage: null,
              error: (e as Error).message.slice(0, 300),
              audio,
            };
          }
        }

        const continuity = summaries.length > 0 ? `Continuity from earlier segments:\n${summaries.join("\n")}\n\n` : "";
        const audioBlock = transcriptBlock(transcriptText, prevTranscriptTail);
        const instruction =
          `${observationPrompt(p.observation)}\n\n` +
          `You are analyzing segment ${idx}/${windows.length} of ONE continuous video. ` +
          `This segment covers absolute ${label} of the full video and starts at +${w.start}s; ` +
          `report every timestamp as an absolute position in the full video.\n\n` +
          audioBlock +
          continuity +
          registryPrompt(audit.entities) +
          `\n\nRules: reuse the ids above for any subject you see again (say same_as) instead of treating them as new. ` +
          `Only mint a new id for a subject that has not appeared before. ` +
          `Cover people, objects, places, UI elements, logos and on-screen text that recur or matter.\n\n` +
          `After your analysis, append exactly this machine block (valid JSON, no prose inside). ` +
          `Give every subject an "at" timestamp (absolute, mm:ss) for the moment you see them. ` +
          `Put into "highlights" only what the user's request actually asks for: if they ask for defects, ` +
          `tag kind "defect" and include only real defects; if they ask for key beats use "beat"; ` +
          `verbatim lines use "quote"; unsupported assertions use "claim"; anything else "topic" or "other". ` +
          `Do not invent defects when none were requested or none exist.\n` +
          `${ENTITY_BLOCK_OPEN}\n` +
          `{"scenes":[{"start":"mm:ss","end":"mm:ss","setting":"...","activity":"...","on_screen_text":["..."]}],` +
          `"observed":[{"descriptor":"...","same_as":"p2","at":"mm:ss"}],` +
          `"new":[{"id":null,"kind":"person|object|place|ui_element|logo|text|other","label":null,"descriptor":"...","at":"mm:ss"}],` +
          `"highlights":[{"at":"mm:ss","kind":"defect|beat|quote|claim|topic|other","text":"..."}],` +
          `"registry_note":null}\n` +
          `${ENTITY_BLOCK_CLOSE}\n\n` +
          `Finish with a short section titled "### Perspective verdict" written for ${p.observation.observer}.\n\n` +
          `User request: ${p.prompt}`;

        const res = await callProvider({ provider: p.provider, text: instruction, videoDataUri: dataUri, signal: p.signal });
        audit.audit.api.calls += res.calls;
        audit.audit.api.video_calls += 1;
        audit.audit.api.retries += Math.max(0, res.calls - 1);
        chain.api = { calls: res.calls, attempts: res.attempts, usage: res.usage, error: null };
        chain.transcription = transcriptRecord;
        if (transcriptText) prevTranscriptTail = transcriptText.slice(-220);

        const parsed = parseEntityBlock(res.text);
        analysis = parsed.analysis;
        chain.entity_block = { ok: parsed.block !== null, error: parsed.error };

        // The machine block is easy for the model to drop when it runs long.
        // Repair it from the prose with one text-only call instead of re-watching.
        let block = parsed.block;
        if (!block && analysis) {
          try {
            const repair = await callProvider({
              provider: p.provider,
              text:
                `Return ONLY the machine block for the analysis below — no prose, no code fence.\n\n` +
                `{"scenes":[{"start":"mm:ss","end":"mm:ss","setting":"...","activity":"...","on_screen_text":["..."]}],` +
                `"observed":[{"descriptor":"...","same_as":"p1","at":"mm:ss"}],` +
                `"new":[{"id":null,"kind":"person|object|place|ui_element|logo|text|other","label":null,"descriptor":"...","at":"mm:ss"}],` +
                `"highlights":[{"at":"mm:ss","kind":"defect|beat|quote|claim|topic|other","text":"..."}],` +
                `"registry_note":null}\n\n` +
                `Known ids you must reuse: ${audit.entities.map((e) => e.id).join(", ") || "none"}.\n\n` +
                `Analysis:\n${analysis.slice(0, 5000)}`,
              videoDataUri: null,
              signal: p.signal,
            });
            audit.audit.api.calls += repair.calls;
            audit.audit.api.text_calls += 1;
            audit.audit.api.retries += Math.max(0, repair.calls - 1);

            const repaired = parseEntityBlock(`${ENTITY_BLOCK_OPEN}\n${repair.text}\n${ENTITY_BLOCK_CLOSE}`);
            if (repaired.block) {
              block = repaired.block;
              chain.entity_block = { ok: true, error: null, repaired: true };
              audit.registry.entity_repairs += 1;
            }
          } catch (e) {
            chain.entity_block.error = `${parsed.error ?? "missing block"}; repair failed: ${(e as Error).message.slice(0, 120)}`;
          }
        }

        if (block) {
          audit.registry.blocks_parsed += 1;
          const merged = mergeEntityBlock(audit.entities, block, { index: idx, start: w.start, end: w.end });
          chain.entities_added = merged.added;
          chain.entities_matched = merged.matched;
          chain.scenes_count = merged.scenes.length;
          audit.registry.observations_unmatched += merged.unmatched;
          audit.registry.entities_skipped += merged.skipped;
          audit.scenes.push(...merged.scenes);
          if (block.note) audit.registry.note = block.note;
        } else {
          audit.registry.blocks_failed += 1;
        }

        const oneline = (analysis ?? "").replace(/\s+/g, " ").trim();
        const summary = `- ${label}: ${oneline.length > 300 ? oneline.slice(0, 300) + "…" : oneline}`;
        summaries.push(summary);
        chain.summary_out = summary;
        chain.status = "completed";
        chain.analysis_chars = (analysis ?? "").length;
        audit.parsing.chunks_completed += 1;

        const modelHighlights: Finding[] = (block?.highlights ?? []).map((h) => ({
          timestamp: h.at_sec !== null ? formatTime(h.at_sec) : null,
          at_sec: h.at_sec,
          kind: h.kind,
          source: "model",
          chunk_index: idx,
          text: h.text.slice(0, 300),
        }));

        audit.segments.push({
          chunk_index: idx, time_range: label, start_sec: w.start, end_sec: w.end, offset_sec: w.start,
          status: "completed",
          findings: mergeFindings([
            { chunk_index: idx, findings: [...modelHighlights, ...heuristicFindings(analysis, idx)] },
          ]),
          scenes: audit.scenes.filter((s) => s.chunk_index === idx),
          entities_seen: [...new Set([...chain.entities_added, ...chain.entities_matched])],
          transcript: transcriptText
            ? {
                text: transcriptText,
                engine: p.transcriber.engine,
                model: p.transcriber.model,
                chars: transcriptText.length,
                cues: transcriptCues,
                cue_count: transcriptCues.length,
                word_count: transcriptWordCount,
                words_truncated: transcriptWordsTruncated,
                cue_source: transcriptCueSource,
                timed: transcriptCues.length > 0,
              }
            : null,
          analysis,
          error: null,
        });
      } catch (e) {
        const err = e as Error & { attempts?: ApiAttempt[] };
        chain.api.error = err.message.slice(0, 500);
        if (err.attempts) {
          chain.api.attempts = err.attempts;
          chain.api.calls = err.attempts.length;
          audit.audit.api.calls += err.attempts.length;
          audit.audit.api.retries += Math.max(0, err.attempts.length - 1);
        }
        audit.parsing.chunks_failed += 1;
        audit.audit.api.failures += 1;

        audit.parsing.failures.push({
          chunk_index: idx,
          time_range: label,
          start_sec: w.start,
          end_sec: w.end,
          occurred_at: nowIso(),
          error: err.message.slice(0, 500),
          attempts: chain.api.calls,
          recoverable: /429|5\d\d|timeout|ETIMEDOUT|ECONNRESET|socket|abort/i.test(err.message),
          suggestion: /429/i.test(err.message)
            ? `Rate limited by provider "${p.provider.id}" — retry this range later or use a higher-limit key.`
            : /ffmpeg/i.test(err.message)
              ? "ffmpeg could not cut this window — verify the file is readable and timestamps are valid."
              : /413/i.test(err.message)
                ? "Payload too large for the provider — reduce CHUNK_SEC in the plugin."
                : /cancel|abort/i.test(err.message)
                  ? "Run was cancelled; re-run this range if you still need it."
                  : "Re-run analyze_video for this range; the rest of the video is unaffected.",
        });

        summaries.push(`- ${label}: NOT ANALYZED (${err.message.slice(0, 120)})`);

        audit.segments.push({
          chunk_index: idx, time_range: label, start_sec: w.start, end_sec: w.end, offset_sec: w.start,
          status: "failed", findings: [], scenes: [], entities_seen: [], transcript: null, analysis: null, error: err.message.slice(0, 500),
        });
      } finally {
        chain.finished_at = nowIso();
        chain.duration_ms = Date.now() - t0;
        audit.chain.push(chain);
        track("chunk", pct(idx, windows.length), `chunk ${idx}/${windows.length} ${chain.status} in ${chain.duration_ms}ms`);

        if (timelineFile && chain.status === "completed") {
          const seg = [...audit.segments].reverse().find((s) => s.chunk_index === idx);
          if (seg) {
            await appendRows(timelineFile, timelineRowsFor(audit, [seg]));
            if (transcriptFile) await appendRows(transcriptFile, transcriptRowsFor([seg]));
          }
        }

        p.onCheckpoint?.(audit);
      }
    }

    audit.parsing.coverage = computeCoverage(
      meta.duration,
      audit.segments.filter((s) => s.status === "completed").map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec })),
    );

    const completed = audit.segments.filter((s) => s.status === "completed");
    if (completed.length === 0) {
      audit.status = "failed";
      audit.error = "No segment could be analyzed";
      return finish(audit);
    }

    const joined = completed
      .map((s) => {
        const ents = s.entities_seen.length ? `\n[entities: ${s.entities_seen.join(", ")}]` : "";
        return `### Segment ${s.chunk_index} (${s.time_range})${ents}\n${s.analysis}`;
      })
      .join("\n\n");

    // Transcripts are the audio ground truth; pass a bounded digest so quotes and names stay honest.
    const timedLines = completed.flatMap((s) =>
      (s.transcript?.cues ?? []).map((c) => `${formatTimePrecise(c.start_sec)}  ${c.text}`),
    );
    const audioDigest = transcriptDigest(
      completed.map((s) => ({
        label: `${s.time_range} (chunk ${s.chunk_index})`,
        text: (s.transcript?.cues?.length ? s.transcript.cues.map((x) => `${formatTime(x.start_sec)} ${x.text}`).join("\n") : s.transcript?.text) ?? "",
      })),
    );
    const audioDigestBlock = audioDigest
      ? `Audio transcripts (verbatim, absolute timecodes; prefer these for names, numbers and quotes):\n${audioDigest}\n\n`
      : "";

    const transcriptParts = completed
      .filter((s) => s.transcript?.text)
      .map((s) => `### ${s.time_range}\n${s.transcript!.text}`);

    audit.overall.transcript = transcriptParts.length
      ? {
          text: timedLines.length ? timedLines.join("\n") : transcriptParts.join("\n\n"),
          chars: (timedLines.length ? timedLines.join("\n") : transcriptParts.join("\n\n")).length,
          segments_covered: transcriptParts.length,
          engine: p.transcriber.engine,
          model: p.transcriber.model,
          timed: timedLines.length > 0,
          cue_count: timedLines.length,
        }
      : null;

    if (completed.length === 1) {
      audit.overall.analysis = completed[0].analysis;
      audit.overall.findings = completed[0].findings;
      audit.audit.stitch.mode = "fallback-join";
    } else if (p.stitch === "none") {
      audit.overall.analysis = joined;
      audit.audit.stitch.mode = "fallback-join";
      track("stitch", pct(windows.length, windows.length), "stitch skipped (mode=none), joined per-chunk analyses");
    } else {
      track("stitch", pct(windows.length, windows.length), "stitching segments");
      const gapClause =
        audit.parsing.failures.length > 0
          ? `If a range is marked NOT ANALYZED, say so instead of guessing. `
          : "";

      const stitchInstruction =
        `${observationPrompt(p.observation)}\n\n` +
        `Combine these chronological segment analyses of ONE video into a single cohesive, deduplicated report ` +
        `answering the user's request. Keep the exact absolute timestamps from the full video. Merge anything that ` +
        `spans segments, keep entity ids consistent (a subject that appears twice must not read as two people), ` +
        `and drop repetition. ${gapClause}` +
        `Do not claim any range is missing unless the input says so.\n\n` +
        `${registryPrompt(audit.entities)}\n\n` +
        `Finish the report with a section titled "### Perspective verdict" written for ${p.observation.observer}.\n\n` +
        audioDigestBlock +
        `User request: ${p.prompt}\n\n${joined}`;

      const stitchStart = Date.now();
      audit.audit.stitch.used = true;
      audit.audit.stitch.model = p.provider.model;
      try {
        const res = await callProvider({ provider: p.provider, text: stitchInstruction, videoDataUri: null, signal: p.signal });
        audit.audit.api.calls += res.calls;
        audit.audit.api.text_calls += 1;
        audit.audit.api.retries += Math.max(0, res.calls - 1);
        audit.audit.stitch.calls = res.calls;
        audit.audit.stitch.attempts = res.attempts;
        audit.audit.stitch.mode = "video-model";
        audit.overall.analysis = res.text;
      } catch (e) {
        const err = e as Error & { attempts?: ApiAttempt[] };
        audit.audit.stitch.error = err.message.slice(0, 500);
        audit.audit.stitch.attempts = err.attempts ?? [];
        audit.audit.stitch.calls = err.attempts?.length ?? 0;
        audit.audit.api.calls += err.attempts?.length ?? 0;
        audit.audit.api.failures += 1;
        audit.overall.analysis = joined;
        audit.audit.stitch.mode = "fallback-join";
      } finally {
        audit.audit.stitch.duration_ms = Date.now() - stitchStart;
      }
    }

    audit.overall.perspective = extractPerspective(audit.overall.analysis);

    const merged = mergeFindings(completed.map((s) => ({ chunk_index: s.chunk_index, findings: s.findings })));
    audit.overall.findings =
      merged.length > 0 ? merged : heuristicFindings(audit.overall.analysis);

    audit.status = audit.parsing.chunks_failed > 0 ? "completed_with_errors" : "completed";
    if (audit.parsing.chunks_failed > 0) {
      audit.error = `${audit.parsing.chunks_failed} of ${windows.length} chunk(s) failed; gaps are listed in parsing.coverage.uncovered_ranges`;
    }
    return finish(audit);
  } catch (e) {
    audit.status = (e as Error).name === "AbortError" ? "cancelled" : "failed";
    audit.error = (e as Error).message;
    return finish(audit);
  }
}

// ---------------------------------------------------------------- plugin

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const opencodeVersion: string | null = (ctx as any)?.app?.version ?? null;
    const pluginLocation: string | null = (ctx as any)?.location?.directory ?? null;
    const pluginOptions: Record<string, any> = ((ctx as any)?.options ?? {}) as Record<string, any>;
    const auditDirSetting =
      (typeof pluginOptions.auditDir === "string" && pluginOptions.auditDir) ||
      process.env.VIDEO_ANALYSIS_AUDIT_DIR ||
      null;
    // On-disk export is ON by default so the HTML explorer always has something
    // to open. Opt out with VIDEO_ANALYSIS_AUDIT_FILES=off or plugin option
    // auditFiles:false; an explicit auditDir/audit_dir always wins.
    const auditFilesOff =
      pluginOptions.auditFiles === false ||
      String(process.env.VIDEO_ANALYSIS_AUDIT_FILES ?? "").toLowerCase() === "off";
    const auditDir = auditDirSetting
      ? resolve(cwd(), auditDirSetting)
      : auditFilesOff
        ? null
        : resolve(cwd(), "audit-output");

    /** Live jobs, so polling is cheap and cancellation works. */
    const jobs = new Map<string, { record: JobRecord; controller: AbortController }>();
    /** Single-flight per resolved file path. */
    const inFlight = new Map<string, string>();

    const readJob = async (id: string): Promise<JobRecord | null> => {
      const live = jobs.get(id);
      if (live) return live.record;
      return ((await ctx.storage.get(`job/${id}`).catch(() => undefined)) as JobRecord | undefined) ?? null;
    };

    const writeJob = async (record: JobRecord) => {
      await ctx.storage.set(`job/${record.job_id}`, record).catch(() => {});
    };

    /** Most recent unfinished job for the same file and the same pipeline config. */
    const findResumable = async (resolvedPath: string, configSha: string): Promise<JobRecord | null> => {
      const page = await ctx.storage.scan({ prefix: "job/", limit: 200 }).catch(() => null);
      if (!page) return null;
      const candidates: JobRecord[] = [];
      for (const entry of page.entries) {
        const rec = entry.value as JobRecord | undefined;
        if (!rec?.audit) continue;
        if (rec.resolved_path !== resolvedPath) continue;
        if (rec.config_sha !== configSha) continue;
        if (rec.status === "completed") continue;
        if (!(rec.chunks_completed > 0)) continue;
        candidates.push(rec);
      }
      candidates.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return candidates[0] ?? null;
    };

    const pruneJobs = async () => {
      try {
        const page = await ctx.storage.scan({ prefix: "job/", limit: 200 });
        const cutoff = Date.now() - JOB_TTL_MS;
        for (const entry of page.entries) {
          const rec = entry.value as JobRecord | undefined;
          if (!rec?.updated_at) continue;
          if (rec.status === "running") continue;
          if (new Date(rec.updated_at).getTime() < cutoff) await ctx.storage.remove(entry.key);
        }
      } catch {
        /* prune is opportunistic */
      }
    };

    const makeJobId = () => `va_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const summarizeJob = (rec: JobRecord, include: "summary" | "audit") => {
      const base = {
        job_id: rec.job_id,
        status: rec.status,
        video_path: rec.video_path,
        filename: rec.filename,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        resumed_from: rec.resumed_from,
        progress_percent: rec.progress_percent,
        chunks_completed: rec.chunks_completed,
        total_chunks: rec.total_chunks,
        findings_count: rec.findings_count,
        defects_count: rec.defects_count,
        entities_count: rec.entities_count,
        error: rec.error,
        progress_log: rec.progress_log.slice(-25),
        audit_key: rec.audit_key,
      };
      return include === "audit" ? { ...base, audit: rec.audit ?? null } : base;
    };

    await ctx.tool.transform((editor) => {
      // ------------------------------------------------------------ analyze_video
      editor.add({
        name: "analyze_video",
        description:
          "Analyze a video through a pluggable vision backend (default: NVIDIA Nemotron 3.5 Super VL on OpenRouter). Chunks long videos, analyzes sequentially with n-1 continuity and an entity registry so recurring characters/objects/UI keep one id across scenes, then optionally stitches. Accepts an `observation` (observer, intent, focus, assumptions, questions) so the analysis is written from a chosen perspective. Audio-aware: default transcriber is the dedicated STT service (nemotron-3.5-transcribe, word grain → cues with nested word timings); set transcribe:{engine:'responses'} for the free prompt-driven path. Set `background: true` to return a job id immediately. Unfinished jobs resume: already-analyzed chunks are reused rather than re-run, and the sidecar files are rebuilt so they stay complete. Every run is stored in plugin storage and written to an audit file under ./audit-output by default; read it back in-context with video_analysis_audit (by run id, no file path), or visually with the explorer in explorer/. [schema 1.5]",
        input: {
          type: "object",
          properties: {
            video_path: { type: "string", description: "Path to a local video file, or an https:// video URL." },
            prompt: { type: "string", description: "What to look for or answer about the video." },
            model: { type: "string", description: "Model ID for the configured backend." },
            stitch: {
              type: "string",
              enum: ["model", "none"],
              description: "Combine chunk analyses with the model, or join them deterministically.",
            },
            observation: {
              type: "object",
              description: "Optional perspective: who is looking, why, what matters, priors to test, questions to answer.",
              properties: {
                observer: { type: "string" },
                intent: { type: "string" },
                focus: { type: "array", items: { type: "string" } },
                assumptions: { type: "array", items: { type: "string" } },
                questions: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
            background: {
              type: "boolean",
              description: "Return a job id immediately and keep analyzing; poll with video_analysis_job.",
            },
            audit_dir: {
              type: "string",
              description:
                "Directory to also write the audit JSON to (<dir>/<file>-<hash>.audit.json). Overrides VIDEO_ANALYSIS_AUDIT_DIR / plugin option auditDir.",
            },
            detail: {
              type: "string",
              enum: ["summary", "full"],
              description:
                "What the tool returns. 'summary' (default) = answer-shaped: status, coverage, entities, scenes, findings, analysis, perspective, transcript lines, plus the audit path/key. 'full' = the whole audit including per-chunk chain, raw word/cue timings and segment analyses.",
            },
            transcribe: {
              description:
                "Audio transcription so the analysis hears speech instead of only seeing captions. true/false, or an object: { engine:'responses'|'transcriptions', model, baseUrl, language, diarize, mode:'auto'|'prompt'|'report', apiKey, headers, extraBody }.",
              oneOf: [
                { type: "boolean" },
                {
                  type: "object",
                  properties: {
                    engine: { type: "string", enum: ["responses", "transcriptions"] },
                    model: { type: "string" },
                    baseUrl: { type: "string" },
                    language: { type: "string" },
                    diarize: { type: "boolean" },
                    timestamps: { type: "boolean" },
                    granularity: { type: "string", enum: ["segment", "word", "both"] },
                    mode: { type: "string", enum: ["auto", "prompt", "report"] },
                    apiKey: { type: "string" },
                  },
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ["video_path", "prompt"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const {
            video_path,
            prompt,
            model: modelArg,
            stitch = "model",
            observation: rawObservation,
            background = false,
            audit_dir,
            detail = "summary",
            transcribe,
          } = args as {
            video_path: string;
            prompt: string;
            model?: string;
            stitch?: "model" | "none";
            observation?: unknown;
            background?: boolean;
            audit_dir?: string;
            detail?: "summary" | "full";
            transcribe?: unknown;
          };

          const provider = resolveProvider(modelArg, pluginOptions);
          const transcriber = resolveTranscriber(transcribe, pluginOptions);
          const auditDirForRun = audit_dir ? resolve(cwd(), audit_dir) : auditDir;
          const observation = normalizeObservation(rawObservation, prompt);
          const toolContext: Audit["input"]["tool_context"] = {
            session_id: (context as any)?.sessionID ?? null,
            message_id: (context as any)?.messageID ?? null,
            call_id: (context as any)?.id ?? null,
            agent: (context as any)?.agent ?? null,
          };

          const resolvedPath = /^https?:\/\//i.test(video_path) ? video_path : resolve(cwd(), video_path);

          // Fingerprint the file and pipeline: a resume is only valid for an exact match.
          let fileSize = 0;
          let fileMtime = 0;
          if (!/^https?:\/\//i.test(video_path)) {
            try {
              const st = await stat(resolvedPath);
              fileSize = st.size;
              fileMtime = st.mtimeMs;
            } catch {
              /* probe will fail later with a clearer message */
            }
          }
          const configSha = configFingerprint({
            path: resolvedPath,
            size: fileSize,
            mtimeMs: fileMtime,
            chunkSec: CHUNK_SEC,
            overlapSec: OVERLAP_SEC,
            filter: CHUNK_VF,
            visionModel: provider.model,
            sttEngine: transcriber.engine,
            sttModel: transcriber.model,
            prompt,
          });

          // ---------------- foreground ----------------
          if (!background) {
            const audit = await runAnalysis({
              videoPath: video_path,
              prompt,
              observation,
              provider,
              transcriber,
              auditDir: auditDirForRun,
              configSha,
              resume: null,
              stitch,
              mode: "foreground",
              jobId: null,
              signal: context.signal,
              opencodeVersion,
              pluginLocation,
              toolContext,
              onProgress: (ev) => {
                void context.progress({ status: `${ev.phase}: ${ev.status}`, progress: ev.percent }).catch(() => {});
              },
            });

            const key = `audit/${auditFileName(audit.input.resolved_path ?? audit.video.path, audit.video.filename).replace(/\.audit\.json$/, "")}`;
            await ctx.storage.set("audit/last", audit).catch(() => {});
            await ctx.storage.set(key, audit).catch(() => {});

            return {
              content: JSON.stringify(detail === "full" ? audit : compactAudit(audit), null, 2),
              metadata: {
                status: audit.status,
                detail,
                progress_percent: audit.parsing.progress_percent,
                coverage_percent: audit.parsing.coverage.coverage_percent,
                entities_count: audit.entities.length,
                registry_status: audit.registry.status,
                findings_count: audit.overall.findings_count,
                defects_count: audit.overall.findings.filter((f) => f.kind === "defect").length,
                audit_key: key,
                audit_path: audit.audit.file,
              },
            };
          }

          // ---------------- background ----------------
          const existingId = inFlight.get(resolvedPath);
          if (existingId) {
            const rec = await readJob(existingId);
            if (rec && rec.status === "running") {
              return {
                content: JSON.stringify({ ...summarizeJob(rec, "summary"), deduplicated: true }),
                metadata: { job_id: rec.job_id, status: rec.status, deduplicated: true },
              };
            }
            inFlight.delete(resolvedPath);
          }

          await pruneJobs();

          const resumable = await findResumable(resolvedPath, configSha);
          const resumeAudit = resumable?.audit ?? null;

          const jobId = makeJobId();
          const auditKey = `job/${jobId}`;
          const createdAt = nowIso();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), JOB_MAX_MS);
          (timeout as any)?.unref?.();

          const record: JobRecord = {
            job_id: jobId,
            status: "running",
            audit_key: auditKey,
            video_path,
            resolved_path: resolvedPath,
            filename: resolvedPath.split(/[\\/]/).pop() ?? "",
            config_sha: configSha,
            resumed_from: resumable?.job_id ?? null,
            created_at: createdAt,
            updated_at: createdAt,
            progress_percent: 0,
            progress_log: [],
            chunks_completed: 0,
            total_chunks: 0,
            findings_count: 0,
            defects_count: 0,
            entities_count: 0,
            error: null,
            audit: null,
          };

          jobs.set(jobId, { record, controller });
          inFlight.set(resolvedPath, jobId);
          await writeJob(record);

          const checkpoint = (audit: Audit) => {
            record.updated_at = nowIso();
            record.progress_percent = audit.parsing.progress_percent;
            record.chunks_completed = audit.parsing.chunks_completed;
            record.total_chunks = audit.parsing.total_chunks;
            record.findings_count = audit.overall.findings_count;
            record.defects_count = audit.overall.findings.filter((f) => f.kind === "defect").length;
            record.entities_count = audit.entities.length;
            record.progress_log = audit.progress_log.slice(-40);
            record.audit = audit;
            void writeJob(record);
          };

          void runAnalysis({
            videoPath: video_path,
            prompt,
            observation,
            provider,
            transcriber,
            auditDir: auditDirForRun,
            configSha,
            resume: resumeAudit,
            stitch,
            mode: "background",
            jobId,
            signal: controller.signal,
            opencodeVersion,
            pluginLocation,
            toolContext,
            onProgress: (ev) => {
              record.progress_percent = ev.percent;
              record.progress_log = [...record.progress_log, ev].slice(-40);
              record.updated_at = ev.at;
            },
            onCheckpoint: checkpoint,
          })
            .then(async (audit) => {
              record.status = (audit.status as JobStatus) ?? "failed";
              record.error = audit.error;
              record.audit = audit;
              record.updated_at = nowIso();
              record.progress_percent = audit.parsing.progress_percent;
              record.findings_count = audit.overall.findings_count;
              record.defects_count = audit.overall.findings.filter((f) => f.kind === "defect").length;
              record.entities_count = audit.entities.length;
              await writeJob(record);
              await ctx.storage.set("audit/last", audit).catch(() => {});
              await ctx.storage.set(
                `audit/${auditFileName(audit.input.resolved_path ?? audit.video.path, audit.video.filename).replace(/\.audit\.json$/, "")}`,
                audit,
              ).catch(() => {});
            })
            .catch(async (e) => {
              record.status = "failed";
              record.error = (e as Error).message;
              record.updated_at = nowIso();
              await writeJob(record);
            })
            .finally(() => {
              clearTimeout(timeout);
              inFlight.delete(resolvedPath);
              jobs.delete(jobId);
            });

          return {
            content: JSON.stringify({
              job_id: jobId,
              status: "running",
              started_at: createdAt,
              audit_key: auditKey,
              hint: "Poll with video_analysis_job({ job_id }). include:'audit' returns the full contract when finished.",
            }),
            metadata: { job_id: jobId, status: "running" },
          };
        },
      });

      // ---------------------------------------------------- video_analysis_job
      editor.add({
        name: "video_analysis_job",
        description:
          "Read a background video-analysis job: status, progress, chunk counts, entity count, defects, and optionally the full audit contract once finished.",
        input: {
          type: "object",
          properties: {
            job_id: { type: "string", description: "Job id returned by analyze_video({ background: true })." },
            include: {
              type: "string",
              enum: ["summary", "audit"],
              description: "'summary' (default) for status/progress, 'audit' for the full JSON contract.",
            },
          },
          required: ["job_id"],
          additionalProperties: false,
        },
        async execute(args) {
          const { job_id, include = "summary" } = args as { job_id: string; include?: "summary" | "audit" };
          const rec = await readJob(job_id);
          if (!rec) {
            return {
              content: JSON.stringify({ job_id, status: "unknown", error: "No such job (expired or never existed)." }),
              metadata: { job_id, status: "unknown" },
            };
          }
          return {
            content: JSON.stringify(summarizeJob(rec, include), null, 2),
            metadata: {
              job_id,
              status: rec.status,
              progress_percent: rec.progress_percent,
              chunks_completed: rec.chunks_completed,
              total_chunks: rec.total_chunks,
            },
          };
        },
      });

      // ------------------------------------------------- video_analysis_cancel
      editor.add({
        name: "video_analysis_cancel",
        description: "Cancel a running background video-analysis job.",
        input: {
          type: "object",
          properties: { job_id: { type: "string" } },
          required: ["job_id"],
          additionalProperties: false,
        },
        async execute(args) {
          const { job_id } = args as { job_id: string };
          const live = jobs.get(job_id);
          if (!live) {
            return { content: JSON.stringify({ job_id, cancelled: false, error: "Job is not running." }) };
          }
          live.controller.abort();
          live.record.status = "cancelled";
          live.record.error = "cancelled by caller";
          live.record.updated_at = nowIso();
          await writeJob(live.record);
          return { content: JSON.stringify({ job_id, cancelled: true }) };
        },
      });

      // --------------------------------------------------- video_analysis_audit
      editor.add({
        name: "video_analysis_audit",
        description:
          "Read a finished video-analysis audit inline, with no file path involved. Defaults to the most recent run; pass a job id (va_…) or an audit key to pick another. Start with detail:'index' to see what the run holds, then request only the sections you need: 'transcript' carries cue and word timings, 'findings' the model's timecoded claims, 'chunks' per-chunk provenance, 'failures' the gaps. detail:'full' returns the whole audit, capped — narrow with sections, ref (f12 / p3 / chunk:2) or from_sec/to_sec when it is truncated.",
        input: {
          type: "object",
          properties: {
            run: { type: "string", description: "Job id (va_…) or audit key (audit/…). Omit for the most recent finished run." },
            detail: {
              type: "string",
              enum: ["index", "full"],
              description: "'index' (default) maps what the run contains; 'full' returns the whole audit object.",
            },
            sections: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "overview", "video", "input", "findings", "scenes",
                  "entities", "transcript", "chunks", "failures", "resume",
                ],
              },
              description: "Sections to return. Omitted with detail:'full' means everything; omitted otherwise means overview + findings.",
            },
            ref: { type: "string", description: "One item only: finding id (f7), entity id (p3), or chunk (chunk:2)." },
            from_sec: { type: "number", description: "Window start in seconds; filters scenes, findings and cues that overlap it." },
            to_sec: { type: "number", description: "Window end in seconds." },
            include_words: { type: "boolean", description: "Include word timings inside cues (default false). Cue text and times are always included." },
            max_chars: { type: "integer", description: "Cap for the returned JSON (default 20000; 60000 for detail:'full'; max 200000)." },
          },
          additionalProperties: false,
        },
        async execute(rawArgs) {
          const args = rawArgs as {
            run?: string;
            detail?: "index" | "full";
            sections?: string[];
            ref?: string;
            from_sec?: number;
            to_sec?: number;
            include_words?: boolean;
            max_chars?: number;
          };
          const detail = args.detail ?? "index";
          const maxChars = Math.min(Math.max(args.max_chars ?? (detail === "full" ? 60_000 : 20_000), 2_000), 200_000);

          /** Resolve the audit from storage only: no paths, no file system. */
          const load = async (): Promise<{ audit: Audit | null; source: string; jobId: string | null }> => {
            const run = (args.run ?? "").trim();
            if (run) {
              if (run.startsWith("audit/")) {
                const a = (await ctx.storage.get(run).catch(() => undefined)) as Audit | undefined;
                return a ? { audit: a, source: run, jobId: a.job?.id ?? null } : { audit: null, source: run, jobId: null };
              }
              const rec = await readJob(run);
              if (rec?.audit) return { audit: rec.audit, source: `job/${rec.job_id}`, jobId: rec.job_id };
              const a = (await ctx.storage.get(`audit/${run}`).catch(() => undefined)) as Audit | undefined;
              return a ? { audit: a, source: `audit/${run}`, jobId: a.job?.id ?? null } : { audit: null, source: run, jobId: null };
            }
            const last = (await ctx.storage.get("audit/last").catch(() => undefined)) as Audit | undefined;
            if (last) return { audit: last, source: "audit/last", jobId: last.job?.id ?? null };
            const page = await ctx.storage.scan({ prefix: "job/", limit: 200 }).catch(() => null);
            const recs = ((page?.entries ?? []).map((e) => e.value as JobRecord)).filter((r) => Boolean(r?.audit));
            recs.sort((x, y) => new Date(y.updated_at).getTime() - new Date(x.updated_at).getTime());
            return recs[0]
              ? { audit: recs[0].audit, source: `job/${recs[0].job_id}`, jobId: recs[0].job_id }
              : { audit: null, source: "", jobId: null };
          };

          const { audit, source, jobId } = await load();
          if (!audit) {
            return {
              content: JSON.stringify({
                found: false,
                error: args.run
                  ? `No finished audit for "${args.run}". Job records are pruned after 24 h.`
                  : "No finished audit in storage yet. Run analyze_video first, then call this.",
                hint: "Foreground runs keep the audit at audit/last; background runs keep it in their job record.",
              }, null, 2),
              metadata: { found: false, source, job_id: jobId },
            };
          }

          const index = auditIndex(audit as unknown as Record<string, any>);
          const runMeta = auditRunMeta(audit as unknown as Record<string, any>, source, jobId);

          if (detail === "index" && !args.sections?.length && !args.ref) {
            return {
              content: JSON.stringify({
                run: runMeta,
                index,
                hint: "Call again with sections:[…] and/or from_sec/to_sec. include_words:true adds word timings. detail:'full' returns the whole audit (capped). ref:'f12' | 'p3' | 'chunk:2' pulls one item.",
              }, null, 1),
              metadata: { found: true, source, job_id: jobId, detail: "index" },
            };
          }

          const names = resolveSectionNames(detail, args.sections, Boolean(args.ref));
          const sections = readSections(audit as unknown as Record<string, any>, names, {
            ref: args.ref,
            from_sec: args.from_sec,
            to_sec: args.to_sec,
            include_words: args.include_words,
          });

          let text = JSON.stringify({ run: runMeta, index, sections }, null, 1);
          const auditChars = JSON.stringify(audit).length;
          if (text.length > maxChars) {
            text = JSON.stringify({
              run: runMeta,
              index,
              truncated: true,
              requested_chars: text.length,
              max_chars: maxChars,
              sections_returned: names,
              hint: "Response exceeded max_chars and was withheld. Request fewer sections, add from_sec/to_sec, use ref for one item, or raise max_chars (up to 200000).",
            }, null, 1);
          }

          return {
            content: text,
            metadata: {
              found: true,
              source,
              job_id: jobId,
              sections: names,
              chars: text.length,
              audit_chars: auditChars,
            },
          };
        },
      });

    });
  },
});
