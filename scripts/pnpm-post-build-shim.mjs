#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readPackageJson(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
}

function delegate(args) {
  const realPnpm = process.env.BRRRD_REAL_PNPM;
  if (!realPnpm) {
    console.error("[brrrd-harness] real pnpm binary was not provided");
    process.exit(1);
  }
  const result = spawnSync(realPnpm, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const pkg = readPackageJson(process.cwd());
const packageManager = String(pkg?.packageManager || "");
const postBuild = pkg?.scripts?.["post-build"];

if (
  args.length === 1
  && args[0] === "post-build"
  && postBuild
  && !packageManager.startsWith("pnpm@")
) {
  const env = { ...process.env };
  env.PATH = [
    path.join(process.cwd(), "node_modules", ".bin"),
    process.env.PATH || "",
  ].join(path.delimiter);
  const result = spawnSync(postBuild, {
    shell: true,
    stdio: "inherit",
    env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

delegate(args);
