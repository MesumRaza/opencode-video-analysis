# Security policy

## Supported versions

Only the latest release on `main` is supported. Fixes are not backported; the
plugin is a single directory and upgrading is a file copy.

| Version | Supported |
| --- | --- |
| 2.6.x | yes |
| < 2.6 | no |

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private advisory flow:
<https://github.com/mesumraza/opencode-video-analysis/security/advisories/new>

If that is unavailable, open an issue that says only “security: please contact
me” and no details, and the maintainer will reply with a private channel.

Please include: affected version, a minimal reproduction, and what an attacker
gains. Expect an acknowledgement within 7 days and a fix or a written assessment
within 30. Credit is given in `CHANGELOG.md` unless you ask otherwise.

## Threat model — what is worth attacking

This plugin runs inside the OpenCode server process with the user's privileges,
shells out to `ffmpeg`/`ffprobe`, sends video frames and audio to third-party
APIs, and writes JSON to disk. The realistic issues are:

1. **Command injection** via `video_path`, `audit_dir`, or a crafted filename.
   Paths are passed as `execFile` argv (never a shell string); any change that
   reintroduces a shell, `exec`, or string interpolation into a command is a
   vulnerability.
2. **Path traversal / arbitrary write** through `audit_dir`, `VIDEO_ANALYSIS_AUDIT_DIR`
   or the derived `<name>-<hash8>` file names.
3. **Key disclosure.** API keys are read from the environment or plugin options
   and must never appear in the audit, the brief, a log line, an error message,
   or a sidecar file. `api_key_source` is a label, never a value.
4. **Server-side request forgery.** `https://` inputs are handed to the model
   provider as a URL and to `ffprobe`; a URL that resolves to an internal host
   must not be fetched by this plugin itself.
5. **Malicious media.** A crafted container that crashes `ffmpeg`, exhausts
   memory, or writes outside the per-run temp directory. Chunk windows are cut
   into a `mkdtemp` directory that is removed in `finish()`; a crash must not
   leave work directories behind.
6. **Audit poisoning.** Third-party text (transcripts, on-screen text, model
   output) is untrusted data. It is stored and displayed, never executed, and
   never treated as instructions by the plugin.

## Out of scope

- The accuracy, availability or pricing of third-party models.
- Cost incurred by a run you started.
- What a model does with the media you send it — that is the provider's policy,
  not this plugin's.
- Secrets committed to your own `.env` or `opencode.jsonc`.

## Hardening checklist for deployments

- Use a key with a spending limit; the STT endpoint is paid per second.
- Prefer `audit_dir` over committing audit files; they contain transcripts.
- Do not point `audit_dir` at a directory served by a web server.
- Run untrusted media through your own sandbox, not a production host.
