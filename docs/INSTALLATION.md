[Documentation index](README.md) · [Project home](../README.md)

# Installation

This guide installs the plugin into OpenCode and verifies that a run can reach
the vision backend and `ffmpeg`. It reflects plugin **2.7.0**.

## Prerequisites

| Requirement | Why it is needed | Check |
| --- | --- | --- |
| OpenCode | Hosts the plugin and exposes its tools | Start OpenCode normally |
| Node.js 22.6 or newer | The package declares `engines.node >= 22.6` and strips TypeScript types at runtime | `node --version` |
| `ffmpeg` | Cuts video windows and extracts audio | `ffmpeg -version` |
| `ffprobe` | Reads duration, dimensions, frame rate and audio presence | `ffprobe -version` |
| Vision API key | Authenticates the OpenAI Responses-shaped backend | Set one of the key variables below |
| STT API key | Transcribes audio; defaults to the shared vision/backend key | Same as above, or set an STT-specific key |

Both `ffmpeg` and `ffprobe` must be resolvable on `PATH`. The plugin has no
native Node dependencies; the only runtime package dependency is
`@opencode/plugin`.

## Install

### Option A — clone into the plugin directory

From the root of the project where you use OpenCode:

```bash
git clone https://github.com/mesumraza/opencode-video-analysis.git \
  .opencode/plugins/opencode-video-analysis
```

OpenCode loads plugins from this directory at start. Editing `index.ts`
hot-reloads the plugin while OpenCode is running.

### Option B — install from a package source

Add the package to the `plugin` array in `opencode.json` when it is available
from your configured package source:

```jsonc
{
  "plugin": ["opencode-video-analysis"]
}
```

The package exposes `./index.ts`, so the installed package contains the same
entry point as the cloned directory.

## Provide credentials

The vision backend reads its key in this order:

1. plugin option `apiKey`
2. `VIDEO_ANALYSIS_API_KEY`
3. `OPENROUTER_API_KEY`

The STT service uses `transcribe.apiKey`, then
`VIDEO_ANALYSIS_TRANSCRIBE_API_KEY`, then `VIDEO_ANALYSIS_API_KEY`, then
`OPENROUTER_API_KEY`. A run with no key fails with a message naming the provider
and the variables to set.

PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "sk-or-..."
```

POSIX shell:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Prefer plugin options when you do not want the key in the process environment:

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "apiKey": "sk-or-...",
      "model": "nvidia/nemotron-3.5-super-vl:free"
    }
  }
}
```

## Configure the plugin

Options live under the plugin name in `opencode.json` (or `opencode.jsonc`).
A minimal setup only needs credentials; the defaults work without this block.

```jsonc
{
  "plugin": {
    "opencode-video-analysis": {
      "auditDir": "artifacts/audits"
    }
  }
}
```

`auditDir` is resolved against the OpenCode server's working directory, not
necessarily the project you are editing. An explicit `audit_dir` on a tool call
overrides it. To disable disk exports entirely, set `auditFiles: false` or
`VIDEO_ANALYSIS_AUDIT_FILES=off`.

See [Configuration](CONFIGURATION.md) for every option and its precedence.

## Launch and verify

1. Start or restart OpenCode in your project.
2. Confirm the tools are registered: `analyze_video`,
   `video_analysis_job`, `video_analysis_cancel`, `video_analysis_audit`.
3. Run a short analysis on a video you have available:

```ts
analyze_video({
  video_path: "demo.mp4",
  prompt: "Describe what happens."
})
```

A successful response reports `status: "completed"` (or
`"completed_with_errors"` for partial coverage), a summary, and an audit path
in `audit.file`. Open that file to confirm the disk export, or query the same
run in-context:

```ts
video_analysis_audit({ detail: "index" })
```

If the call fails, inspect the message and the audit's `input.provider` block,
then see [Troubleshooting](TROUBLESHOOTING.md).

## Optional: open the audit viewer

The HTML explorer is a static page. Serve a directory that contains both the
plugin and your audits, then pass the audit path from `audit.file`:

```bash
node .opencode/plugins/opencode-video-analysis/scripts/serve.mjs . 8766
```

```text
http://127.0.0.1:8766/.opencode/plugins/opencode-video-analysis/explorer/?audit=/audit-output/<name>-<hash8>.audit.json
```

With no `?audit=` parameter the viewer opens a synthetic fixture, so it works on
a fresh clone. See [the explorer guide](../explorer/README.md).

## Updating

For a cloned install, pull the latest source in the plugin directory and restart
OpenCode:

```bash
git -C .opencode/plugins/opencode-video-analysis pull
```

Storage keys are scoped by plugin id. Audits written by a different plugin id
are not listed by the job tools, but exported files remain readable in the
explorer.

## Related Documentation

- [Configuration](CONFIGURATION.md) · [Usage](USAGE.md)
- [Troubleshooting](TROUBLESHOOTING.md) · [Audit System](AUDIT-SYSTEM.md)

---

[Documentation index](README.md) · [Project home](../README.md)
