[Project home](../README.md) · **Documentation index**

# Documentation

This directory is the central navigation point for `opencode-video-analysis`.
It documents the shipped implementation (plugin **2.7.0**, audit schema **1.5**):
what the plugin does, how a run is assembled, how to install and configure it,
and how to read the output.

If you are new to the project, read [Installation](INSTALLATION.md) and
[Usage](USAGE.md) first. For the report format, go straight to the
[Audit System](AUDIT-SYSTEM.md).

## Getting Started

| Page | What it covers |
| --- | --- |
| [Installation](INSTALLATION.md) | Prerequisites, cloning or package install, configuration, launch and verification |
| [Configuration](CONFIGURATION.md) | Environment variables, plugin options, precedence and defaults |
| [Usage](USAGE.md) | The normal workflow, input sources, examples and expected outputs |

## Technical Reference

| Page | What it covers |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Modules, components, chunking, continuity, entity registry and data flow |
| [Available Tools](TOOLS.md) | Every tool, parameter, output shape and example |
| [Transcription](TRANSCRIPTION.md) | STT engines, timestamps, cue construction, configuration and limits |
| [Audit System](AUDIT-SYSTEM.md) | Storage keys, disk exports, sidecars, schema 1.5 and the audit reader |

## Help and Related Material

| Page | What it covers |
| --- | --- |
| [Troubleshooting](TROUBLESHOOTING.md) | Verified setup and runtime issues, diagnostic fields and fixes |
| [Audit Viewer](../explorer/README.md) | The single-file HTML explorer for a finished audit |
| [Changelog](../CHANGELOG.md) | Release history and schema changes |
| [Contributing](../CONTRIBUTING.md) | Contribution process, CLA and repository conventions |

## Conventions

- All documentation uses relative links so it works in a clone and on GitHub.
- Commands are shown for a POSIX shell unless a section says otherwise. On
  PowerShell, set environment variables with `$env:NAME = "value"`.
- Version-specific statements refer to plugin 2.7.0 and schema 1.5. The
  [Changelog](../CHANGELOG.md) records earlier behaviour.
- Code shown in examples is tool input, not a second API.

---

[Back to the project README](../README.md)
