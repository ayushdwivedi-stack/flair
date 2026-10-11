#!/usr/bin/env node
// Structural regression check for the CodeQL Action major group (flair#1937).
// Run: node scripts/check-renovate-preset-rules.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CODEQL = "github/codeql-action";
const isCodeqlRule = (rule) =>
  rule.matchPackageNames?.some((name) => name.startsWith(CODEQL));
const isMajorsRule = (rule) =>
  rule.groupName === null && rule.matchUpdateTypes?.includes("major");

function checkPreset(preset) {
  const rules = preset.packageRules;
  assert.ok(Array.isArray(rules), "packageRules must be an array");
  const codeqlRules = rules.filter(isCodeqlRule);
  assert.equal(codeqlRules.length, 1, "one CodeQL Action rule must exist");
  const [codeql] = codeqlRules;
  assert.deepEqual(codeql.matchManagers, ["github-actions"], "CodeQL manager");
  assert.deepEqual(
    codeql.matchPackageNames,
    [CODEQL, `${CODEQL}/**`],
    "CodeQL base action and every sub-action must be named without other packages",
  );
  assert.deepEqual(codeql.matchUpdateTypes, ["major"], "CodeQL updates must be major only");
  assert.equal(codeql.groupName, CODEQL, "CodeQL majors must share the group name");
  const majorsIndex = rules.findLastIndex(isMajorsRule);
  assert.ok(majorsIndex >= 0, "the ungrouping majors rule must exist");
  assert.ok(rules.indexOf(codeql) > majorsIndex, "CodeQL rule must follow the majors rule");
}

const preset = JSON.parse(readFileSync(new URL("../.github/renovate-preset.json", import.meta.url), "utf8"));
checkPreset(preset);
console.log("PASS CodeQL Action major group structure");

for (const [name, mutate] of [
  ["remove the CodeQL rule", (rules) => {
    rules.splice(rules.findIndex(isCodeqlRule), 1);
  }],
  ["move the CodeQL rule before the majors rule", (rules) => {
    const [codeql] = rules.splice(rules.findIndex(isCodeqlRule), 1);
    rules.splice(rules.findIndex(isMajorsRule), 0, codeql);
  }],
  ["widen CodeQL matchUpdateTypes", (rules) => {
    rules.find(isCodeqlRule).matchUpdateTypes.push("minor");
  }],
]) {
  const mutated = structuredClone(preset);
  mutate(mutated.packageRules);
  assert.throws(() => checkPreset(mutated), assert.AssertionError, `mutation must fail: ${name}`);
  console.log(`PASS mutation rejected: ${name}`);
}
