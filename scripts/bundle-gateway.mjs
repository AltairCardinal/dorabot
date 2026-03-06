#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const gatewayBundle = join(root, 'desktop', 'resources', 'gateway');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const platform = argValue('--platform', process.env.BUNDLE_PLATFORM || process.platform);
const arch = argValue('--arch', process.env.BUNDLE_ARCH || process.arch);

function run(command, args, cwd) {
  const r = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${r.status ?? 'unknown'}`);
  }
}

function rmIfExists(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function pruneCodexVendor(bundleDir, targetPlatform, targetArch) {
  const vendorDir = join(bundleDir, 'node_modules', '@openai', 'codex-sdk', 'vendor');
  if (!existsSync(vendorDir)) return;

  const keepByTarget = {
    darwin: {
      arm64: ['aarch64-apple-darwin'],
      x64: ['x86_64-apple-darwin'],
      universal: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
    },
    win32: {
      arm64: ['aarch64-pc-windows-msvc'],
      x64: ['x86_64-pc-windows-msvc'],
    },
    linux: {
      arm64: ['aarch64-unknown-linux-musl'],
      x64: ['x86_64-unknown-linux-musl'],
    },
  };

  const keep = keepByTarget[targetPlatform]?.[targetArch] || [];
  if (keep.length === 0) return;

  for (const entry of readdirSync(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!keep.includes(entry.name)) {
      rmSync(join(vendorDir, entry.name), { recursive: true, force: true });
      console.log(`    removed @openai/codex-sdk/vendor/${entry.name}`);
    }
  }
}

function pruneSharpBinaries(bundleDir, targetPlatform) {
  const imgDir = join(bundleDir, 'node_modules', '@img');
  if (!existsSync(imgDir)) return;

  const keepPatternsByPlatform = {
    darwin: [/darwin/i, /colour/i],
    win32: [/win32/i, /colour/i],
    linux: [/linux/i, /colour/i],
  };

  const patterns = keepPatternsByPlatform[targetPlatform] || [/colour/i];
  for (const entry of readdirSync(imgDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!patterns.some((p) => p.test(entry.name))) {
      rmSync(join(imgDir, entry.name), { recursive: true, force: true });
      console.log(`    removed @img/${entry.name}`);
    }
  }
}

function cleanupBundle(bundleDir) {
  const removeDirs = new Set(['.github', 'test', 'tests', 'example', 'examples']);
  const removeFile = (name) => {
    const lower = name.toLowerCase();
    return lower.endsWith('.md') || lower.endsWith('.d.ts') || lower.startsWith('changelog');
  };

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (removeDirs.has(entry.name.toLowerCase())) {
          rmSync(full, { recursive: true, force: true });
          continue;
        }
        walk(full);
        continue;
      }
      if (removeFile(entry.name)) {
        rmSync(full, { force: true });
      }
    }
  };

  const nodeModules = join(bundleDir, 'node_modules');
  if (existsSync(nodeModules)) walk(nodeModules);
}

function directorySizeBytes(dir) {
  let total = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        total += statSync(full).size;
      }
    }
  };
  walk(dir);
  return total;
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

console.log(`==> Bundling gateway for platform=${platform} arch=${arch}`);
console.log(`    output: ${gatewayBundle}`);

rmIfExists(gatewayBundle);
mkdirSync(gatewayBundle, { recursive: true });

console.log('  Copying dist/...');
cpSync(join(root, 'dist'), join(gatewayBundle, 'dist'), { recursive: true });

console.log('  Creating production package.json...');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const prodPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  main: pkg.main,
  dependencies: pkg.dependencies,
  engines: pkg.engines,
};
writeFileSync(join(gatewayBundle, 'package.json'), JSON.stringify(prodPkg, null, 2));

console.log('  Installing production dependencies...');
run('npm', ['install', '--omit=dev', '--ignore-scripts'], gatewayBundle);

console.log('  Rebuilding native modules for Electron...');
const electronPkgPath = join(root, 'desktop', 'node_modules', 'electron', 'package.json');
if (!existsSync(electronPkgPath)) {
  throw new Error(`Missing Electron dependency at ${electronPkgPath}. Run npm install in desktop/ first.`);
}
const electronVersion = JSON.parse(readFileSync(electronPkgPath, 'utf-8')).version;
console.log(`    Electron version: ${electronVersion}`);
run('npx', ['--yes', '@electron/rebuild', '-v', electronVersion, '-m', '.', '-w', 'better-sqlite3'], gatewayBundle);

console.log('  Pruning platform-specific binaries...');
pruneCodexVendor(gatewayBundle, platform, arch);
pruneSharpBinaries(gatewayBundle, platform);

console.log('  Cleaning up docs, tests, examples...');
cleanupBundle(gatewayBundle);

const bundleSize = directorySizeBytes(gatewayBundle);
console.log(`==> Gateway bundle complete: ${formatSize(bundleSize)}`);
