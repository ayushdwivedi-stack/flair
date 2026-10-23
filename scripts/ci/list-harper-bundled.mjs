#!/usr/bin/env node
/**
 * list-harper-bundled.mjs — print the packages harper ships in its own tree.
 *
 * Since 5.3.2 harper publishes its production dependencies as a bundle
 * (`bundleDependencies`) instead of an `npm-shrinkwrap.json`. Those copies sit
 * under `node_modules/harper/node_modules`, where they resolve ahead of the
 * root tree: root overrides do not replace them in a bun install either, and
 * `bun audit` reads only `bun.lock`, so it does not report them. This prints
 * the installed copies so a reviewer can see what harper's runtime loads.
 *
 * Usage:
 *   node scripts/ci/list-harper-bundled.mjs [node_modules dir]
 *
 * Default dir: <repo>/node_modules. Prints one line per installed copy
 * (`<name>@<version>  <path under harper/node_modules>`), then the count.
 *
 * Exit codes:
 *   0 — harper is installed, declares a bundle, and every copy was read.
 *   2 — DID NOT RUN: harper or its manifest is unreadable, it declares no
 *       bundleDependencies, or an installed package's manifest is unreadable.
 *       Never 0 for a tree this script could not measure.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readManifest(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
  if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string") {
    throw new Error(`${file} has no string name and version`);
  }
  return manifest;
}

/** Installed packages under one node_modules directory, including nested copies. */
function walk(nodeModules, dir, seen, copies) {
  if (!existsSync(dir)) return;
  let real;
  try {
    real = realpathSync(dir);
  } catch (e) {
    throw new Error(`cannot resolve ${dir}: ${e.message}`);
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read ${dir}: ${e.message}`);
  }
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const names = entry.name.startsWith("@")
      ? readdirSync(full, { withFileTypes: true }).map((child) => join(full, child.name))
      : [full];
    for (const packageDir of names) {
      let isDir = false;
      try {
        isDir = statSync(packageDir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const manifestPath = join(packageDir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readManifest(manifestPath);
      copies.push({ name: manifest.name, version: manifest.version, path: relative(nodeModules, packageDir) });
      walk(nodeModules, join(packageDir, "node_modules"), seen, copies);
    }
  }
}

/**
 * Read harper's installed package.json and the copies under its node_modules.
 * Throws when either is missing or unreadable; callers turn that into exit 2.
 */
export function listBundledCopies(nodeModulesDir) {
  const harperDir = join(nodeModulesDir, "harper");
  const manifest = readManifest(join(harperDir, "package.json"));
  const declared = manifest.bundleDependencies ?? manifest.bundledDependencies;
  let declaredNames;
  if (declared === true) {
    declaredNames = Object.keys(manifest.dependencies ?? {});
  } else if (Array.isArray(declared)) {
    declaredNames = declared.filter((name) => typeof name === "string" && name);
  } else {
    throw new Error(`harper ${manifest.version} declares no bundleDependencies`);
  }
  const bundledDir = join(harperDir, "node_modules");
  let hasBundledDir = false;
  try {
    hasBundledDir = statSync(bundledDir).isDirectory();
  } catch {
    hasBundledDir = false;
  }
  if (!hasBundledDir) throw new Error(`harper ${manifest.version} has no ${bundledDir}`);
  const copies = [];
  walk(bundledDir, bundledDir, new Set(), copies);
  if (copies.length === 0) throw new Error(`no installed packages under ${bundledDir}`);
  copies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { harperVersion: manifest.version, declared: declaredNames, copies, bundledDir };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    console.error("usage: list-harper-bundled.mjs [node_modules dir]");
    return 2;
  }
  const nodeModulesDir = resolve(argv[0] ?? join(REPO_ROOT, "node_modules"));
  try {
    const { harperVersion, declared, copies, bundledDir } = listBundledCopies(nodeModulesDir);
    console.log(`harper ${harperVersion} declares ${declared.length} bundled package names; ${copies.length} copies installed under ${bundledDir}:`);
    for (const copy of copies) console.log(`  ${copy.name}@${copy.version}  ${copy.path}`);
    console.log(`${copies.length} bundled copies.`);
    return 0;
  } catch (e) {
    console.error(`harper bundled copies: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
