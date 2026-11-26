[Documentation index](README.md) · [Project home](../README.md)

# Configuration

Configuration has two surfaces: environment variables and plugin options in
`opencode.json` / `opencode.jsonc`. This page lists the variables the
implementation actually reads, the defaults, and which source wins.

## Precedence

For the vision backend:

| Setting | Order (highest first) |
| --- | --- |
| API key | plugin `apiKey` → `VIDEO_ANALYSIS_API_KEY` → `OPENROUTER_API_KEY` |
| Model | `analyze_video.model` argument → plugin `model` → `VIDEO_ANALYSIS_MODEL` → built-in default |
| Base URL | plugin `baseUrl` → `VIDEO_ANALYSIS_BASE_URL` → built-in default |
| Provider label | plugin `provider` → `VIDEO_ANALYSIS_PROVIDER` → derived from the base URL |
| Extra headers | plugin `headers` only |

For transcription the order is:

```text
tool argument → plugin transcribe option → environment → engine default
```

The audit records the key's source, never the secret, in
`input.provider.api_key_source` and in the transcription record.

## Vision Backend

| Variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `VIDEO_ANALYSIS_API_KEY` | Conditional | Backend key; falls back to `OPENROUTER_API_KEY` | none |
| `OPENROUTER_API_KEY` | Conditional | Shared fallback for vision and STT | none |
| `VIDEO_ANALYSIS_BASE_URL` | No | OpenAI Responses-shaped endpoint | `https://openrouter.ai/api/v1/responses` |
| `VIDEO_ANALYSIS_MODEL` | No | Vision model id | `nvidia/nemotron-3.5-super-vl:free` |
| `VIDEO_ANALYSIS_PROVIDER` | No | Label written to the audit | derived: `openrouter` or `custom` |

At least one key is required. The default base URL and model target OpenRouter;
other backends work when they accept the OpenAI *Responses* request shape. A
Chat Completions endpoint is not translated.

### Plugin options

These keys are supported under the plugin entry:

| Option | Type | Purpose |
| --- | --- | --- |
| `provider` | string | Provider label for the audit |
| `baseUrl` | string | Responses endpoint |
| `apiKey` | string | Backend key |
| `model` | string | Default vision model |
| `headers` | object | Extra request headers |
| `auditDir` | string | Directory for audit files, resolved against the server working directory |
| `auditFiles` | boolean | `false` disables the on-disk export |
| `transcribe` | boolean or object | STT configuration; see below |

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "provider": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1/responses",
      "model": "nvidia/nemotron-3.5-super-vl:free",
      "auditDir": "artifacts/audits",
      "auditFiles": true
    }
  }
}
```

## Audit Export

| Setting | Where | Effect |
| --- | --- | --- |
| `auditDir` | plugin option | Writes audits and sidecars to this directory |
| `VIDEO_ANALYSIS_AUDIT_DIR` | environment | Same, when the plugin option is absent |
| `auditFiles: false` | plugin option | Disables the disk export |
| `VIDEO_ANALYSIS_AUDIT_FILES=off` | environment | Disables the disk export |
| `audit_dir` | tool argument | Per-run directory; overrides the option and environment |

The default is `./audit-output`, resolved against the **OpenCode server's
working directory**. An explicit `auditDir` or `audit_dir` always wins, even if
`auditFiles` is `false`.

The response always reports the real path in `audit.file` and
`detailed_audit.file`. Disabling disk output does not disable plugin storage:
`video_analysis_audit` still reads the run from storage.

## Speech-to-Text

| Knob | Environment | Plugin option | Tool argument |
| --- | --- | --- | --- |
| on/off | `VIDEO_ANALYSIS_TRANSCRIBE=on\|off` | `transcribe: true` | `transcribe: false` |
| engine | `VIDEO_ANALYSIS_TRANSCRIBE_ENGINE` | `transcribe.engine` | `transcribe: { engine }` |
| model | `VIDEO_ANALYSIS_TRANSCRIBE_MODEL` | `transcribe.model` | `transcribe: { model }` |
| endpoint | `VIDEO_ANALYSIS_TRANSCRIBE_BASE_URL` | `transcribe.baseUrl` | `transcribe: { baseUrl }` |
| key | `VIDEO_ANALYSIS_TRANSCRIBE_API_KEY` | `transcribe.apiKey` | `transcribe: { apiKey }` |
| language | `VIDEO_ANALYSIS_TRANSCRIBE_LANGUAGE` | `transcribe.language` | `transcribe: { language }` |
| diarize | `VIDEO_ANALYSIS_TRANSCRIBE_DIARIZE=on` | `transcribe.diarize` | `transcribe: { diarize }` |
| timestamps | `VIDEO_ANALYSIS_TRANSCRIBE_TIMESTAMPS=off` | `transcribe.timestamps` | `transcribe: { timestamps }` |
| granularity | `VIDEO_ANALYSIS_TRANSCRIBE_GRANULARITY` | `transcribe.granularity` | `transcribe: { granularity }` |
| usage mode | `VIDEO_ANALYSIS_TRANSCRIBE_MODE` | `transcribe.mode` | `transcribe: { mode }` |
| provider label | `VIDEO_ANALYSIS_TRANSCRIBE_PROVIDER` | `transcribe.provider` | — |

Defaults when nothing is set:

| Setting | Default |
| --- | --- |
| enabled | `true` when an STT or shared key is present |
| engine | `transcriptions` |
| model | `nvidia/nemotron-3.5-transcribe` |
| base URL | `https://openrouter.ai/api/v1/audio/transcriptions` |
| language | `null` (provider auto-detect) |
| diarize | `false` |
| timestamps | `true` |
| granularity | `word` |
| mode | `auto` |

The engine is inferred from an explicit transcription endpoint when one is
provided: a URL containing `/audio/transcriptions` selects `transcriptions`;
any other explicit URL selects `responses`.

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "transcribe": {
        "engine": "transcriptions",
        "language": "en",
        "granularity": "word",
        "diarize": false,
        "mode": "auto"
      }
    }
  }
}
```

To use the free, prompt-driven path:

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "transcribe": { "engine": "responses" }
    }
  }
}
```

`transcribe.headers` and `transcribe.extraBody` are read by the transcriber
resolver and can be supplied through plugin options. The `analyze_video` input
schema does not expose those two fields.

See [Transcription](TRANSCRIPTION.md) for engine behaviour, timestamps and
limitations.

## Fixed Run Limits

These are source constants, not user configuration:

| Limit | Value |
| --- | --- |
| Chunk length | 60 seconds |
| Chunk overlap | 5 seconds |
| Chunk video filter | width ≤ 1280, 2 fps |
| Retries per API call | 3 |
| Background hard cap | 45 minutes |
| Job retention | 24 hours |
| Findings in the brief | 30 (time-ordered) |
| Transcript text in the brief | 8,000 characters |
| Words per chunk in the audit | 3,000 (`words_truncated: true` when clipped) |

## Cost Considerations

- Vision is one call per chunk plus one stitch call for multi-chunk videos.
  `stitch: "none"` removes the stitch call.
- The default STT engine is paid at roughly **$0.0000167 per second of audio**.
  A 4-minute video is about 260 seconds of audio, or roughly **$0.004**.
- `engine: "responses"` is free but returns timed lines without a word array.

Provider pricing is external and can change; the audit's `api.usage` records
what the provider returned.

## Related Documentation

- [Installation](INSTALLATION.md) · [Transcription](TRANSCRIPTION.md)
- [Audit System](AUDIT-SYSTEM.md) · [Troubleshooting](TROUBLESHOOTING.md)

---

[Documentation index](README.md) · [Project home](../README.md)
