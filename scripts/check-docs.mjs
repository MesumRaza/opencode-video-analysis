#!/usr/bin/env node
/**
 * Validates every Markdown file in the repository: relative links and image
 * paths must resolve, fences must balance, and heading anchors used inside the
 * same file must exist.
 *
 *   node scripts/check-docs.mjs
 *
 * Deliberately offline: external http(s) links are not fetched, because CI
 * should fail on broken repo links, not on a vendor's outage.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const files = walk(root).sort();
const problems = [];
let links = 0;
let anchors = 0;
let images = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");
  const ownAnchors = new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])),
  );

  if (((text.match(/^```/gm) ?? []).length) % 2 !== 0) {
    problems.push(`${rel}: unbalanced code fences`);
  }

  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|data:|#)/i.test(target)) {
      if (target.startsWith("#")) {
        anchors++;
        const id = target.slice(1).toLowerCase();
        if (!ownAnchors.has(id)) problems.push(`${rel}: missing anchor ${target}`);
      }
      continue;
    }
    if (m[0].startsWith("!")) images++;
    else links++;

    const [pathPart, anchor] = target.split("#");
    const resolved = resolve(dirname(file), decodeURI(pathPart));
    if (!existsSync(resolved)) {
      problems.push(`${rel}: broken link ${target}`);
      continue;
    }

    if (anchor && resolved.endsWith(".md") && statSync(resolved).isFile()) {
      anchors++;
      const targetText = readFileSync(resolved, "utf8");
      const targetAnchors = new Set(
        [...targetText.matchAll(/^#{1,6}\s+(.+)$/gm)].map((x) => slug(x[1])),
      );
      if (!targetAnchors.has(anchor.toLowerCase())) {
        problems.push(`${rel}: missing anchor ${target}`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`fail ${p}`);
  console.error(`\n${problems.length} problem(s) across ${files.length} files`);
  process.exit(1);
}

console.log(`docs ok — ${files.length} files, ${links} links, ${images} images, ${anchors} anchors`);
