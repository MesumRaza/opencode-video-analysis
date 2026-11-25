#!/usr/bin/env node
/**
 * Exercises the audit reader the `video_analysis_audit` tool uses.
 *
 *   node --experimental-strip-types scripts/check-audit-reader.mjs [real-audit.json]
 *
 * With no argument it runs against the synthetic fixture plus the shipped
 * sidecars; with a path it also checks a real audit from disk.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECTION_NAMES,
  auditIndex,
  auditRunMeta,
  readSections,
  resolveSectionNames,
} from "../audit-reader.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const check = (name, ok, detail = "") => {
  if (!ok) problems.push(`${name}${detail ? ` (${detail})` : ""}`);
};

const load = (path) => {
  let raw = JSON.parse(readFileSync(path, "utf8"));
  // Storage and job records are sometimes double-encoded; unwrap until object.
  while (typeof raw === "string") raw = JSON.parse(raw);
  // An audit has its own `audit` section (timings, api, resume), so only treat
  // `.audit` as a wrapper when it is a full audit itself.
  return raw.audit && raw.audit.schema_version ? raw.audit : raw;
};

// ---------------------------------------------------------------- fixture
const fixture = load(resolve(root, "explorer/fixtures/schema15-demo.json"));
const idx = auditIndex(fixture);

check("index.status", idx.status === "completed", idx.status);
check("index.findings", idx.sections.findings.count === 3, String(idx.sections.findings.count));
check("index.findings by_kind", idx.sections.findings.by_kind.defect === 1, JSON.stringify(idx.sections.findings.by_kind));
check("index.scenes", idx.sections.scenes.count === 3, String(idx.sections.scenes.count));
check("index.entities", idx.sections.entities.count === 1);
check("index.transcript.cues", idx.sections.transcript.cues === 6, String(idx.sections.transcript.cues));
check("index.transcript.words", idx.sections.transcript.words === 42, String(idx.sections.transcript.words));
check("index.cue_sources", JSON.stringify(idx.sections.transcript.cue_sources) === '["grouped"]');
check("index.resume", idx.sections.resume?.chunks_reused === 1);

const meta = auditRunMeta(fixture, "audit/last", null);
check("run meta chunks", meta.chunks === "1/1", meta.chunks);

// section resolution
check("default sections", JSON.stringify(resolveSectionNames("index", undefined, false)) === '["overview","findings"]');
check("ref forces overview", JSON.stringify(resolveSectionNames("index", undefined, true)) === '["overview"]');
check("full sections", resolveSectionNames("full", undefined, false).length === SECTION_NAMES.length);
check("unknown section filtered", JSON.stringify(resolveSectionNames("index", ["nope", "scenes"], false)) === '["scenes"]');

// transcript, words off then on
const tr = readSections(fixture, ["transcript"]);
check("transcript cues returned", tr.transcript.cues_returned === 6, String(tr.transcript.cues_returned));
check("transcript omits words by default", tr.transcript.segments[0].cues.every((c) => !("words" in c)));
check("transcript hint present", typeof tr.transcript.hint === "string");

const trw = readSections(fixture, ["transcript"], { include_words: true });
const firstCue = trw.transcript.segments[0].cues[0];
check("words included on request", Array.isArray(firstCue.words) && firstCue.words.length > 0, String(firstCue.words?.length));
check("word triples", firstCue.words.every((w) => Array.isArray(w) && w.length === 3));

// window
const win = readSections(fixture, ["findings", "scenes"], { from_sec: 20, to_sec: 30 });
check("window findings", win.findings.matched === 2, String(win.findings.matched));
// 00:12.2–00:21 and 00:21–00:34 both intersect the 20–30 window.
check("window scenes", win.scenes.matched === 2, String(win.scenes.matched));

// refs
check("ref finding", readSections(fixture, ["overview"], { ref: "f1" }).ref?.kind === "finding");
check("ref finding by position", readSections(fixture, ["overview"], { ref: "f3" }).ref?.kind === "finding");
check("ref entity", readSections(fixture, ["overview"], { ref: "p1" }).ref?.kind === "entity");
const chunkRef = readSections(fixture, ["overview"], { ref: "chunk:1" }).ref;
check("ref chunk", chunkRef?.kind === "chunk" && chunkRef.segment?.chunk_index === 1 && chunkRef.chain?.chunk_index === 1);
check("ref unknown", readSections(fixture, ["overview"], { ref: "zzz" }).ref?.kind === "unknown");

// caps are reported, never silent
const capped = readSections(fixture, ["entities"]);
check("entity cap reported", typeof capped.entities.omitted === "number");

// ---------------------------------------------------------------- real audit
for (const arg of process.argv.slice(2)) {
  const path = resolve(process.cwd(), arg);
  const audit = load(path);
  const i = auditIndex(audit);
  const t = readSections(audit, ["transcript"], { include_words: true });
  const f = readSections(audit, ["findings"]);
  console.log(
    `real: ${audit.video?.filename} ${i.duration_sec}s ${i.sections.chunks.count} chunks ` +
      `cues=${i.sections.transcript.cues} words=${i.sections.transcript.words} ` +
      `findings=${f.findings.total} cue_sources=${JSON.stringify(i.sections.transcript.cue_sources)}`,
  );
  check("real: transcript segments", t.transcript.segments.length > 0);
  check("real: cues returned", t.transcript.cues_returned > 0, String(t.transcript.cues_returned));
  // Heuristic findings carry no id; the reader must still resolve them by position.
  const last = readSections(audit, ["overview"], { ref: "f2" }).ref;
  check("real: ref by position", last?.kind === "finding", JSON.stringify(last?.kind));
  check("real: every finding has a handle", f.findings.items.every((x) => typeof x.id === "string" && x.id.length > 0));
}

for (const p of problems) console.error(`fail ${p}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`\naudit reader ok — fixture ${idx.sections.transcript.cues} cues, ${idx.sections.findings.count} findings`);
