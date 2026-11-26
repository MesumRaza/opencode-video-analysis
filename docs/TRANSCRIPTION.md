[Documentation index](README.md) · [Project home](../README.md)

# Transcription

The plugin is audio-aware. It extracts one audio window per video window,
transcribes it, and places the transcript above the visual instruction so the
vision model hears speech instead of guessing from captions. Transcription is
best-effort: a failed STT request does not abort the video analysis.

## Two Engines

| Engine | Endpoint | Default model | Character |
| --- | --- | --- | --- |
| `transcriptions` (default) | `/api/v1/audio/transcriptions` | `nvidia/nemotron-3.5-transcribe` | Dedicated STT; word timings, diarization, paid |
| `responses` | `/api/v1/responses` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Prompt-driven; timed lines only, no word array, free |

The dedicated engine is the default because it is the only path that returns
word timings, and word grain is the default cue construction. The free engine is
useful when cost matters more than word-level precision.

Engine selection:

- an explicit `engine` wins;
- otherwise an explicit transcription `baseUrl` selects `transcriptions` when it
  contains `/audio/transcriptions`, and `responses` for any other URL;
- otherwise the engine is `transcriptions`.

## Supported Configuration

Full precedence and environment variable names are in
[Configuration](CONFIGURATION.md). The knobs are:

| Knob | Values / default |
| --- | --- |
| `enabled` | Default `true` when an STT or shared key exists |
| `engine` | `transcriptions` (default) or `responses` |
| `model` | Engine default above |
| `baseUrl` | Engine endpoint above |
| `language` | `null` (provider auto-detect), or a language code |
| `diarize` | `false` by default |
| `timestamps` | `true` by default |
| `granularity` | `word` (default) or `segment` |
| `mode` | `auto` (default), `prompt` or `report` |
| `apiKey` | STT-specific key, else shared key |
| `headers` | Extra headers, through plugin options |
| `extraBody` | Extra body fields, through plugin options |

Example: force the free engine and English.

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "transcribe": { "engine": "responses", "language": "en" }
    }
  }
}
```

### A Note on `granularity: "both"`

The `analyze_video` input schema lists `both`, but the current resolver treats
any value other than `"segment"` as `"word"`. Do not rely on `"both"` to return
both arrays in one call; use `"word"` when word timings matter and `"segment"`
when provider segments are sufficient.

## Timestamps

The dedicated endpoint accepts `verbose_json` with a timestamp granularity. This
was validated against the live endpoint with a 10-second probe:

| Request | HTTP | Returns |
| --- | --- | --- |
| `response_format: "verbose_json"` + `timestamp_granularities: ["word"]` | 200 | `words[]` with `{word, start, end}` plus `segments[]` |
| `response_format: "verbose_json"` + `timestamp_granularities: ["segment"]` | 200 | `segments[]` only |
| cost | — | `usage: { seconds, cost }`, about **$0.0000167/second** |

The audit records the request shape that actually worked, so a later run can go
straight to it.

## Cue Construction

`granularity: "word"` groups words into readable cues. A cue ends at:

- a pause of at least 0.6 seconds,
- sentence-ending punctuation (`.`, `!`, `?`),
- or approximately 110 characters.

Each cue keeps the exact start of its first word and the exact end of its last
word. `granularity: "segment"` uses the provider's segment boundaries instead.

`cue_source` states which grain was produced:

| `cue_source` | Meaning |
| --- | --- |
| `grouped` | Cues were built from returned words (the default) |
| `provider` | The endpoint's own segments were used |
| `text` | No usable timings; window-level text fallback |

## Transcript Shape

Each chunk's transcript in the audit:

```jsonc
segments[i].transcript: {
  "text": "mm:ss.s  line\n…",
  "chars": 824,
  "engine": "transcriptions",
  "model": "nvidia/nemotron-3.5-transcribe",
  "cue_source": "grouped",
  "cue_count": 9,
  "word_count": 112,
  "words_truncated": false,
  "timed": true,
  "cues": [
    {
      "start_sec": 0.16,
      "end_sec": 2.96,
      "text": "Occupation jo hai meri MBA maine finance mein kiya hua hai.",
      "speaker": null,
      "words": [[0.16, 0.52, "Occupation"], [0.64, 0.68, "jo"]]
    }
  ]
}
```

Words are `[start_sec, end_sec, word]` triples. A 4-minute video is roughly 2,000
words, and triples keep the payload to tens of kilobytes. Word arrays are capped
at 3,000 words per chunk; `words_truncated: true` marks clipping. Cues, scenes
and entities are uncapped.

`overall.transcript.text` is line-level (`mm:ss.s  text`) and is capped at 8,000
characters in the brief, so the summary stays readable.

## How the Audio Is Produced and Used

1. `ffmpeg` extracts a mono 16 kHz 64 kbps MP3 window per video window, with the
   same `-ss` and `-t` values, so timings align.
2. The transcript is injected above the visual instruction with the instruction
   to trust it for speech, names and numbers.
3. The previous segment's transcript tail (up to 220 characters) carries
   continuity into the next chunk.
4. The stitcher receives a bounded transcript digest, so quotes and names stop
   drifting from what was said.

For the dedicated endpoint, the plugin tries accepted request shapes in order:

```text
json:input_audio → json:audio-object → json:audio-b64 → multipart:file
```

The shape that worked is stored as `request_shape`, making a future run
one-shot. The `responses` engine uses its own `responses:input_audio` shape.

## Failure Posture

- A 400, 429 or 402 records the attempt trail in
  `chain[i].transcription.error`.
- The chunk still analyzes video-only; the run is not aborted.
- A source with no audio stream is reported as
  `input.transcription.skipped_reason: "source has no audio stream"`, not as an
  error.
- If no timings are available, the transcript is still produced as text with
  `cue_source: "text"`.

## Limitations

- Word timings require `engine: "transcriptions"`. The free `responses` engine
  returns timed lines only.
- URL mode does not transcribe: an `https://` input is a single remote-video
  request with no audio extraction. Use a local file for transcription.
- Diarization and language support depend on the external STT service, not on
  the plugin.
- ASR on rapid cuts, overlapping speech or music can garble names. Identity
  should come from the entity registry and on-screen text, not audio alone.
- The default engine is paid. Pricing is external and can change; the audit
  records the provider's returned usage.
- Audio extraction and transcription add processing time per chunk.

## Related Documentation

- [Configuration](CONFIGURATION.md) · [Available Tools](TOOLS.md)
- [Architecture](ARCHITECTURE.md) · [Audit System](AUDIT-SYSTEM.md)

---

[Documentation index](README.md) · [Project home](../README.md)
