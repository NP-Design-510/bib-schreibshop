import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const OUT_DIR = resolve(ROOT_DIR, 'build-export');

const FILES_TO_COPY = [
  'server.mjs',
  'README.md',
  'Dockerfile',
  '.dockerignore',
  'render.yaml',
  'fly.toml',
  'vercel.json',
  'package-lock.json',
  'public',
  'api',
  'lib',
];

async function copyProjectFiles() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const entry of FILES_TO_COPY) {
    await cp(resolve(ROOT_DIR, entry), resolve(OUT_DIR, entry), { recursive: true });
  }
}

async function writeBuildPackageJson() {
  const packageJsonPath = resolve(ROOT_DIR, 'package.json');
  const raw = await readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);

  const buildPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: pkg.type,
    scripts: {
      start: 'node server.mjs',
    },
    dependencies: pkg.dependencies,
  };

  await writeFile(resolve(OUT_DIR, 'package.json'), `${JSON.stringify(buildPkg, null, 2)}\n`, 'utf8');
}

async function main() {
  await copyProjectFiles();
  await writeBuildPackageJson();
  console.log(`Export-Build erstellt: ${OUT_DIR}`);
  console.log('Naechster Schritt: ZIP bauen mit npm run build:zip');
}

main().catch((error) => {
  console.error('Build fehlgeschlagen:', error.message);
  process.exit(1);
});
