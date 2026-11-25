/**
 * Generates the synthetic schema-1.5 fixture the viewer opens by default.
 *
 *   node explorer/fixtures/make-fixture.mjs
 *
 * Everything here is invented: no real footage, no real person, no real quote.
 * It exists to exercise the shapes the viewer reads — cues with nested word
 * timings, cue_source, at_sec findings, scenes, an entity with appearances,
 * the per-chunk chain — without shipping anyone's footage or transcript.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN = "opencode-video-analysis";
const VERSION = "2.7.0-fixture";

const cueSpec = [
  { start: 2.1, end: 6.4, text: "My name is Sam Rivera and I work in banking.", speaker: "p1" },
  { start: 7.6, end: 12.2, text: "I studied finance at a local university.", speaker: "p1" },
  { start: 14.0, end: 15.2, text: "Since joining the course" },
  { start: 15.35, end: 20.1, text: "I use charts and dashboards every day." },
  { start: 22.4, end: 26.0, text: "The instructors answer questions quickly." },
  { start: 27.2, end: 31.0, text: "That is what made the biggest difference for me." },
];

/** Words as [start_sec, end_sec, text], exactly as schema 1.5 nests them. */
function wordsFor(cue) {
  const pieces = cue.text.split(/\s+/);
  const per = (cue.end - cue.start) / pieces.length;
  const round = (n) => Math.round(n * 1000) / 1000;
  return pieces.map((w, i) => [round(cue.start + i * per), round(cue.start + (i + 1) * per), w]);
}

const cues = cueSpec.map((c) => ({
  start_sec: c.start,
  end_sec: c.end,
  text: c.text,
  speaker: c.speaker ?? null,
  words: wordsFor(c),
}));

const findings = [
  { id: "f1", timestamp: "00:14", at_sec: 14.0, kind: "defect", source: "model", chunk_index: 1,
    text: "Caption cuts mid-sentence at 00:14 (fixture)." },
  { id: "f2", timestamp: "00:22", at_sec: 22.0, kind: "beat", source: "model", chunk_index: 1,
    text: "Instructor section begins (fixture)." },
  { id: "f3", timestamp: "00:27", at_sec: 27.0, kind: "quote", source: "model", chunk_index: 1,
    text: "\"biggest difference for me\" — usable pull-quote (fixture)." },
];

const scenes = [
  { chunk_index: 1, start_sec: 0, end_sec: 12.2, time_range: "00:00 to 00:12", setting: "phone frame", activity: "speaker intro", on_screen_text: ["MY NAME IS SAM RIVERA"] },
  { chunk_index: 1, start_sec: 12.2, end_sec: 21, time_range: "00:12 to 00:21", setting: "phone frame", activity: "tooling story", on_screen_text: [] },
  { chunk_index: 1, start_sec: 21, end_sec: 34, time_range: "00:21 to 00:34", setting: "classroom", activity: "instructor praise", on_screen_text: [] },
];

const audit = {
  schema_version: "1.5",
  plugin: { id: PLUGIN, version: VERSION },
  mode: "foreground",
  job: null,
  status: "completed",
  error: null,
  input: {
    prompt: "SYNTHETIC FIXTURE — schema 1.5 cue/word shape",
    model: "fixture",
    video_path: "fixture.mp4",
    resolved_path: null,
    observation: { observer: "fixture reviewer", intent: null, focus: [], assumptions: [], questions: [], source: "default" },
    transcription: {
      enabled: true, engine: "transcriptions", id: "fixture",
      base_url: "fixture", model: "nvidia/nemotron-3.5-transcribe",
      api_key_source: "fixture", language: "en", mode: "auto",
      diarize: false, timestamps: true, granularity: "word",
    },
    provider: { id: "fixture", base_url: "fixture", model: "fixture", api_key_source: "fixture", header_keys: [] },
    options: { chunk_sec: 60, overlap_sec: 5, filter: "-", max_attempts: 1, stitch: "none" },
    environment: { cwd: "-", platform: "win32", api_key_present: false, opencode_version: null, plugin_location: null },
    tool_context: { session_id: null, message_id: null, call_id: null, agent: null },
  },
  video: { source: "local", path: "fixture.mp4", filename: "fixture.mp4", duration_sec: 34, size_mb: 0.1, width: 1080, height: 1920, fps: 30, has_audio: true },
  parsing: {
    strategy: "single", total_chunks: 1, chunks_completed: 1, chunks_failed: 0,
    progress_percent: 100, continuity: "n-1 summary + entity registry",
    coverage: { covered_seconds: 34, coverage_percent: 100, covered_ranges: [{ from_sec: 0, to_sec: 34, label: "00:00 to 00:34" }], uncovered_ranges: [] },
    failures: [],
  },
  entities: [
    {
      id: "p1", kind: "person", label: "Sam Rivera",
      descriptors: ["person in grey polo", "glasses"],
      aliases: [],
      appearances: [{ chunk_index: 1, start_sec: 2.1, end_sec: 12.2, cue: "intro" }],
      first_seen_sec: 2.1, last_seen_sec: 12.2, confidence: 0.7,
    },
  ],
  registry: {
    status: "populated", kinds_considered: ["person", "object", "place", "ui_element", "logo", "text", "other"],
    note: null, blocks_parsed: 1, blocks_failed: 0, observations_unmatched: 0,
    entities_skipped: 0, transcript_retries: 0, entity_repairs: 0,
  },
  scenes,
  chain: [
    {
      chunk_index: 1, time_range: "00:00 to 00:34", start_sec: 0, end_sec: 34, offset_sec: 0,
      status: "completed", started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:12.000Z",
      duration_ms: 12000, ffmpeg: null,
      api: { calls: 1, attempts: [], usage: null, error: null },
      continuity_in: [], summary_out: null,
      transcription: {
        ok: true, engine: "transcriptions", model: "nvidia/nemotron-3.5-transcribe",
        request_shape: "json:input_audio", chars: 200, duration_ms: 900, calls: 1, attempts: [],
        usage: { seconds: 34, cost: 0.0006 }, error: null,
        audio: { ok: true, duration_ms: 300, file: "fixture.mp3", error: null },
      },
      entities_added: ["p1"], entities_matched: [], scenes_count: 3,
      entity_block: { ok: true, error: null, repaired: false }, analysis_chars: 400,
    },
  ],
  segments: [
    {
      chunk_index: 1, time_range: "00:00 to 00:34", start_sec: 0, end_sec: 34, offset_sec: 0,
      status: "completed",
      findings: findings.map((f) => ({ ...f })),
      scenes: [],
      entities_seen: ["p1"],
      transcript: {
        text: cues.map((c) => c.text).join("\n"),
        chars: 200, engine: "transcriptions", model: "nvidia/nemotron-3.5-transcribe",
        cues, cue_count: cues.length,
        word_count: cues.reduce((n, c) => n + c.words.length, 0),
        words_truncated: false, cue_source: "grouped", timed: true,
      },
      analysis: "SYNTHETIC FIXTURE — cues carry nested word timings.",
      error: null,
    },
  ],
  overall: {
    analysis: "SYNTHETIC FIXTURE — not a real analysis.",
    perspective: "Fixture perspective: verify cue grouping, karaoke and at_sec findings.",
    transcript: {
      text: cues.map((c) => c.text).join("\n"), chars: 200, segments_covered: 1,
      cue_count: cues.length, engine: "transcriptions", model: "nvidia/nemotron-3.5-transcribe", timed: true,
    },
    findings,
    findings_count: findings.length,
    entity_index: { p1: { kind: "person", label: "Sam Rivera", appearances: ["00:02–00:12"] } },
  },
  progress_log: [],
  audit: {
    started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:12.000Z",
    elapsed_ms: 12000, probe_ms: 5,
    api: { calls: 1, video_calls: 1, text_calls: 0, retries: 0, failures: 0 },
    stitch: { used: false, mode: "fallback-join", model: null, calls: 0, duration_ms: 0, attempts: [], error: null },
    cleanup: { workdir_used: false, workdir_removed: false },
    file: null,
    resume: { from_job_id: "va_fixture_previous", chunks_reused: 1, chunks_discarded: 0, config_sha: "fixture0000000000" },
  },
};

const exportedAt = "2026-01-01T00:00:00.000Z";
writeFileSync(
  join(here, "schema15-demo.json"),
  JSON.stringify({ synthetic: true, job: null, export_meta: { exported_at: exportedAt, source: "make-fixture.mjs", audit_schema_version: "1.5" }, audit }, null, 2),
  "utf8",
);

const manifest = { type: "manifest", schema_version: "1.5", plugin: PLUGIN, run: "fixture", video: "fixture.mp4", started_at: exportedAt };
const timeline = [
  manifest,
  ...scenes.map((s) => ({ type: "scene", ...s })),
  ...findings.map((f) => ({ type: "finding", ...f })),
];
const transcript = [
  { type: "manifest", engine: "transcriptions", model: "nvidia/nemotron-3.5-transcribe" },
  ...cues.map((c) => ({ type: "cue", chunk: 1, ...c })),
];

writeFileSync(join(here, "schema15-demo.timeline.jsonl"), timeline.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
writeFileSync(join(here, "schema15-demo.transcript.jsonl"), transcript.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

console.log(`fixture: cues=${cues.length} words=${cues.reduce((n, c) => n + c.words.length, 0)} findings=${findings.length} scenes=${scenes.length}`);
