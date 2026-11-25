<!--
  Keep the first section. Delete the rest if a section does not apply.
-->

## What this changes

<!-- One paragraph. What was broken or missing, and what the patch does. -->

## Why

<!-- The failure mode, ideally with a reproduction or an audit slice. -->

## Evidence

<!--
  Paste only what proves the change: the audit fields, the line counts of the
  sidecars, or the exact command you ran. Never paste an API key.
-->

## Checklist

- [ ] `node --experimental-strip-types --check index.ts` passes
- [ ] `node --experimental-strip-types --check transcription.ts` passes
- [ ] `node scripts/check-package.mjs` passes
- [ ] `README.md` updated if a field, argument or behaviour changed
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] `PLUGIN_VERSION` bumped, `SCHEMA_VERSION` bumped too if the audit shape changed
- [ ] Ran a real video end to end (paste the result above)
- [ ] Resume re-checked if checkpointing, sidecars or `finish()` changed
- [ ] No API keys, tokens, personal data or private file paths in this PR

## Licence

- [ ] I have read `CLA.md` and I accept it for this and future contributions.

<!-- Required. The project is dual-licensed under AGPL-3.0-or-later and a
     commercial licence; the author needs the relicensing right to keep both
     offers valid. -->
