# opencode-video-analysis

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](./LICENSE)
![Plugin 2.7.0](https://img.shields.io/badge/plugin-2.7.0-informational)
![Schema 1.5](https://img.shields.io/badge/schema-1.5-informational)
![Node 22.6+](https://img.shields.io/badge/node-%3E%3D22.6-informational)

Auditable, perspective-aware video analysis for OpenCode.

It watches a video **and** listens to it: a vision model analyzes overlapping
chunks in order, a speech-to-text service supplies word-level timings, and the
two are assembled into one report. Every claim keeps a timecode, and the full
provenance is written to an audit that can be parsed by a machine.

- plugin version **2.7.0**, schema **1.5**
- provider-agnostic (OpenAI *Responses* shape), STT-provider-agnostic
- `ffmpeg` + `ffprobe` only; no native dependencies
- written and maintained by **Mesum Raza** ([@mesumraza](https://github.com/mesumraza))

> **Licence in one line:** free to use, study, share and improve under
> AGPL-3.0-or-later, provided derivatives stay open and credit the author.
> Closed-source or paid use requires a commercial licence —
> see [COMMERCIAL.md](./COMMERCIAL.md).

Registers three tools:

| Tool | Purpose |
| --- | --- |
| `analyze_video` | Foreground run, or `background: true` to get a job id immediately |
| `video_analysis_job` | Poll a job: status, progress, counts, optionally the full audit |
| `video_analysis_audit` | Read a finished audit **in-context** — by run id, no file path |
| `video_analysis_cancel` | Abort a running background job |

## Requirements

- `ffmpeg` and `ffprobe` on `PATH`
- An API key for the configured vision backend
- An API key for the STT service (defaults to the same OpenRouter key)

## Install

**Option A — install from npm** (once published). Add it to your `opencode.json`:

```jsonc
{
  "plugin": ["opencode-video-analysis"]
}
```

**Option B — clone into the plugin directory** (always available, and what
development uses):

```bash
git clone https://github.com/mesumraza/opencode-video-analysis.git \
  .opencode/plugins/opencode-video-analysis
```

The directory contains:

```
opencode-video-analysis/
  index.ts            # tools: analyze_video, video_analysis_job, video_analysis_cancel
  transcription.ts    # STT resolution, request shapes, words → cues
  explorer/           # single-file HTML audit viewer + synthetic fixture
  scripts/            # serve.mjs, publish and fixture checks
  .github/            # CI, issue forms, PR template
  LICENSE  NOTICE  COMMERCIAL.md  CONTRIBUTING.md  CLA.md
```

OpenCode loads it on start; editing `index.ts` hot-reloads it. To configure it,
add options under `plugin` in `opencode.jsonc`:

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "auditDir": "artifacts/audits",
      "model": "nvidia/nemotron-3.5-super-vl:free"
    }
  }
}
```

## Configuration

Vision backend:

| Variable | Purpose | Default |
| --- | --- | --- |
| `VIDEO_ANALYSIS_API_KEY` | Backend key | falls back to `OPENROUTER_API_KEY` |
| `VIDEO_ANALYSIS_BASE_URL` | Responses endpoint | `https://openrouter.ai/api/v1/responses` |
| `VIDEO_ANALYSIS_MODEL` | Model ID | `nvidia/nemotron-3.5-super-vl:free` |
| `VIDEO_ANALYSIS_PROVIDER` | Audit label | derived from the base URL |
| `VIDEO_ANALYSIS_AUDIT_DIR` | Write audits + sidecars to a directory | `./audit-output` (see below) |
| `VIDEO_ANALYSIS_AUDIT_FILES` | `off` disables the on-disk export entirely | on |

Plugin options (`opencode.jsonc`) win over env: `provider`, `baseUrl`, `apiKey`,
`model`, `headers`, `auditDir`, `transcribe`.

Speech-to-text (tool arg → plugin option → env → default):

| Knob | Env | Plugin option | Tool arg |
| --- | --- | --- | --- |
| on/off | `VIDEO_ANALYSIS_TRANSCRIBE` | `transcribe: true` | `transcribe: false` |
| engine | `VIDEO_ANALYSIS_TRANSCRIBE_ENGINE` | `transcribe.engine` | `transcribe: { engine }` |
| model | `VIDEO_ANALYSIS_TRANSCRIBE_MODEL` | `transcribe.model` | `transcribe: { model }` |
| endpoint | `VIDEO_ANALYSIS_TRANSCRIBE_BASE_URL` | `transcribe.baseUrl` | `transcribe: { baseUrl }` |
| key | `VIDEO_ANALYSIS_TRANSCRIBE_API_KEY` | `transcribe.apiKey` | `transcribe: { apiKey }` |
| language | `VIDEO_ANALYSIS_TRANSCRIBE_LANGUAGE` | `transcribe.language` | `transcribe: { language }` |
| diarize | `VIDEO_ANALYSIS_TRANSCRIBE_DIARIZE=on` | `transcribe.diarize` | `transcribe: { diarize }` |
| timestamps | `VIDEO_ANALYSIS_TRANSCRIBE_TIMESTAMPS=off` | `transcribe.timestamps` | `transcribe: { timestamps }` |
| granularity | `VIDEO_ANALYSIS_TRANSCRIBE_GRANULARITY` | `transcribe.granularity` | `transcribe: { granularity }` |
| usage | `VIDEO_ANALYSIS_TRANSCRIBE_MODE` | `transcribe.mode` | `auto \| prompt \| report` |

## Tool: analyze_video

```ts
analyze_video({
  video_path: "demo.mp4",                 // local path or https:// URL
  prompt: "Who appears and what happens?", // what to look for / how to answer
  model?: "…",
  stitch?: "model" | "none",              // "none" = deterministic join, no extra call
  detail?: "summary" | "full",            // "summary" (default) = brief, "full" = brief + audit
  audit_dir?: "artifacts/audits",         // also write audit + sidecar files here
  observation?: {                         // the perspective this run is written from
    observer: "a casting director building a talent shortlist",
    intent: "know who each person is, even when unnamed",
    focus: ["speaker identity", "wardrobe cues", "returning speakers"],
    assumptions: ["each intro card is a distinct person"],
    questions: ["does anyone appear twice?"]
  },
  transcribe?: false | { engine, model, baseUrl, apiKey, language,
                         diarize, timestamps, granularity, mode },
  background?: true                       // return { job_id } immediately
})
```

## Two outputs from one run

Both surfaces are produced every run; they are not separate modes.

**Brief** (`detail:"summary"`, default) — what an agent reads. Ordered by
importance, no per-word data:

```
status, error,
overall{ analysis, perspective, entity_index },
findings[] (≤30, time-ordered), findings_total,
scenes[], entities[],
transcript{ text, cue_count, segments_covered, timed, chars, engine, model },
parsing{ strategy, total_chunks, chunks_completed, chunks_failed, progress_percent,
         continuity, coverage{…}, failures[] },
video{ filename, duration_sec, size_mb, width, height, fps, has_audio },
audit{ file, elapsed_ms, started_at, finished_at, api{…}, stitch{…} },
detailed_audit{ file, key, hint },
schema_version, plugin{ id, version }
```

**Audit** (`detail:"full"`, or the file) — everything the brief has, plus
`input`, `registry`, `segments[]`, `chain[]`, `progress_log[]`, and the
uncapped findings/transcript. This is the surface with cue and word timings.

| Rule | Value |
| --- | --- |
| Findings in the brief | ≤ 30, time-ordered; `findings_total` holds the true count |
| Transcript text in the brief | ≤ 8 000 chars, `…(truncated…)` suffix |
| Words per chunk in the audit | ≤ 3 000, `words_truncated: true` when clipped |
| Cues, scenes, entities | uncapped |
| Word timings | **audit only**, nested under `cues[]` |
| Phrase container | `cue` is the only one; there is no "sentence" field |

## Reading the audit in context

`video_analysis_audit` returns audit material directly to the model — no path, no
file read, no shell. It resolves the audit from plugin storage: the most recent
run by default, or a specific `run` (job id `va_…` or an `audit/…` key).

```ts
// 1. what does this run contain?
video_analysis_audit({})

// 2. only the transcript, with word timings
video_analysis_audit({ sections: ["transcript"], include_words: true })

// 3. the 2:00–3:00 window, findings and scenes only
video_analysis_audit({ sections: ["findings", "scenes"], from_sec: 120, to_sec: 180 })

// 4. one item
video_analysis_audit({ ref: "f12" })        // finding
video_analysis_audit({ ref: "p3" })         // entity
video_analysis_audit({ ref: "chunk:2" })    // segment + chain provenance

// 5. a specific earlier run
video_analysis_audit({ run: "va_mwv7600d_vszk9v", sections: ["overview"] })
```

`detail:"index"` (default) maps the run: finding counts by kind and source, scene
and entity counts, cues/words per engine, chunk status, failures, resume record
and the audit's byte size. `detail:"full"` returns the whole audit object; if it
exceeds `max_chars` (default 20 000, 60 000 for full, max 200 000) the response is
replaced by the index plus a hint, so you never get a silently truncated JSON
document. Narrow with `sections`, `ref`, or a time window instead.

Word timings are opt-in here too (`include_words:true`), because they roughly
triple the transcript payload. Cue text and times are always included.

## Perspective ("observation")

`observation` is injected into every chunk prompt and the stitch prompt, so the
report is written *for that observer* — focus, priors to test, questions to
answer. The audit echoes it under `input.observation` with
`source: "request" | "default"`, and `overall.perspective` carries the final
`### Perspective verdict` section.

## Entity registry (identity across scenes)

Summaries alone lose identity. Each chunk's single call also returns a machine
block:

```jsonc
---ENTITIES---
{"scenes":[{"start":"mm:ss","end":"mm:ss","setting":"…","activity":"…","on_screen_text":["…"]}],
 "observed":[{"descriptor":"woman, light-blue hijab, glasses","same_as":"p3","at":"01:58"}],
 "new":[{"id":null,"kind":"person|object|place|ui_element|logo|text|other","label":null,"descriptor":"…","at":"02:10"}],
 "registry_note":null}
---END---
```

The plugin owns the registry: it assigns stable ids (`p1`, `u2`, `g1`, …),
merges `same_as` references, appends cue-accurate appearances, and injects a
compact registry into the next chunk so the model reuses ids instead of
re-describing a person. Fuzzy matching is deliberately conservative: stopwords
and colour words are ignored for similarity, and two descriptors that name
different colours are never merged.

`entities[]` is typed, so it works for characterless footage too:
`ui_element` for screen recordings, `object` / `logo` for product footage.
`scenes[]` is always populated — the universal floor — and `registry.status`
distinguishes the cases:

- `populated`
- `empty_no_recurring_subjects` (block parsed, nothing recurred)
- `extraction_failed` (block never parsed; prose + scenes still valid)

Entity names come from the model and are not disambiguated for you: two
spellings of one name can appear as aliases, and a name heard phonetically may
be wrong. Treat `label` as a lead, not a fact.

## Findings are request-driven

The plugin never decides what a "defect" is. Each chunk asks the model to return
`highlights[]` tied to the user's actual request:

```jsonc
"highlights":[{"at":"mm:ss","kind":"defect|beat|quote|claim|topic|timestamp|other","text":"…"}]
```

- `kind:"beat"` for cut sheets, `kind:"defect"` only when the prompt asks for
  defects (and only for real ones), `quote` for verbatim lines, `claim` for
  assertions worth checking.
- Every finding carries `source:"model"`, `chunk_index` and `at_sec`.
- A regex heuristic still recovers *timestamps* from prose as `source:"heuristic"`
  — it never invents a defect, never labels a defect, and never suppresses a
  model finding.
- `overall.findings` therefore reads the same for a testimonial, a cooking video
  or a screen recording; genre is a prompt, not a code path.

## Audio transcription

Two engines behind one config:

| Engine | Endpoint | Model | Notes |
| --- | --- | --- | --- |
| `transcriptions` (**default**) | `/api/v1/audio/transcriptions` | `nvidia/nemotron-3.5-transcribe` | dedicated STT, word timings, diarization, **paid** (~$0.000017/s) |
| `responses` | `/api/v1/responses` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | free, prompt-driven: timed lines only, **no word array** |

The default is the paid endpoint because it is the only path that returns word
timings, and word timings are the default grain. A 4-minute video is ≈260 s of
audio ≈ **$0.004** per run. Pass `transcribe: { engine: "responses" }` to stay
free and accept line-level timings.

### Timestamps

Validated against the live endpoint (10 s probe):

| Request | HTTP | Returns |
| --- | --- | --- |
| `response_format:"verbose_json"` + `timestamp_granularities:["word"]` | 200 | `words[]` with `{word,start,end}` + `segments[]` |
| `response_format:"verbose_json"` + `timestamp_granularities:["segment"]` | 200 | `segments[]` only |
| cost | — | `usage:{seconds,cost}` ≈ **$0.0000167/s** |

`granularity:"word"` (default) groups words into readable cues on pauses
(≥0.6 s), sentence punctuation, or ~110 chars — each cue keeps the exact start
of its first word and end of its last. `granularity:"segment"` takes whatever
span the endpoint returns. `granularity:"both"` sends
`timestamp_granularities:["segment","word"]`, which the live endpoint accepts and
returns **both arrays in one response** — but costs ~2× (measured: 10 s audio =
$0.000167 single vs $0.000333 both).

Each chunk's transcript in the audit:

```jsonc
segments[i].transcript: {
  "text": "mm:ss.s  line\n…",
  "chars": 824,
  "engine": "transcriptions",
  "model": "nvidia/nemotron-3.5-transcribe",
  "cue_source": "grouped",          // grouped | provider | text
  "cue_count": 9,
  "word_count": 112,
  "words_truncated": false,         // capped at 3000 words per chunk
  "timed": true,
  "cues": [
    { "start_sec": 0.16, "end_sec": 2.96,
      "text": "Occupation jo hai meri MBA maine finance mein kiya hua hai.",
      "speaker": null,
      "words": [[0.16, 0.52, "Occupation"], [0.64, 0.68, "jo"]] }
  ]
}
```

`cue_source` says which grain actually happened: `grouped` (cues built from
words — the default), `provider` (endpoint cues as returned), `text` (no timings
available, window-level fallback). Words are `[start_sec, end_sec, word]`
triples: a 4-minute video is ~2k words, and triples keep that to tens of KB
instead of hundreds.

`overall.transcript.text` stays line-level (`mm:ss.s  text`, capped at 8 000
chars in the brief) so the report stays readable.

How it is used:

1. `ffmpeg -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k` cuts one audio window
   per video window, with the same `-ss/-t` so timings line up.
2. The transcript is injected above the visual instruction — *"verbatim; trust it
   for speech, names and numbers"* — and the previous segment's transcript tail
   carries continuity.
3. The stitcher receives a bounded transcript digest, so quotes and names stop
   drifting from what was actually said.
4. `request_shape` discovery: the transcriptions endpoint is tried as
   `json:input_audio` → `json:audio-object` → `json:audio-b64` →
   `multipart:file`, and the shape that worked is recorded so a future run is
   one-shot.

Failure posture: transcription is best-effort. A 400/429/402 records the attempt
trail in `chain[i].transcription.error`, the chunk still analyzes video-only, and
silent footage is reported as `input.transcription.skipped_reason:
"source has no audio stream"` rather than an error.

## Background jobs and resume

`background: true` starts a detached run (its own `AbortController`, 45 min cap),
returns a job id, and checkpoints the partial audit to storage after planning and
after every chunk.

- single-flight per file: a second request for the same path returns the running
  job with `deduplicated: true`
- `video_analysis_job({ job_id })` → status/progress/counts/last 25 progress events
- `video_analysis_job({ job_id, include: "audit" })` → `audit` is `null` while
  running, the full contract when finished
- `video_analysis_cancel({ job_id })` → aborts in-flight fetch/ffmpeg
- unfinished jobs are pruned from storage after 24 h

### Resume

Re-running the **same file with the same prompt and settings** after a job was
cancelled, crashed or timed out continues from the last completed chunk instead
of starting over. Nothing extra is required — the run picks the newest unfinished
job for that file.

- finished chunks are adopted, not re-analyzed: their analysis, findings, scenes,
  transcript and entity appearance are carried into the new run, and continuity
  (n-1 summary + transcript tail) is rebuilt from them
- records for chunks that were interrupted are **discarded**, not replayed: those
  chunks are re-analyzed and counted once, so `parsing.chunks_completed` and
  `chunks_failed` always match one record per chunk
- the sidecar files are rebuilt from the reused chunks at startup, then appended
  per new chunk, so they stay complete and duplicate-free
- the audit records it: `audit.resume = { from_job_id, chunks_reused,
  chunks_discarded, config_sha }`

A resume is only offered when the fingerprint matches exactly —
`config_sha = sha1(path + size + mtime + chunk_sec + overlap_sec + filter +
vision model + stt engine/model + prompt)[0..16]`. Touch the file, change the
prompt or switch the model, and the run starts fresh rather than mixing two
pipelines in one report.

## Where the audit lives

Every run writes **two** copies, and they are for different consumers.

**Storage** — what `video_analysis_audit` reads, with no path involved:

- DB: `<home>/.local/share/opencode/opencode.db` (table `kv`)
- Keys: `job/<job_id>`, `audit/last`, `audit/<file>-<hash8>`
- Prefix in the DB: `plugin:<hex(pluginID)>:`, where the hex is the plugin id in
  UTF-16 code units
- `metadata.audit_key` and the record's `audit_key` tell you which key to read
- job records are pruned after 24 h; `audit/last` and `audit/<file>-<hash8>` persist

**Disk** — what the HTML explorer and other tools read:

Written by default to `./audit-output`, resolved against the **OpenCode server's
working directory** (often your home folder, not the project you are editing).
The response always tells you the real path: `audit.file` (and
`detailed_audit.file`). Set `VIDEO_ANALYSIS_AUDIT_DIR` to a project-relative
directory if you want audits beside your code; disable with
`VIDEO_ANALYSIS_AUDIT_FILES=off` or `auditFiles:false`.

Every run writes:

| File | Contents |
| --- | --- |
| `<name>-<hash8>.audit.json` | the complete audit (same shape as `detail:"full"`) |
| `<name>-<hash8>.timeline.jsonl` | manifest, then one line per scene and finding |
| `<name>-<hash8>.transcript.jsonl` | manifest, then one line per cue (with words) |

`hash8` is `sha1(resolved_path)[0..8]`, so two files with the same name in
different folders never collide. The sidecars are append-only during a run and
rebuilt only when a run resumes.

```jsonc
{"type":"manifest","schema_version":"1.5","plugin":"opencode-video-analysis","run":"va_…","video":"x.mp4","started_at":"ISO"}
{"type":"scene","chunk_index":1,"start_sec":5.1,"end_sec":9.6,"time_range":"00:05 to 00:09","setting":"…","activity":"…","on_screen_text":["…"]}
{"type":"finding","timestamp":"02:30","at_sec":150.4,"kind":"beat","source":"model","chunk_index":3,"text":"…"}
{"type":"cue","chunk":1,"start_sec":0.16,"end_sec":2.96,"text":"…","speaker":null,"words":[[0.16,0.52,"Occupation"]]}
```

## Audit object (schema 1.5)

```
schema_version, plugin{id,version}, mode{foreground|background}, job|null, status, error
input{ prompt, model, video_path, resolved_path, observation{…}, transcription{…},
       provider{ id, base_url, model, api_key_source, header_keys },
       options{ chunk_sec, overlap_sec, filter, max_attempts, stitch },
       environment{ cwd, platform, api_key_present, opencode_version, plugin_location },
       tool_context{ session_id, message_id, call_id, agent } }
video{ source, path, filename, duration_sec, size_mb, width, height, fps, has_audio }
parsing{ strategy, total_chunks, chunks_completed, chunks_failed, progress_percent,
         continuity, coverage{ covered_seconds, coverage_percent, covered_ranges[], uncovered_ranges[] },
         failures[]{ chunk_index, time_range, start_sec, end_sec, occurred_at,
                     error, attempts, recoverable, suggestion } }
entities[]{ id, kind, label, descriptors[], aliases[], appearances[]{chunk_index,start_sec,end_sec,cue},
            first_seen_sec, last_seen_sec }
registry{ status, kinds_considered[], note, blocks_parsed, blocks_failed, observations_unmatched }
scenes[]{ chunk_index, start_sec, end_sec, time_range, setting, activity, on_screen_text[] }
segments[]{ chunk_index, time_range, start_sec, end_sec, status, findings[], scenes[],
            entities_seen[], transcript{…cues[]…}|null, analysis, error }
chain[]{ chunk_index, time_range, start_sec, end_sec, status, started_at, finished_at,
         duration_ms, ffmpeg{…}, api{ calls, attempts[]{…}, usage, error },
         continuity_in[], summary_out, transcription{…}, entities_added[],
         entities_matched[], scenes_count, entity_block{ok,error,repaired}, analysis_chars }
overall{ analysis, perspective, transcript{…}, findings[], findings_count, entity_index{} }
progress_log[]{ at, percent, phase, status }
audit{ started_at, finished_at, elapsed_ms, probe_ms,
       api{ calls, video_calls, text_calls, retries, failures },
       stitch{ used, mode, model, calls, duration_ms, attempts[], error },
       cleanup{ workdir_used, workdir_removed }, file,
       resume{ from_job_id, chunks_reused, chunks_discarded, config_sha }|null }
```

Consuming it: read `status`; if `completed`, use `overall.analysis` + `findings`
+ `scenes` + `entities` from the brief. Follow `detailed_audit.file` only when you
need cue/word timings or per-chunk provenance.

## Cost and limits

- vision: one call per chunk, plus one stitch call for multi-chunk videos
  (`stitch:"none"` removes it)
- STT: ~$0.0000167 per second of audio on the default engine, ~0 with
  `engine:"responses"`
- chunking: `CHUNK_SEC = 60`, `OVERLAP_SEC = 5`, `fps = 2`, width ≤ 1280
- background jobs: 45 min hard cap, 24 h retention

## Notes and limits

- Word timings require `engine:"transcriptions"`; the free `responses` engine
  returns timed lines only (`cue_source:"text"` is the honest label for that).
- ASR on rapid cuts can garble names. Identity comes from the entity registry and
  on-screen text, not audio alone; check labels before publishing them.
- The vision call expects the OpenAI *Responses* shape; a Chat Completions
  endpoint is not translated for you.
- Container support is whatever `ffmpeg` can demux; `.mkv` / `.avi` are
  transcoded per chunk, which costs time.
- The audit is produced by the plugin. Read it in-context with
  `video_analysis_audit`, as a one-off with `detail:"full"`, with
  `video_analysis_job({ include:"audit" })`, from the file in `audit-output/`, or
  visually in the HTML explorer in `explorer/`.

## Audit viewer

`explorer/index.html` is a single-file viewer for a finished audit — timeline,
scenes, entities, findings, transcript with karaoke, coverage gaps and the
per-chunk diagnostics. It needs no build step and no server-side code; it is a
static page, not a plugin tool.

Because audits land in `./audit-output` **relative to the server's working
directory**, point the viewer at the file rather than relying on a relative
default. Serve any directory that contains both the audit and the plugin, e.g.:

```bash
# one directory above both your audits and the plugin
node .opencode/plugins/opencode-video-analysis/scripts/serve.mjs <dir> 8766
# then open, with the audit path taken from the tool's audit.file:
# http://127.0.0.1:8766/<path-to-plugin>/explorer/?audit=/audit-output/<name>-<hash8>.audit.json
```

If you would rather serve your project root, set `auditDir` to a project-relative
directory first (e.g. `audit-output`), and the path above becomes
`?audit=/audit-output/…`.

It opens a synthetic fixture when no `?audit=` is given, so it works on a fresh
clone. You can also drag a `.json` onto the page; `.timeline.jsonl` and
`.transcript.jsonl` sidecars merge in the same way, and a dropped `.mp4` pairs a
video with the loaded audit. See [`explorer/README.md`](./explorer/README.md).

## Credits

**Original author and copyright holder: Mesum Raza** —
[@mesumraza](https://github.com/mesumraza).

If you build on this project, the licence requires you to keep the copyright
notice, the [`NOTICE`](./NOTICE) file, and the attestation that your version is
modified. That is the whole reward for the work: a fork is welcome, an uncredited
fork is a licence violation.

The default models this was developed against are NVIDIA Nemotron models served
by OpenRouter (vision: `nemotron-3.5-super-vl`, speech: `nemotron-3.5-transcribe`).
They are external services, not bundled with this project and not governed by its
licence.

Bugs are fixed because someone reported them with a real video; contributors are
credited in [`CHANGELOG.md`](./CHANGELOG.md).

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request, and
note that contributions are accepted under the [`CLA`](./CLA.md) — it is what
keeps the dual AGPL + commercial licensing possible. Security issues go through
[`SECURITY.md`](./SECURITY.md), never a public issue.

## License

**GNU Affero General Public License, version 3 or later** —
[`LICENSE`](./LICENSE), with attribution terms in [`NOTICE`](./NOTICE).

| | |
| --- | --- |
| Copyright | © 2026 Mesum Raza. All rights reserved under the terms below. |
| Free use | personal, educational, research, evaluation, and open-source projects |
| Derivative works | must be licensed under AGPL-3.0-or-later, must publish their source (including when offered over a network), and must credit the original author |
| Commercial / closed-source | requires a paid commercial licence — [`COMMERCIAL.md`](./COMMERCIAL.md) |
| Relicensing | not permitted; you may not relicense a derivative under different terms |
| Trademarks | the project name and author name are not licensed for endorsement |

This project is **open source under AGPL-3.0-or-later**. Under that licence you
may use it commercially *only if* you accept its copyleft obligations — in
practice, publishing your complete corresponding source under the same licence.
If you cannot do that, you need the commercial licence instead.

Nothing here is legal advice; the licence text governs.
