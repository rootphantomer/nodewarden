#!/usr/bin/env node
/**
 * Builds the EdgeOne Makers deployment bundle.
 *
 * Emits one self-contained ESM function file per backend namespace catch-all
 * plus the exact-path functions. All outputs share the same entry bundle
 * (src/main-edgeone.ts) because the server itself routes by URL pathname;
 * the per-path files exist purely so EdgeOne's file-based routing dispatches
 * backend requests into the Node runtime while static files continue to be
 * served for everything else.
 *
 * `mysql2` stays external (declared via edgeone.json externalNodeModules).
 * `cloudflare:workers` is aliased to an inert shim: the Durable Object
 * classes survive in the graph but are never instantiated on this platform.
 */
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CATCH_ALL_NAMESPACES = [
  'api',
  'identity',
  'icons',
  'fill-assist',
  'notifications',
  'devices',
  'auth-requests',
  'webauthn',
  '.well-known',
];

const EXACT_FUNCTION_PATHS = [
  ['config.js', 'config'],
  ['web-bootstrap.js', 'web-bootstrap'],
  ['accounts/kdf.js', 'accounts/kdf'],
  ['settings/domains.js', 'settings/domains'],
  ['v1/assetlinks:check.js', 'v1/assetlinks:check'],
];

const functionsRoot = path.join(root, 'cloud-functions');

await rm(functionsRoot, { recursive: true, force: true });

const targets = [
  ...CATCH_ALL_NAMESPACES.map((namespace) => [path.join(namespace, '[[default]].js')]),
  ...EXACT_FUNCTION_PATHS.map(([outfile]) => [outfile]),
];

const commonOptions = {
  entryPoints: [path.join(root, 'src/main-edgeone.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  charset: 'utf8',
  legalComments: 'none',
  external: ['mysql2', '@edgeone/pages-blob'],
  alias: {
    'cloudflare:workers': path.join(root, 'src/platform/shims/cloudflare-workers.ts'),
  },
  minify: false,
  sourcemap: false,
  logLevel: 'error',
};

for (const [outfile] of targets) {
  await mkdir(path.dirname(path.join(functionsRoot, outfile)), { recursive: true });
  await build({ ...commonOptions, outfile: path.join(functionsRoot, outfile) });
}

console.log(`edgeone: built ${targets.length} function entry files into cloud-functions/`);
