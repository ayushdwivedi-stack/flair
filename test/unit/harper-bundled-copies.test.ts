/**
 * The harper 5.3.2+ bundle sits under node_modules/harper/node_modules, where a
 * root override does not reach it and bun audit cannot see it. These tests pin
 * the listing a reviewer reads, and that an unmeasurable tree exits 2 — never 0.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listBundledCopies, main } from "../../scripts/ci/list-harper-bundled.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "harper-bundled-"));
  roots.push(root);
  for (const [rel, manifest] of Object.entries(files)) {
    const file = join(root, "node_modules", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
  return root;
}

const harper = (extra: Record<string, unknown> = {}) => ({ name: "harper", version: "5.3.3", ...extra });

describe("harper's bundled copies", () => {
  test("lists top-level, scoped and nested copies with their versions", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify", "@fastify/static", "fast-uri"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
      "harper/node_modules/fastify/node_modules/fast-uri/package.json": { name: "fast-uri", version: "4.2.1" },
      "harper/node_modules/@fastify/static/package.json": { name: "@fastify/static", version: "9.3.0" },
      "harper/node_modules/fast-uri/package.json": { name: "fast-uri", version: "3.1.0" },
    });
    const listing = listBundledCopies(join(root, "node_modules"));
    expect(listing.harperVersion).toBe("5.3.3");
    expect(listing.declared).toEqual(["fastify", "@fastify/static", "fast-uri"]);
    expect(listing.copies.map((copy) => `${copy.name}@${copy.version}`)).toEqual([
      "@fastify/static@9.3.0",
      "fast-uri@3.1.0",
      "fastify@5.12.5",
      "fast-uri@4.2.1",
    ]);
  });

  test("bundleDependencies true means harper's dependencies", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: true, dependencies: { fastify: "^5.8.2" } }),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    expect(listBundledCopies(join(root, "node_modules")).declared).toEqual(["fastify"]);
  });

  test("a harper without bundleDependencies exits 2 and says so", () => {
    const root = fixture({
      "harper/package.json": harper(),
      "harper/node_modules/fastify/package.json": { name: "fastify", version: "5.12.5" },
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("declares no bundleDependencies");
  });

  test("a missing harper tree exits 2", () => {
    const root = fixture({ "unrelated/package.json": { name: "unrelated", version: "1.0.0" } });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/harper/);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(String(message));
    try {
      expect(main([join(root, "node_modules")])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("harper bundled copies:");
  });

  test("an installed copy without a readable manifest exits 2", () => {
    const root = fixture({
      "harper/package.json": harper({ bundleDependencies: ["fastify"] }),
      "harper/node_modules/fastify/package.json": { name: "fastify" },
    });
    expect(() => listBundledCopies(join(root, "node_modules"))).toThrow(/no string name and version/);
  });
});
