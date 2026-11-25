# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). `SCHEMA_VERSION`
tracks the audit shape and moves independently of the plugin version.

## [Unreleased]

Nothing yet.

## [2.7.0] — 2026-11-25

### Changed

- **The plugin is named `opencode-video-analysis`.** The `-v2` suffix is gone
  from the directory, the package name and `plugin.id`; the version lives only in
  `package.json` and `PLUGIN_VERSION`. Storage keys therefore change
  (`plugin:<hex(id)>:…`): audits written under the old id are still readable
  through the HTML explorer or the exported files, but are not listed by the job
  tools. The pre-2.0 plugin of the same name was retired.
- `engines.node` is `>=22.6` (types are stripped at runtime by Node); Bun works
  the same way.

### Added

- **`video_analysis_audit` tool.** Reads a finished audit from plugin storage by
  run id (or the latest run) and returns it in-context: `index` map, selected
  `sections`, a time window, or one `ref` (finding / entity / chunk). `detail:"full"`
  returns the whole audit, withheld and replaced by the index if it would exceed
  `max_chars`. Word timings are opt-in via `include_words`.
- **On-disk audit export is on by default** (`./audit-output`), so the HTML
  explorer always has a file to open. Opt out with `VIDEO_ANALYSIS_AUDIT_FILES=off`
  or plugin option `auditFiles:false`.
- **Audit explorer** (`explorer/index.html`): a single-file viewer for a finished
  audit — timeline, scenes, entities, findings, transcript with karaoke, coverage
  gaps, per-chunk diagnostics and resume record. Ships a synthetic schema-1.5
  fixture so a fresh clone renders without a video or an API key.
- `scripts/serve.mjs` (static server with HTTP range support, used to serve the
  viewer and the source video) and `scripts/check-viewer.mjs` (validates the
  fixture, the default-audit pointer and any real audit passed to it).
- CI now checks the viewer fixture alongside syntax and packaging.

### Documentation

- README: install from package or git, audit-viewer section, explicit statement
  that there is no built-in audit-query tool.
- Repository files for outside contributors: NOTICE, COMMERCIAL.md, CLA.md,
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, CHANGELOG.md, issue forms,
  PR template, CODEOWNERS.

## [2.6.1] — 2026-11-24

### Fixed

- **Resume no longer replays interrupted chunks.** A resumed run adopts only
  `completed` segment records, de-duplicated by `chunk_index`. Failed records and
  `parsing.failures` from the cancelled attempt are discarded because those
  chunks are re-analyzed. Previously a 3-chunk job could report five segment
  records and finish as `completed_with_errors` with `chunks_failed: 2`.
- **`chunks_completed` / `chunks_failed` are derived in `finish()`** from
  `segments[]` instead of being accumulated, so the counters can never disagree
  with the records.
- **Sidecars are complete after a resume.** The `.timeline.jsonl` and
  `.transcript.jsonl` files are rebuilt from the reused chunks at startup and
  then appended per new chunk; previously a resumed run could leave a
  manifest-only `.transcript.jsonl` with no cues.
- A URL-mode failure now records a failed segment instead of only incrementing a
  counter.

### Changed

- `audit.resume` gained `chunks_discarded` (records inherited from the
  interrupted run and re-analyzed in this one).
- README rewritten for schema 1.5: brief-vs-audit split, `detail`, `audit_dir`,
  cue/word shape, resume rules, sidecars, cost.

### Added

- Packaging: `transcription.ts` is included in `files`, so an installed or
  published package actually resolves its second module.
- `scripts/check-package.mjs` and a CI workflow that checks syntax, package
  metadata, version consistency and required files.

### Licensing

- Released under **AGPL-3.0-or-later**, with a commercial licence available for
  closed-source use (`LICENSE`, `NOTICE`, `COMMERCIAL.md`, `CLA.md`).

## [2.6.0] — 2026-11-24

### Changed

- Transcripts are **cues with nested word timings**: `segments[i].transcript.cues[]`,
  each `{ start_sec, end_sec, text, speaker, words: [[start, end, word], …] }`.
  There is no "sentence" container any more; `cue_source` reports how cues were
  obtained (`grouped`, `provider`, `text`).
- The default transcriber is the dedicated STT engine
  (`transcriptions`, `nvidia/nemotron-3.5-transcribe`) with `granularity: "word"`.
  The free prompt-driven `responses` engine remains available and returns timed
  lines only.
- `detail: "summary"` (default) returns a brief without word timings;
  `detail: "full"` returns the audit.

### Added

- `audit_dir` / `VIDEO_ANALYSIS_AUDIT_DIR` export: `.audit.json` plus
  append-only `.timeline.jsonl` and `.transcript.jsonl` sidecars.
- Resume: an unfinished job for the same file and pipeline config continues from
  its last completed chunk, gated by `config_sha`.

## [2.5.0] — 2026-11-23

### Added

- Audio transcription module with two engines behind one configuration surface.
- Word/segment timestamp discovery against `/audio/transcriptions`, including the
  request-shape fallback chain recorded as `request_shape`.
- Transcript digest passed to the stitcher so quotes and names stop drifting.

## [2.0.0] — 2026-11-22

### Added

- Rewrite as `opencode-video-analysis`: sequential chunking with n-1
  continuity, entity registry with stable ids, scenes, perspective
  (`observation`), background jobs with cancellation, and a structured audit
  (`schema_version`, `parsing`, `chain`, `progress_log`).
- `video_analysis_job` and `video_analysis_cancel`.

## [1.0.0] — 2026-11-21

### Added

- Initial `opencode-video-analysis` plugin: single-call video analysis with a
  free OpenRouter vision model.
