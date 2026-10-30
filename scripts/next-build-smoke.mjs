import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundler = process.argv[2] ?? 'turbopack';
assert.ok(['webpack', 'turbopack'].includes(bundler), 'Expected webpack or turbopack');
const projectDir = mkdtempSync(path.join(root, '.next-build-smoke-'));
function write(relative, source) {
  const file = path.join(projectDir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
}

try {
  mkdirSync(path.join(projectDir, 'node_modules'));
  const nextRequire = createRequire(require.resolve('next/package.json'));
  const dependencies = {};
  for (const name of ['next', 'react', 'react-dom']) {
    const packageFile = nextRequire.resolve(`${name}/package.json`);
    symlinkSync(path.dirname(packageFile), path.join(projectDir, 'node_modules', name), 'dir');
    dependencies[name] = JSON.parse(readFileSync(packageFile, 'utf8')).version;
  }
  write('package.json', JSON.stringify({ name: 'brrrd-next-smoke', private: true, dependencies }));
  write('next.config.mjs', `export default ${JSON.stringify({
    adapterPath: path.join(root, 'dist/index.js'),
    cacheComponents: true,
    outputFileTracingRoot: root,
    turbopack: { root },
    experimental: { cpus: 2 },
  })};`);
  write('app/layout.jsx', 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }');
  write('app/page.jsx', 'export default function Page() { return <main>static document</main>; }');
  write('app/ppr/page.jsx', `
    import { Suspense } from 'react';
    import { connection } from 'next/server';
    async function Dynamic() { await connection(); return <p>runtime document</p>; }
    export default function Page() { return <Suspense fallback={<p>shell</p>}><Dynamic /></Suspense>; }
  `);
  const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', `--${bundler}`], {
    cwd: projectDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Next ${bundler} build failed`);

  const outDir = path.join(projectDir, 'dist/brrrd');
  const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.build.nextVersion, require('next/package.json').version);
  const seeds = manifest.artifacts.filter((artifact) => artifact.mountPath.startsWith('.next/server/route-cache/'));
  assert.ok(seeds.some((artifact) => artifact.mountPath.endsWith('.html')));
  assert.ok(seeds.some((artifact) => artifact.mountPath.endsWith('.rsc')));
  assert.ok(seeds.some((artifact) => artifact.mountPath.endsWith('.meta')));
  for (const artifact of seeds) readFileSync(path.join(outDir, artifact.packagePath));
  const rsc = manifest.routes.find((route) => route.type === 'static' && route.file === '/index.rsc');
  assert.ok(rsc, 'Public RSC route must use the URL, not the owner-scoped disk path');
  assert.ok(readFileSync(path.join(outDir, 'static', rsc.file)).length);
  const document = manifest.routes.find((route) => new RegExp(route.pattern).test('/ppr'));
  assert.equal(document?.type, 'page', 'PPR documents must select the complete runtime handler');
  assert.equal(document.pprResume, undefined);
  assert.ok(manifest.routes.some((route) => route.type === 'page'
    && new RegExp(route.pattern).test('/ppr.rsc') && route.pprResume));
  console.log(`Next ${manifest.build.nextVersion} ${bundler} packaging smoke passed`);
} finally {
  rmSync(projectDir, { recursive: true, force: true });
}
