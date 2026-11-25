#!/usr/bin/env node
/**
 * Validates the fixture the explorer opens by default, and optionally any real
 * audit handed to it. Fails when a shape the viewer relies on has drifted.
 *
 *   node scripts/check-viewer.mjs
 *   node scripts/check-viewer.mjs path/to/real.audit.json
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(root, "explorer/fixtures/schema15-demo.json");
const problems = [];

const inspect = (label, audit) => {
  const need = (name, ok, detail = "") => {
    if (!ok) problems.push(`${label}: ${name}${detail ? ` (${detail})` : ""}`);
  };

  need("schema_version", typeof audit.schema_version === "string", audit.schema_version);
  need("plugin.id", Boolean(audit.plugin?.id), audit.plugin?.id);
  need("status", typeof audit.status === "string", audit.status);
  need("video.duration_sec", Number(audit.video?.duration_sec) > 0, String(audit.video?.duration_sec));
  need("scenes[]", Array.isArray(audit.scenes) && audit.scenes.length > 0);
  need("scenes monotonic", (audit.scenes ?? []).every((s) => s.end_sec >= s.start_sec));
  need("entities[]", Array.isArray(audit.entities) && audit.entities.length > 0);
  need("entity appearances", (audit.entities ?? []).every((e) => (e.appearances?.length ?? 0) > 0));
  need("findings[]", Array.isArray(audit.overall?.findings) && audit.overall.findings.length > 0);
  need("findings at_sec", audit.overall.findings.some((f) => typeof f.at_sec === "number"));
  need("parsing.coverage", typeof audit.parsing?.coverage?.coverage_percent === "number");
  need("chain[]", Array.isArray(audit.chain) && audit.chain.length > 0);

  const cues = (audit.segments ?? []).flatMap((s) => s.transcript?.cues ?? []);
  need("cues[] present", cues.length > 0);
  need("cue word triples", cues.some((c) => Array.isArray(c.words) && c.words.every((w) => w.length === 3)));
  need(
    "cue_source in {grouped,provider,text}",
    ["grouped", "provider", "text"].includes(audit.segments?.[0]?.transcript?.cue_source),
    audit.segments?.[0]?.transcript?.cue_source,
  );
  return { cues: cues.length, words: cues.reduce((n, c) => n + (c.words?.length ?? 0), 0) };
};

// 1. the shipped fixture
const wrapper = JSON.parse(readFileSync(fixturePath, "utf8"));
const fixture = wrapper.audit ?? wrapper;
if (!wrapper.synthetic) problems.push("fixture: not marked synthetic (it must never look like real footage analysis)");
const fx = inspect("fixture", fixture);

// 2. the HTML must point at that fixture, never at a local artifact path
const html = readFileSync(resolve(root, "explorer/index.html"), "utf8");
const m = html.match(/const DEFAULT_AUDIT = "([^"]+)"/);
if (!m) problems.push("explorer/index.html: DEFAULT_AUDIT not found");
else {
  const target = resolve(root, "explorer", m[1]);
  if (!existsSync(target)) problems.push(`explorer/index.html: DEFAULT_AUDIT "${m[1]}" does not resolve`);
  if (/[A-Za-z]:[\\/]|\/Users\/|\/home\//.test(m[1])) problems.push("explorer/index.html: DEFAULT_AUDIT contains an absolute path");
}

// 3. any extra audit passed on the command line
for (const arg of process.argv.slice(2)) {
  const p = resolve(process.cwd(), arg);
  if (!existsSync(p)) {
    problems.push(`${arg}: not found`);
    continue;
  }
  const payload = JSON.parse(readFileSync(p, "utf8"));
  const audit = payload.audit?.schema_version ? payload.audit : payload;
  const res = inspect(arg, audit);
  console.log(`checked ${arg}: ${audit.segments?.length ?? 0} segments, ${res.cues} cues, ${res.words} words`);
}

for (const p of problems) console.error(`fail ${p}`);
if (problems.length) process.exit(1);
console.log(`\nviewer ok — fixture: ${fx.cues} cues, ${fx.words} words, ${fixture.scenes.length} scenes`);
