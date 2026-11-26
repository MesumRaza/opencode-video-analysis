[Documentation index](README.md) · [Project home](../README.md)

# Troubleshooting

This page lists problems that can be diagnosed from the plugin's messages and
audit fields. Each entry names the evidence to check before changing anything.

## First Diagnostic Pass

| Check | Where |
| --- | --- |
| Status and top-level error | `status`, `error` |
| Which chunks failed and why | `parsing.failures[]` |
| Which seconds were not analyzed | `parsing.coverage.uncovered_ranges` |
| Which key source was used (never the key) | `input.provider.api_key_source` |
| Request attempts and HTTP status | `chain[i].api.attempts[]` |
| Transcription shape and error | `chain[i].transcription` |
| Whether a run resumed | `audit.resume` |
| The real audit path | `audit.file`, `detailed_audit.file` |
| Registry outcome | `registry.status` |
| Transcript grain | `segments[i].transcript.cue_source` |

Basic environment checks:

```bash
ffmpeg -version
ffprobe -version
node --version
```

## The tools are missing

- Confirm the plugin is in `.opencode/plugins/opencode-video-analysis` or listed
  in the `plugin` array in `opencode.json`.
- Restart OpenCode. Editing `index.ts` hot-reloads an already-loaded plugin; it
  does not discover a newly added plugin directory.
- Confirm the tools `analyze_video`, `video_analysis_job`,
  `video_analysis_cancel` and `video_analysis_audit` are present.

## "No API key for provider …"

The plugin reports:

```text
No API key for provider "<id>". Set VIDEO_ANALYSIS_API_KEY or OPENROUTER_API_KEY, or plugin option apiKey.
```

Set one of those, or the plugin option `apiKey`. The audit's
`input.provider.api_key_source` shows which source was used:
`plugin-options:apiKey`, `env:VIDEO_ANALYSIS_API_KEY`,
`env:OPENROUTER_API_KEY` or `none`.

If the key is set but the provider rejects it, inspect
`chain[i].api.attempts[]` for the HTTP status and the provider's response
snippet. See [Configuration](CONFIGURATION.md).

## `ffmpeg` or `ffprobe` is not found

`ffprobe` failures are best-effort: metadata can come back zeroed and the run
continues. The first actual cut then fails with an `ffmpeg failed for …` message,
recorded in `chain[i].ffmpeg.error` and `parsing.failures[]`.

Confirm that both binaries are on `PATH` in the environment that launched
OpenCode, not only in a separate terminal. On Windows, a terminal started before
a `PATH` change may need to be restarted.

## Rate limited (HTTP 429)

Each API call gets up to three attempts with a short backoff. When the limit
persists, the chunk fails and the audit's suggestion says the provider rate
limited the run. Options:

- retry the range later,
- use a key with a higher limit,
- run it as a background job so you can continue working; background mode does
  not raise the provider's limit.

Check `chain[i].api.attempts[]` for the exact statuses.

## Payload too large (HTTP 413)

The audit suggestion points at the chunk size. The chunk length, overlap and
video filter are source constants (`CHUNK_SEC`, `OVERLAP_SEC`, `CHUNK_VF`), not
plugin options. There is no supported configuration knob for them in 2.7.0.
Treat a 413 as a provider limit rather than a prompt problem.

## Run finished with gaps

`status: "completed_with_errors"` means at least one chunk failed. Read:

- `parsing.failures[]` for the error, attempts, `recoverable` flag and
  suggestion,
- `parsing.coverage.uncovered_ranges[]` for the seconds that were never
  analyzed.

Successful chunks are still valid. If the failed range matters, re-run the
analysis; the rest of the video is unaffected. A re-run may reuse completed
chunks when the fingerprint matches (see resume below).

## No audit file on disk

Disk export is on by default, but the directory is resolved against the
**OpenCode server's working directory**. A relative `./audit-output` may not be
inside the project you are editing.

- Read `audit.file` from the response; it is the real path.
- Set a project-relative `auditDir` (plugin option) or `VIDEO_ANALYSIS_AUDIT_DIR`.
- Check that `auditFiles` is not `false` and
  `VIDEO_ANALYSIS_AUDIT_FILES` is not `off`.
- Remember that disabling disk export does not remove the audit from plugin
  storage; `video_analysis_audit` still reads it.

## The HTML explorer is blank or cannot fetch

Browsers refuse `fetch()` on `file://`. Serve the files:

```bash
node .opencode/plugins/opencode-video-analysis/scripts/serve.mjs . 8766
```

Then pass an absolute path from the served root:

```text
http://127.0.0.1:8766/.opencode/plugins/opencode-video-analysis/explorer/?audit=/audit-output/<name>-<hash8>.audit.json
```

With no `?audit=`, the viewer opens a synthetic fixture. If that works but your
audit does not, the path is wrong or the audit is outside the served root. See
[the explorer guide](../explorer/README.md).

## Background job is unknown or expired

`video_analysis_job` returns `status: "unknown"` when the id does not exist or
the record has been pruned. Job records are retained for 24 hours. Also check:

- the id starts with `va_` and matches the one returned at start,
- the job was not cancelled and then expected to still be live,
- `include: "audit"` returns `audit: null` while running; that is normal.

The finished audit may still be available at `audit/last` or under its per-file
key, and `video_analysis_audit` can read those.

## A re-run started over instead of resuming

Resume is deliberately strict. It applies only to the newest unfinished job
whose fingerprint matches. The fingerprint includes:

- resolved path, file size and modification time,
- chunk and overlap settings and the video filter,
- vision model,
- STT engine and model,
- prompt.

Touching the file, changing the prompt, or switching either model starts a fresh
run. Confirm whether a resume happened by reading `audit.resume`; if it is
`null`, the run did not continue an earlier job.

## Word timings are missing

- Word timings require `engine: "transcriptions"` (the default). The free
  `responses` engine returns timed lines only.
- Check `segments[i].transcript.cue_source`. `grouped` means cues came from
  words; `provider` means endpoint segments; `text` means no timings were
  available.
- Check `word_count` and `words_truncated`. A chunk with no words cannot provide
  word timings even on the paid engine.

See [Transcription](TRANSCRIPTION.md).

## Silent video shows no transcript

A source without an audio stream is a valid input. The audit records
`input.transcription.skipped_reason: "source has no audio stream"` and analyzes
the video visually. This is not an error.

If the source does have audio but transcription failed, inspect
`chain[i].transcription.error` and `attempts[]`, and confirm the STT key and
engine.

## Names or identities are wrong

ASR can garble names, especially across rapid cuts or overlapping speech. The
plugin mitigates this with the entity registry, on-screen text and a transcript
digest passed to the stitcher, but it does not verify identity.

- Prefer on-screen text and registry descriptors when identity matters.
- Two spellings of one name can appear as aliases.
- Treat `label` as a lead, not a fact.
- Ask for quotes or on-screen text in the prompt when precision matters.

## The vision endpoint rejects requests

The plugin sends the OpenAI **Responses** shape. A Chat Completions endpoint is
not translated. Confirm:

- the base URL is a Responses endpoint,
- the model id exists on that provider,
- any extra headers are supplied through plugin `headers`,
- `input.provider.model`, `base_url` and `api_key_source` match what you meant.

Provider error snippets are in `chain[i].api.attempts[]`.

## Audit output is truncated or replaced by an index

This is intentional. `video_analysis_audit` caps its JSON and replaces an
oversized response with the index plus a hint. Narrow the request:

```ts
video_analysis_audit({ sections: ["transcript"], from_sec: 0, to_sec: 120 })
video_analysis_audit({ sections: ["findings"] })
video_analysis_audit({ ref: "chunk:2" })
```

Raise `max_chars` only when the consumer can handle the payload. See
[Audit System](AUDIT-SYSTEM.md).

## Runs are slow or expensive

- Each chunk is one vision call; a multi-chunk run adds one stitch call.
- The default STT engine is paid per second of audio.
- A 45-minute background cap applies.

Useful choices: `background: true` for long files, `stitch: "none"` to skip the
stitch call, and `transcribe: { engine: "responses" }` for free line-level
transcription. Chunk size and frame rate are fixed in 2.7.0.

## Related Documentation

- [Installation](INSTALLATION.md) · [Configuration](CONFIGURATION.md)
- [Usage](USAGE.md) · [Available Tools](TOOLS.md) · [Audit System](AUDIT-SYSTEM.md)

---

[Documentation index](README.md) · [Project home](../README.md)
