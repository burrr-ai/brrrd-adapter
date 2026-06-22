#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function hasOnlyBuiltDependencies(pnpm) {
  return (
    pnpm
    && Array.isArray(pnpm.onlyBuiltDependencies)
    && pnpm.onlyBuiltDependencies.length > 0
  );
}

function removeTopLevelYamlBlock(source, key) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (!match || match[2] !== key) {
      out.push(line);
      index += 1;
      continue;
    }

    const indent = match[1].length;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === "") {
        index += 1;
        continue;
      }
      const nextIndent = next.match(/^(\s*)/)?.[1].length ?? 0;
      if (nextIndent <= indent) break;
      index += 1;
    }
  }
  return out.join("\n");
}

export function normalizePnpmBuildPolicy(cwd = process.cwd()) {
  const packageJsonPath = path.join(cwd, "package.json");
  let sawOnlyBuiltDependencies = false;

  if (fs.existsSync(packageJsonPath)) {
    const pkg = readJson(packageJsonPath);
    if (hasOnlyBuiltDependencies(pkg.pnpm)) {
      sawOnlyBuiltDependencies = true;
      if (Object.hasOwn(pkg.pnpm, "neverBuiltDependencies")) {
        delete pkg.pnpm.neverBuiltDependencies;
        writeJson(packageJsonPath, pkg);
      }
    }
  }

  const workspacePath = path.join(cwd, "pnpm-workspace.yaml");
  if (fs.existsSync(workspacePath)) {
    const source = fs.readFileSync(workspacePath, "utf8");
    const workspaceHasOnly = /^\s*onlyBuiltDependencies\s*:/m.test(source);
    if (sawOnlyBuiltDependencies || workspaceHasOnly) {
      const next = removeTopLevelYamlBlock(source, "neverBuiltDependencies");
      if (next !== source) {
        fs.writeFileSync(workspacePath, next);
      }
    }
  }
}

export function projectHasOnlyBuiltDependencies(cwd = process.cwd()) {
  const packageJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const pkg = readJson(packageJsonPath);
    if (hasOnlyBuiltDependencies(pkg.pnpm)) return true;
  }

  const workspacePath = path.join(cwd, "pnpm-workspace.yaml");
  if (fs.existsSync(workspacePath)) {
    const source = fs.readFileSync(workspacePath, "utf8");
    return /^\s*onlyBuiltDependencies\s*:/m.test(source);
  }

  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--has-only-built-dependencies")) {
    process.exit(projectHasOnlyBuiltDependencies() ? 0 : 1);
  }
  normalizePnpmBuildPolicy();
}
