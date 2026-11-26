[Documentation index](README.md) · [Project home](../README.md)

# Available Tools

The plugin registers four tools: `analyze_video`, `video_analysis_job`,
`video_analysis_cancel` and `video_analysis_audit`. The first starts work; the
next two manage background work; the last reads a finished audit without a file
path.

## analyze_video

For a local file it chunks long videos, transcribes audio, analyzes chunks
sequentially with continuity, maintains the entity registry, and optionally
stitches the chunk analyses. An `https://` URL is a single remote-video request;
see the limits below.

### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `video_path` | string | Yes | — | Local path or `https://` URL |
| `prompt` | string | Yes | — | What to look for or answer |
| `model` | string | No | configured model | Overrides the vision model for this run |
| `stitch` | `"model"` \| `"none"` | No | `"model"` | Model-combined summary, or a deterministic join |
| `detail` | `"summary"` \| `"full"` | No | `"summary"` | Brief output, or the complete audit |
| `audit_dir` | string | No | configured directory | Also write the audit here; overrides plugin and env settings |
| `background` | boolean | No | `false` | Return a job id immediately and continue detached |
| `observation` | object | No | general analyst | Perspective for every prompt |
| `transcribe` | boolean or object | No | enabled | STT configuration for this run |

`observation` accepts `observer` (string), `intent` (string), `focus` (string[]),
`assumptions` (string[]) and `questions` (string[]). Unknown fields are
rejected.

`transcribe` accepts either a boolean or an object with `engine`
(`"responses"` or `"transcriptions"`), `model`, `baseUrl`, `language`,
`diarize`, `timestamps`, `granularity`, `mode` (`"auto"`, `"prompt"` or
`"report"`) and `apiKey`. The input schema does not expose `headers` or
`extraBody`; those can be supplied through plugin options.

### Example

```ts
analyze_video({
  video_path: "demo.mp4",
  prompt: "Who appears and what happens?",
  observation: {
    observer: "a casting director building a talent shortlist",
    intent: "know who each person is, even when unnamed",
    focus: ["speaker identity", "wardrobe cues", "returning speakers"],
    assumptions: ["each intro card is a distinct person"],
    questions: ["does anyone appear twice?"]
  }
})
```

### Output

With `detail: "summary"` (default) the tool returns a JSON brief:

```text
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

With `detail: "full"` it also carries `input`, `registry`, `segments[]`,
`chain[]`, `progress_log[]`, and the uncapped findings and transcript (word
arrays still cap at 3,000 per chunk). Word timings are audit-only and nested
under cues.

When `background: true`, the immediate response is:

```jsonc
{
  "job_id": "va_…",
  "status": "running",
  "started_at": "ISO",
  "audit_key": "job/va_…",
  "hint": "Poll with video_analysis_job({ job_id }). include:'audit' returns the full contract when finished."
}
```

### Behaviour and Limits

- One vision call per chunk, plus one stitch call for multi-chunk videos when
  `stitch` is `"model"`.
- A local file is probed, chunked and transcribed. An `https://` URL is a single
  remote-video request: no probing, chunking or transcription.
- Up to three attempts per API call for rate limits and provider 5xx responses.
- Chunks are 60 seconds with a 5-second overlap; video is capped at 1280 px wide
  and 2 fps.
- `detail: "summary"` caps findings at 30 and transcript text at 8,000
  characters. `findings_total` and the audit carry the full data.
- When `background: true`, a hard 45-minute cap applies. The audit is
  checkpointed after planning and after every chunk.
- A failed chunk does not abort the run; it is recorded in
  `parsing.failures[]`, and the final status can be `completed_with_errors`.

## video_analysis_job

Reads a background job by id.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `job_id` | string | Yes | — | The id returned by `analyze_video({ background: true })` |
| `include` | `"summary"` \| `"audit"` | No | `"summary"` | Include the full audit contract once finished |

```ts
video_analysis_job({ job_id: "va_mwv7600d_vszk9v" })
video_analysis_job({ job_id: "va_mwv7600d_vszk9v", include: "audit" })
```

The response contains `job_id`, `status`, `video_path`, `filename`,
`created_at`, `updated_at`, `resumed_from`, `progress_percent`,
`chunks_completed`, `total_chunks`, `findings_count`, `defects_count`,
`entities_count`, `error`, the last 25 `progress_log` events and `audit_key`.

With `include: "audit"`, an `audit` field is added. It is `null` while the job is
running and the full contract after completion. An unknown or expired id returns
`status: "unknown"`.

## video_analysis_cancel

Aborts a running background job and its in-flight work.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `job_id` | string | Yes | The running job id |

```ts
video_analysis_cancel({ job_id: "va_mwv7600d_vszk9v" })
```

Returns `{ job_id, cancelled: true }` when a live job was aborted. If the job is
not currently running, it returns `{ cancelled: false, error: "Job is not running." }`.
Cancelling does not delete the partial audit; a matching re-run can resume from
the completed chunks.

## video_analysis_audit

Reads a finished audit directly from plugin storage. No file path, file read or
shell is involved.

### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `run` | string | No | most recent finished run | Job id (`va_…`) or audit key (`audit/…`) |
| `detail` | `"index"` \| `"full"` | No | `"index"` | Map the run, or return the audit object |
| `sections` | string[] | No | overview + findings | Sections to include |
| `ref` | string | No | — | One item: finding `f7`, entity `p3`, or `chunk:2` |
| `from_sec` | number | No | — | Window start; filters scenes, findings and cues that overlap it |
| `to_sec` | number | No | — | Window end |
| `include_words` | boolean | No | `false` | Include word timings inside cues |
| `max_chars` | integer | No | 20,000 (60,000 for full) | Output cap; clamped to 2,000–200,000 |

Valid `sections` values are `overview`, `video`, `input`, `findings`, `scenes`,
`entities`, `transcript`, `chunks`, `failures` and `resume`.

### Examples

```ts
// 1. What does this run contain?
video_analysis_audit({})

// 2. Only the transcript, with word timings.
video_analysis_audit({ sections: ["transcript"], include_words: true })

// 3. The 2:00–3:00 window, findings and scenes only.
video_analysis_audit({ sections: ["findings", "scenes"], from_sec: 120, to_sec: 180 })

// 4. One item.
video_analysis_audit({ ref: "f12" })        // finding
video_analysis_audit({ ref: "p3" })         // entity
video_analysis_audit({ ref: "chunk:2" })    // segment + chain provenance

// 5. A specific earlier run.
video_analysis_audit({ run: "va_mwv7600d_vszk9v", sections: ["overview"] })
```

### Output

With `detail: "index"` the response is a map of the run: finding counts by kind
and source, scene and entity counts, cues and words per engine, chunk status,
failures, the resume record and the audit's byte size. With `detail: "full"` it
is the whole audit object.

If the returned JSON would exceed `max_chars`, the response is replaced by the
index plus a hint instead of a silently truncated document. Narrow with
`sections`, `ref` or `from_sec`/`to_sec` and call again. Word timings are opt-in
because they roughly triple the transcript payload; cue text and times are
always included.

## Tool Selection Guide

| Goal | Tool |
| --- | --- |
| Analyze a new video and wait | `analyze_video` |
| Start a long run without blocking | `analyze_video({ background: true })` |
| Check progress or fetch a finished job | `video_analysis_job` |
| Abort a run | `video_analysis_cancel` |
| Read a finished report in-context | `video_analysis_audit` |

## Related Documentation

- [Usage](USAGE.md) · [Transcription](TRANSCRIPTION.md)
- [Audit System](AUDIT-SYSTEM.md) · [Troubleshooting](TROUBLESHOOTING.md)

---

[Documentation index](README.md) · [Project home](../README.md)
