[Documentation index](../docs/README.md) · [Project home](../README.md)

# Audit explorer

A single-file HTML viewer for an audit produced by this plugin. No build step, no
dependencies, no network calls — it renders one audit, or one audit plus its
sidecars, and drives a video player from the timestamps in that audit.

```
explorer/
  index.html                     the viewer (everything inline)
  fixtures/
    schema15-demo.json           synthetic audit, safe to commit
    schema15-demo.timeline.jsonl scene + finding sidecar
    schema15-demo.transcript.jsonl cue + word sidecar
    make-fixture.mjs             regenerates the fixture
```

## Run it

Browsers refuse `fetch()` on `file://`, so serve a directory that contains both
the viewer and your audits. With the default export the audits sit in
`<server cwd>/audit-output` — take the exact path from the run's `audit.file`.

```bash
node .opencode/plugins/opencode-video-analysis/scripts/serve.mjs <dir> 8766
```

Then open:

```
http://127.0.0.1:8766/<path-to-plugin>/explorer/?audit=/audit-output/<name>-<hash8>.audit.json
```

With no query string it shows the synthetic fixture, so it works on a fresh clone
with no API key and no video.

`serve.mjs` streams with HTTP range support, so a large source video scrubs
without being loaded whole.

## Load your own audit

Any of these:

- `?audit=<url>` — e.g. `/explorer/?audit=/audit-output/my-video-abc123.audit.json`
  (absolute path from the served root)
- **Load latest export** in the toolbar, which scans `audits/` and `audit-output/`
- drag a `.json` file (audit or job record) onto the page
- drag a `.mp4` onto the page to pair a video with the loaded audit
- sidecars (`*.timeline.jsonl`, `*.transcript.jsonl`) can be dropped as well and
  are merged into the loaded audit — scenes and findings deduped, cues attached
  per chunk

To keep audits somewhere else:

```jsonc
{ "plugin": { "opencode-video-analysis": { "auditDir": "audit-output" } } }
```

`VIDEO_ANALYSIS_AUDIT_FILES=off` disables the on-disk export; the audit is then
only in plugin storage, where `video_analysis_audit` can still read it.

## What it shows

| Area | Content |
| --- | --- |
| Header chips | status, chunks, coverage, scenes, entities, findings, duration, registry status, audio mode |
| Player | the source video, with transport (10 s / 1 s steps, speed) |
| Timeline | scene lane, one lane per entity, finding markers, coverage gaps, playhead |
| Scenes | in/out timecodes, setting, activity, on-screen text, entity pills |
| Entities | id, kind, label, descriptors, aliases, every appearance as a clickable timechip |
| Findings | filterable by kind; click to seek |
| Transcript | one block per chunk, with per-line timecodes and karaoke when words exist |
| Diagnostics | coverage, API calls, tokens, per-chunk chain, failures and suggestions, perspective verdict, resume record |
| Raw | the whole audit envelope |

## Interaction

- click a scene row, entity chip, timeline block or finding → the video seeks there
- **follow playhead** keeps the right panel in sync: the current scene, who is on
  screen, and any finding within ±2 s; the coverage bar under it shows analyzed
  spans solid and gaps hatched
- `space` play/pause · `←/→` ±2 s · `j/l` ±10 s · `n/p` next/prev scene · `/` filter
- `+ / −` change the timeline scale · **Copy beats TSV** exports scenes and entity
  ids for a spreadsheet
- light/dark and high-contrast themes persist in `localStorage`

## Schema support

Reads 1.3, 1.4 and 1.5, and absorbs the 1.5 restructure:

- **cues are the phrase container** — `segments[].transcript.cues[]` with
  `{ start_sec, end_sec, text, speaker, words: [[start, end, "word"]] }`; 1.4
  `segments[]` and plain-text/inline-timecode transcripts still render
- **`cue_source`** (`grouped` / `provider` / `text`) is displayed, so you can see
  which grain the run actually produced
- **karaoke** uses the nested word arrays, so the spoken word highlights as the
  playhead moves
- **findings** use `at_sec`, fall back to the display timestamp, and keep `id` /
  `source`; kinds other than `defect` render as marks without being counted as defects
- **brief vs full** — a payload without `chain[]` is treated as a brief, and
  Diagnostics says so
- **resume** — `audit.resume` is shown with the job it continued from

Works entirely offline; nothing is uploaded anywhere.

---

[Documentation index](../docs/README.md) · [Project home](../README.md)
