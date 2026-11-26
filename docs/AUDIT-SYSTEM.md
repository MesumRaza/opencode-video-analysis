[Documentation index](README.md) · [Project home](../README.md)

# Audit System

Every run produces two surfaces: an answer-shaped **brief** and a complete
**audit**. The audit is the provenance record: inputs, chunks, API attempts,
scenes, entities, findings, transcripts, coverage, stitch details and resume
information. Schema **1.5** describes its shape.

The audit is written twice, for two different consumers.

## Two Copies

### Plugin storage

`video_analysis_audit` reads this copy. It requires no path and no filesystem
access.

| Item | Value |
| --- | --- |
| Store | OpenCode plugin storage, `kv` table (on a typical Unix install: `~/.local/share/opencode/opencode.db`) |
| Job records | `job/<job_id>` |
| Latest finished audit | `audit/last` |
| Per-file audit | `audit/<file>-<hash8>` |
| Storage prefix | `plugin:<hex(pluginID)>:` |
| Retention | Job records are pruned after 24 h; `audit/last` and per-file audits persist |

`metadata.audit_key` and the record's own `audit_key` tell you which key to read.
The hex prefix is the plugin id encoded in UTF-16 code units; audits written
under a different plugin id are not listed by the job tools.

### Disk export

This copy is for the HTML explorer and external tools. It is enabled by default.

| Item | Value |
| --- | --- |
| Default directory | `./audit-output` |
| Resolution base | The OpenCode **server's** working directory, not necessarily your project |
| Disable | `VIDEO_ANALYSIS_AUDIT_FILES=off` or plugin option `auditFiles: false` |
| Override | `VIDEO_ANALYSIS_AUDIT_DIR`, plugin `auditDir`, or per-run `audit_dir` |

The response always reports the real path in `audit.file` and
`detailed_audit.file`. If the server's working directory is not obvious, trust
those fields rather than a relative guess.

## Files Written

Every run with disk export enabled writes three files:

| File | Contents |
| --- | --- |
| `<name>-<hash8>.audit.json` | The complete audit (same shape as `detail: "full"`) |
| `<name>-<hash8>.timeline.jsonl` | Manifest, then one line per scene and finding |
| `<name>-<hash8>.transcript.jsonl` | Manifest, then one line per cue, with words |

`hash8` is `sha1(resolved_path)[0..8]`, so two files with the same name in
different folders never collide. Sidecars are append-only during a run and are
rebuilt only when a run resumes.

Sidecar rows look like this:

```jsonc
{"type":"manifest","schema_version":"1.5","plugin":"opencode-video-analysis","run":"va_…","video":"x.mp4","started_at":"ISO"}
{"type":"scene","chunk_index":1,"start_sec":5.1,"end_sec":9.6,"time_range":"00:05 to 00:09","setting":"…","activity":"…","on_screen_text":["…"]}
{"type":"finding","timestamp":"02:30","at_sec":150.4,"kind":"beat","source":"model","chunk_index":3,"text":"…"}
{"type":"cue","chunk":1,"start_sec":0.16,"end_sec":2.96,"text":"…","speaker":null,"words":[[0.16,0.52,"Occupation"]]}
```

## Schema 1.5

```text
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
entities[]{ id, kind, label, descriptors[], aliases[],
            appearances[]{ chunk_index, start_sec, end_sec, cue },
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

### Key fields

| Field | Why it matters |
| --- | --- |
| `status` | `completed`, `completed_with_errors`, `failed` or `cancelled` |
| `parsing.coverage` | Which seconds were analyzed and where the gaps are |
| `parsing.failures[]` | Per-chunk error, attempts, recoverability and a suggestion |
| `chain[]` | Per-chunk timing, ffmpeg result, API attempts, transcript and entity changes |
| `registry.status` | `populated`, `empty_no_recurring_subjects` or `extraction_failed` |
| `input.observation.source` | `request` or `default` |
| `input.provider.api_key_source` | Which key source was used, never the key itself |
| `audit.resume` | Present only when the run continued an earlier job |

## Brief vs Audit Rules

| Rule | Value |
| --- | --- |
| Findings in the brief | ≤ 30, time-ordered; `findings_total` holds the true count |
| Transcript text in the brief | ≤ 8,000 chars, with a truncation suffix |
| Words per chunk in the audit | ≤ 3,000, with `words_truncated: true` when clipped |
| Cues, scenes, entities | Uncapped in the audit |
| Word timings | Audit only, nested under `cues[]` |
| Phrase container | `cue` only; there is no "sentence" field |

## Reading the Audit

`video_analysis_audit` defaults to `detail: "index"`, which maps what the run
contains. It reports finding counts by kind and source, scene and entity counts,
cues and words per engine, chunk status, failures, the resume record and the
audit's byte size.

Then request only what you need:

```ts
video_analysis_audit({ sections: ["findings", "scenes"], from_sec: 120, to_sec: 180 })
video_analysis_audit({ sections: ["transcript"], include_words: true })
video_analysis_audit({ ref: "f12" })
video_analysis_audit({ ref: "p3" })
video_analysis_audit({ ref: "chunk:2" })
```

### Reader caps

Caps keep a single response from flooding a model's context. Capped sections
report totals and the number omitted, so an omission is visible.

| Data | Cap |
| --- | --- |
| Findings | 200 |
| Scenes | 500 |
| Entities | 200 |
| Cues | 800 |
| Analysis text | 8,000 chars |
| Perspective text | 4,000 chars |
| Transcript text | 8,000 chars |
| `summary_out` | 400 chars |

The total JSON is also capped by `max_chars` (default 20,000; 60,000 for
`detail: "full"`; maximum 200,000). If the response would exceed it, the reader
returns the index plus a hint instead of truncated JSON.

## Resume Record

A resumed run records:

```jsonc
"resume": {
  "from_job_id": "va_…",
  "chunks_reused": 3,
  "chunks_discarded": 0,
  "config_sha": "…"
}
```

`chunks_discarded` counts records inherited from the interrupted run and
re-analyzed in this one. The reader exposes this under the `resume` section.
Resume requires an exact fingerprint match; see [Usage](USAGE.md#resume-after-interruption).

## Consuming the Output

1. Read `status`.
2. If `completed`, use `overall.analysis`, `findings`, `scenes` and `entities`
   from the brief.
3. If `completed_with_errors`, inspect `parsing.failures` and
   `parsing.coverage.uncovered_ranges` before relying on the summary.
4. Follow `detailed_audit` or `audit.file` only when you need cue/word timings
   or per-chunk provenance.

The audit is produced by the plugin. It can be read in-context with
`video_analysis_audit`, as a one-off with `detail: "full"`, through
`video_analysis_job({ include: "audit" })`, from the exported file, or visually
in the [HTML explorer](../explorer/README.md).

## Related Documentation

- [Available Tools](TOOLS.md) · [Transcription](TRANSCRIPTION.md)
- [Architecture](ARCHITECTURE.md) · [Troubleshooting](TROUBLESHOOTING.md)

---

[Documentation index](README.md) · [Project home](../README.md)
