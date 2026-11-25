# Contributing

Thanks for taking the time. This project is intentionally small: two TypeScript
files, no build step, no framework. Most contributions are prompt design,
provider compatibility, and bug reports with a real video attached.

## Before you start

- Read [LICENSE](./LICENSE) (AGPL-3.0-or-later) and [CLA.md](./CLA.md).
  Contributions are accepted only under the CLA, because the project is
  dual-licensed and the author must be able to license your work both ways.
- For anything larger than a bug fix, open an issue first. A design discussion
  costs ten minutes; a rejected 500-line PR costs a weekend.
- Never open a public issue for a security problem — see [SECURITY.md](./SECURITY.md).

## Development setup

Requirements: Node 22.6+ (or Bun), `ffmpeg` and `ffprobe` on `PATH`, and an
API key for a Responses-shaped vision endpoint plus a transcriptions endpoint.

```bash
git clone https://github.com/mesumraza/opencode-video-analysis.git
cd opencode-video-analysis
cp -r . /path/to/your/project/.opencode/plugins/opencode-video-analysis
```

OpenCode hot-reloads the plugin when `index.ts` changes. Changing only a
constant (such as `PLUGIN_VERSION`) does **not** force a reload in every
version — changing the tool description does. If a change seems ignored, touch
the description or restart OpenCode.

There is no compiler step. Syntax-check before every push:

```bash
node --experimental-strip-types --check index.ts
node --experimental-strip-types --check transcription.ts
node scripts/check-package.mjs
```

These are exactly what CI runs.

## Testing a change

CI cannot call a paid model, so behaviour changes need a manual run. Include in
your PR:

- the command you ran (tool args, model, `transcribe` settings);
- for prompt or parsing changes, the media file's duration and whether it has
  audio;
- the relevant slice of the audit — `chain[]` for provider/ffmpeg behaviour,
  `segments[].transcript` for STT behaviour, `parsing.failures` for retries;
- for resume changes: cancel a job after the first chunk, re-run it, and report
  `resumed_from`, `chunks_reused`, `chunks_discarded`, final `status`, and the
  line counts of the `.timeline.jsonl` / `.transcript.jsonl` sidecars.

Redact API keys, private file paths, and anything personal in a video before
attaching it. Prefer a synthetic clip you can share.

## What fits this project

- provider compatibility (request shapes, response fallbacks, error mapping)
- container/codec coverage in ffmpeg and audio extraction
- transcription quality: cue grouping, word alignment, language handling
- registry matching and entity identity
- resume, checkpointing, sidecar integrity
- documentation that is currently wrong

What does not fit: hard-coding one genre or one provider, "defect" heuristics
that guess labels, telemetry of any kind, a build system.

## Code style

- TypeScript, ESM, no new runtime dependencies unless unavoidable.
- Match the surrounding style: `const` helpers above their use, explicit return
  types on exported functions, comments that explain *why* rather than *what*.
- Every new audit field must be additive and documented in `README.md`.
- Bump `SCHEMA_VERSION` for a breaking shape change, `PLUGIN_VERSION` for
  anything else, and add a `CHANGELOG.md` entry.
- Keep user-facing strings in English; translate prompts, not code.

## Pull requests

1. One topic per PR.
2. Include the CLA line (see below).
3. Describe the failure you saw before the fix — a reproduction is worth more
   than a description.
4. Update `README.md` and `CHANGELOG.md` in the same PR if behaviour changed.

Add this to the PR description:

```
I have read CLA.md and I accept it for this and future contributions.
```

`git commit -s` (DCO sign-off) is welcome as well, but the CLA line is what the
project actually needs.
