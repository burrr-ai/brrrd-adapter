#!/usr/bin/env node

const validName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const blockedExact = new Set([
  "ADAPTER_DIR",
  "BRRRD_BIN",
  "HOME",
  "LOGNAME",
  "NODE_OPTIONS",
  "OLDPWD",
  "PACKAGE_MANAGER",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const blockedPrefixes = [
  "ACTIONS_",
  "BRRRD_",
  "CI",
  "COREPACK_",
  "GITHUB_",
  "NEXT_ADAPTER_",
  "NEXT_E2E_",
  "NEXT_EXTERNAL_",
  "NEXT_PRIVATE_",
  "NEXT_RUNTIME",
  "NEXT_TELEMETRY_",
  "NEXT_TEST_",
  "NPM_",
  "PNPM_",
  "RUNNER_",
  "YARN_",
  "__NEXT_",
  "npm_",
];

export function shouldForwardRuntimeEnv(key) {
  if (!validName.test(key) || blockedExact.has(key)) return false;
  return !blockedPrefixes.some((prefix) => key.startsWith(prefix));
}

export function forwardedBrrrdEnvAssignments(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => shouldForwardRuntimeEnv(key) && value != null)
    .map(([key, value]) => `BRRRD_ENV_${key}=${value}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const assignment of forwardedBrrrdEnvAssignments()) {
    process.stdout.write(`${assignment}\0`);
  }
}
