#!/usr/bin/env node
/**
 * Pre-flight checks for publishing this plugin.
 *
 * Run from the repository root:
 *   node scripts/check-package.mjs
 *
 * It fails (exit 1) when the package would not install or would install
 * something different from what the source claims: missing files, a version
 * that disagrees with the code, a licence that disagrees with LICENSE, or a
 * documented contract that has no implementation.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const ok = [];

const read = (p) => readFileSync(resolve(root, p), "utf8");

// ---------------------------------------------------------------- package
let pkg;
try {
  pkg = JSON.parse(read("package.json"));
} catch (e) {
  console.error(`package.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (!pkg.name) problems.push("package.json: missing name");
if (!pkg.version) problems.push("package.json: missing version");
if (pkg.type !== "module") problems.push('package.json: "type" must be "module"');
if (pkg.exports?.["."] !== "./index.ts") problems.push('package.json: exports["."] must be "./index.ts"');

const declaredLicense = pkg.license ?? "";
if (!declaredLicense.startsWith("AGPL-3.0")) {
  problems.push(`package.json: license is "${declaredLicense}", expected AGPL-3.0-or-later`);
}
if (!pkg.author) problems.push("package.json: missing author (attribution is a licence term)");
if (!pkg.repository) problems.push("package.json: missing repository");

// Every file the package promises must exist, and it must be a file.
for (const file of pkg.files ?? []) {
  const full = resolve(root, file);
  if (!existsSync(full)) problems.push(`package.json: files[] lists "${file}", which does not exist`);
  else if (!statSync(full).isFile()) problems.push(`package.json: files[] lists "${file}", which is not a file`);
}
for (const required of ["index.ts", "transcription.ts", "README.md", "LICENSE"]) {
  if (!pkg.files?.includes(required)) problems.push(`package.json: files[] must include "${required}"`);
}

// ---------------------------------------------------------------- versions
const index = read("index.ts");
const pick = (name) => index.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))?.[1];

const pluginVersion = pick("PLUGIN_VERSION");
const schemaVersion = pick("SCHEMA_VERSION");

if (!pluginVersion) problems.push("index.ts: PLUGIN_VERSION not found");
else if (pluginVersion !== pkg.version) {
  problems.push(`version mismatch: package.json ${pkg.version} vs PLUGIN_VERSION ${pluginVersion}`);
} else ok.push(`version ${pluginVersion}`);

if (!schemaVersion) problems.push("index.ts: SCHEMA_VERSION not found");
else ok.push(`schema ${schemaVersion}`);

// The README states the version; a stale claim is a documentation bug.
const readme = read("README.md");
if (pluginVersion && !readme.includes(pluginVersion)) {
  problems.push(`README.md does not mention the current plugin version (${pluginVersion})`);
}
if (schemaVersion && !readme.includes(schemaVersion)) {
  problems.push(`README.md does not mention the current schema version (${schemaVersion})`);
}

// ---------------------------------------------------------------- licence
const license = read("LICENSE");
if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
  problems.push("LICENSE does not contain the AGPL text");
}
for (const doc of ["NOTICE", "COMMERCIAL.md", "CLA.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
  if (!existsSync(resolve(root, doc))) problems.push(`missing ${doc}`);
}

// ---------------------------------------------------------------- imports
// Anything imported by index.ts from a relative path must ship with the package.
for (const match of index.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
  const spec = match[1].replace(/^\.\//, "");
  const candidate = spec.endsWith(".ts") ? spec : `${spec}.ts`;
  if (!existsSync(resolve(root, candidate))) problems.push(`index.ts imports "${match[1]}", which does not exist`);
  else if (!pkg.files?.includes(candidate)) problems.push(`index.ts imports "${candidate}", which files[] omits`);
}

// ---------------------------------------------------------------- report
for (const line of ok) console.log(`ok   ${line}`);
for (const line of problems) console.error(`fail ${line}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s). Fix before publishing.`);
  process.exit(1);
}
console.log("\npackage is internally consistent");
