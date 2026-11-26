[Documentation index](README.md) · [Project home](../README.md)

# Usage

This guide follows a normal analysis from input to output and links to the
reference pages for details. Configuration is covered in
[Configuration](CONFIGURATION.md); tool parameters are in
[Available Tools](TOOLS.md).

## Before You Start

- `ffmpeg` and `ffprobe` are on `PATH`.
- A vision API key is available, and an STT key is available or shared.
- The plugin is installed and OpenCode has loaded it.

## The Normal Workflow

1. **Choose a video.** Pass a local path (resolved against the OpenCode server's
   working directory) or an `https://` URL.
2. **Write the prompt.** State what you want to know. Findings, quotes and
   highlights are driven by this request.
3. **Add an observation (optional).** Describe who is looking and what matters.
4. **Decide how much detail you need.** The default brief is usually enough; ask
   for the full audit or query sections when you need provenance.
5. **Read the result, then drill down.** The response includes the audit path
   and key even when the content is summarized.

## Basic Example

```ts
analyze_video({
  video_path: "interviews/episode-01.mp4",
  prompt: "Give me a timecoded summary of each speaker and what they claim.",
  observation: {
    observer: "a fact-checking producer",
    intent: "find claims that need verification",
    focus: ["named people", "numbers", "dates", "quoted statements"],
    questions: ["does the same speaker appear in more than one segment?"]
  }
})
```

A completed response contains, among other fields:

| Field | Meaning |
| --- | --- |
| `status` | `completed`, `completed_with_errors`, `failed` or `cancelled` |
| `overall.analysis` | The stitched answer for the whole video |
| `overall.perspective` | The perspective verdict, when the run produced one |
| `overall.entity_index` | Compact id-to-label map |
| `findings[]` | Time-ordered highlights, capped at 30 in the brief |
| `scenes[]` | Scene descriptions with in/out timecodes |
| `entities[]` | Typed entities with every appearance |
| `transcript` | Line-level text, cue count, engine and model |
| `parsing` | Chunk counts, progress, coverage, continuity and failures |
| `video` | Filename, duration, size, dimensions, fps and audio presence |
| `audit.file` | The exported audit path, when disk output is enabled |
| `detailed_audit` | The audit file, storage key and a read hint |

Inspect `status` first. If it is `completed_with_errors`, read
`parsing.failures[]` and `parsing.coverage.uncovered_ranges[]` before relying on
the summary.

## Input Expectations

- **Local paths** are resolved with the OpenCode server's working directory.
  Relative paths can therefore point somewhere other than the project you are
  editing. Prefer absolute paths when in doubt.
- **URLs** must start with `http://` or `https://`. URL mode is a single remote
  request: the URL is sent to the vision provider as the video input, and the
  plugin does not probe, chunk or transcribe it. Use a local file when you need
  chunking, audio transcription or word timings.
- **Formats** are whatever `ffmpeg` can demux. `.mkv` and `.avi` are transcoded
  per chunk, which adds time.
- **Audio is optional.** A video with no audio stream is analyzed visually and
  records `input.transcription.skipped_reason: "source has no audio stream"`
  instead of failing.
- **Length** is not restricted by the plugin, but long files create more chunks,
  take longer and cost more. Background jobs have a 45-minute cap.

## Brief or Full Audit?

Both are produced on every run.

| Need | Read |
| --- | --- |
| The answer and the main scenes | Default `detail: "summary"` |
| Per-chunk prompts, attempts, timings and raw word arrays | `detail: "full"` or the audit file |
| A specific section, time window or item | `video_analysis_audit` |

```ts
analyze_video({
  video_path: "demo.mp4",
  prompt: "List the product features shown on screen.",
  detail: "full"
})
```

The brief caps findings at 30 and transcript text at 8,000 characters
(`findings_total` holds the true count). The full audit is uncapped except for
3,000 words per chunk, where `words_truncated: true` marks clipping.

## Reading the Audit In-Context

`video_analysis_audit` reads plugin storage only. It does not need a file path
or shell access.

```ts
// Map the most recent finished run.
video_analysis_audit({})

// Transcript with cue and word timings.
video_analysis_audit({ sections: ["transcript"], include_words: true })

// A two-minute window.
video_analysis_audit({ sections: ["findings", "scenes"], from_sec: 120, to_sec: 180 })

// One finding, entity or chunk.
video_analysis_audit({ ref: "f12" })
video_analysis_audit({ ref: "p3" })
video_analysis_audit({ ref: "chunk:2" })
```

`detail: "index"` is the default and reports what the run holds. `detail:
"full"` returns the audit object, but if it would exceed `max_chars` (20,000 by
default; 60,000 for full; 200,000 maximum) the response is replaced by the index
and a hint rather than a silently truncated document. Narrow with `sections`,
`ref`, `from_sec`/`to_sec`, or disable word arrays.

See [Audit System](AUDIT-SYSTEM.md) for the section names and caps.

## Background Jobs

Use a background job when the video is long or you want to keep working while it
runs:

```ts
// 1. Start.
const { job_id } = analyze_video({
  video_path: "long-lecture.mp4",
  prompt: "Summarize each topic and timestamp it.",
  background: true
})

// 2. Poll status and progress.
video_analysis_job({ job_id })

// 3. Once finished, read the full audit if needed.
video_analysis_job({ job_id, include: "audit" })

// 4. Or cancel.
video_analysis_cancel({ job_id })
```

While the job is running, `include: "audit"` returns `audit: null`. The job
record keeps the last 25 progress events in the summary path and checkpoints the
partial audit after planning and after every chunk. Job records are pruned after
24 hours.

A second background request for the same resolved file path returns the running
job with `deduplicated: true` instead of starting a second run.

## Resume After Interruption

Re-run the same file with the same prompt and settings after cancelling, a
crash, or a timeout. The plugin finds the newest unfinished job with a matching
fingerprint and continues from its last completed chunk.

```ts
analyze_video({
  video_path: "long-lecture.mp4",
  prompt: "Summarize each topic and timestamp it."
})
```

No resume flag is required. The fingerprint includes the resolved path, file
size and modification time, chunk and overlap settings, the video filter, the
vision model, the STT engine/model and the prompt. Any change starts a fresh run
instead of mixing pipelines. The new audit records `audit.resume` when it
continued an earlier run.

## Using Perspective Well

`observation` is injected into every chunk prompt and the stitch prompt. It is
most useful when the request alone would produce a generic summary:

```ts
observation: {
  observer: "a costume continuity supervisor",
  intent: "catch wardrobe changes between takes",
  focus: ["jacket colour", "accessories", "hair"],
  assumptions: ["the same actor may play two roles"],
  questions: ["does the jacket change without a scene cut?"]
}
```

If omitted, the observer defaults to “a general video analyst” and the intent
defaults to the prompt. The audit echoes the normalized observation under
`input.observation` with `source: "request"` or `"default"`.

## Viewing an Audit Visually

Serve a directory containing both the plugin and your audits:

```bash
node .opencode/plugins/opencode-video-analysis/scripts/serve.mjs . 8766
```

Open the explorer with the path from `audit.file`:

```text
http://127.0.0.1:8766/.opencode/plugins/opencode-video-analysis/explorer/?audit=/audit-output/<name>-<hash8>.audit.json
```

The explorer can also load a JSON audit or its sidecars by drag-and-drop and pair
a dropped `.mp4` with the loaded audit. See
[the explorer guide](../explorer/README.md).

## Practical Notes

- A prompt that asks for defects gets `kind: "defect"` findings; a neutral
  prompt gets beats, quotes, claims and topics instead. The plugin does not
  invent a defect taxonomy.
- Entity labels are model output. Two spellings can appear as aliases, and a
  phonetically heard name can be wrong. Check labels before publishing them.
- Word timings require the default `transcriptions` engine. The free `responses`
  engine returns timed lines (`cue_source: "text"`).
- Very rapid cuts can garble ASR. Prefer on-screen text and the entity registry
  when identity matters.

## Related Documentation

- [Available Tools](TOOLS.md) · [Transcription](TRANSCRIPTION.md)
- [Audit System](AUDIT-SYSTEM.md) · [Troubleshooting](TROUBLESHOOTING.md)

---

[Documentation index](README.md) · [Project home](../README.md)
