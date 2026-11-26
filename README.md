![opencode-video-analysis banner](./assets/readme-banner.png)

# opencode-video-analysis

Auditable, perspective-aware video analysis for OpenCode.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](./LICENSE)
![Plugin 2.7.0](https://img.shields.io/badge/plugin-2.7.0-informational) ![Schema 1.5](https://img.shields.io/badge/schema-1.5-informational) ![Node 22.6+](https://img.shields.io/badge/node-%3E%3D22.6-informational)

## Overview

This plugin watches a video **and** listens to it. A vision model analyzes
overlapping chunks in order, an STT service supplies word-level timings, and the
two are assembled into one report. Every claim keeps a timecode, and the full
provenance is written to a machine-readable audit. Plugin version **2.7.0**,
schema **1.5**; maintained by **Mesum Raza** ([@mesumraza](https://github.com/mesumraza)).

## Key Features

- **Sequential chunking with continuity** — 60-second windows with a 5-second overlap, each given the previous summary and transcript tail.
- **Entity registry** — recurring people, objects, UI elements and logos keep a stable id across scenes.
- **Perspective-aware output** — an optional `observation` shapes every chunk prompt and the final stitch.
- **Request-driven findings** — highlights are tied to your prompt, not a hard-coded "defect".
- **Word-level transcription** — cues carry nested word timings on the default STT engine.
- **Background jobs** — start, poll, cancel, and resume interrupted runs.
- **Two output surfaces** — a compact brief for the agent and a complete, machine-readable audit.

## How It Works

For a local file, `ffprobe` reads metadata and `ffmpeg` cuts windows with
matching audio. Each window is transcribed and sent to the vision model with the
previous chunk's context; a stitch call combines the analyses, and the run is
written to storage and to disk as an audit plus sidecars. An `https://` URL is
sent to the provider as one remote-video request, without chunking or STT.
See [Architecture](docs/ARCHITECTURE.md) for components and data flow.

## Quick Start

Install by cloning the plugin into your OpenCode plugin directory, or add
`"opencode-video-analysis"` to the `plugin` array in `opencode.json`:

```bash
git clone https://github.com/mesumraza/opencode-video-analysis.git \
  .opencode/plugins/opencode-video-analysis
```

Provide a key in the environment and configure the plugin if needed:

```bash
$env:OPENROUTER_API_KEY = "sk-or-..."   # PowerShell
```

```jsonc
{ "plugin": { "opencode-video-analysis": { "auditDir": "artifacts/audits" } } }
```

Restart OpenCode (or edit `index.ts`, which hot-reloads). Full steps and
verification are in the [Installation Guide](docs/INSTALLATION.md).

## Usage Example

```ts
analyze_video({
  video_path: "demo.mp4",                  // local path or https:// URL
  prompt: "Who appears and what happens?",
  observation: {
    observer: "a casting director building a talent shortlist",
    focus: ["speaker identity", "wardrobe cues", "returning speakers"]
  }
})
```

The default `detail: "summary"` returns status, coverage, scenes, entities,
findings, analysis, the perspective verdict and transcript lines. Use
`detail: "full"`, or `video_analysis_audit`, for per-chunk provenance and word
timings. See the [Usage Guide](docs/USAGE.md) for background jobs and resume.

<details>
<summary><strong>View the complete analyze_video argument surface</strong></summary>

```ts
analyze_video({ video_path, prompt, model?, stitch?, detail?, audit_dir?, background?, observation?, transcribe? })
```

</details>

## Available Tools

- **`analyze_video`** — run in the foreground, or return a job id with `background: true`
- **`video_analysis_job`** — poll status, progress, counts, optionally the full audit
- **`video_analysis_cancel`** — abort a running background job
- **`video_analysis_audit`** — read a finished audit by run id, section, ref or time window; see [Available Tools](docs/TOOLS.md) for parameters

## Documentation

| Guide | What it covers |
| --- | --- |
| [Documentation Index](docs/README.md) | Entry point for all documentation |
| [Installation](docs/INSTALLATION.md) | Prerequisites, setup, launch and verification |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, plugin options and precedence |
| [Usage](docs/USAGE.md) | Normal workflow and practical examples |
| [Architecture](docs/ARCHITECTURE.md) | Components, workflow and data flow |
| [Available Tools](docs/TOOLS.md) | Tool parameters, outputs and examples |
| [Transcription](docs/TRANSCRIPTION.md) | Engines, timestamps, cues and limits |
| [Audit System](docs/AUDIT-SYSTEM.md) | Storage, schema, sidecars and the audit reader |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Known setup and runtime issues |
| [Audit Viewer](explorer/README.md) | The single-file HTML explorer |

## Requirements

`ffmpeg` and `ffprobe` on `PATH`; a vision API key; an STT key (defaults to the
shared backend key); Node.js 22.6 or newer.

## License

**AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
Original author and copyright holder: **Mesum Raza**
([@mesumraza](https://github.com/mesumraza)). Free to use, study, share and
improve, provided derivatives stay open and credit the author. Closed-source or
paid use requires a commercial licence — see [`COMMERCIAL.md`](./COMMERCIAL.md).
Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the [`CLA.md`](./CLA.md) before
contributing. Nothing here is legal advice; the licence text governs.
