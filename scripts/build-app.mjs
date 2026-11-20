// Usage: npm run app:build   (assemble what the Mac app runs, into app-server/)
//
// The server is TypeScript run by tsx in a checkout. The app has no tsx and no node_modules, so
// the server is bundled into one ES module with esbuild, and the built UI is copied beside it:
//
//   app-server/server.mjs       the whole server, dependencies included
//   app-server/dist/            the UI, as `vite build` makes it
//   app-server/build-info.json  where it was built from, so the app can find the old data/ folder
//
// Nothing from data/ or vault/ is copied: the app reads those where they already are.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const stage = path.join(root, 'app-server');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// electron and electron-builder arrived with 0.4; a checkout from before then needs `npm install`
// first, and finding out now beats a full build that ends in "electron-builder: command not found".
const missing = ['electron', 'electron-builder', 'esbuild'].filter((p) => !fs.existsSync(path.join(root, 'node_modules', p, 'package.json')));
if (missing.length) {
  console.error(`Not installed: ${missing.join(', ')}. Run \`npm install\` and try again.`);
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

console.log('→ vite build');
// Warnings only: the per-file list (some 300 font and language files) says nothing useful here.
execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit', cwd: root });

console.log('→ bundling the server');
await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(stage, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Only reached with EXO_DEV=1, which the app never sets. linkedom asks for canvas optionally.
  external: ['vite', 'canvas'],
  // Express and friends are CommonJS and call require() for Node built-ins, which an ES module
  // doesn't have; give them one, and the __dirname they may expect.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

console.log('→ copying the UI');
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });

fs.writeFileSync(
  path.join(stage, 'build-info.json'),
  JSON.stringify({ version: pkg.version, builtFrom: root, builtAt: new Date().toISOString() }, null, 2),
);

for (const [rel, what] of [
  ['server.mjs', 'the server'],
  ['dist/index.html', 'the UI'],
]) {
  if (!fs.existsSync(path.join(stage, rel))) {
    console.error(`The staged app is missing ${what} (${rel})`);
    process.exit(1);
  }
}
const kb = Math.round(fs.statSync(path.join(stage, 'server.mjs')).size / 1024);
console.log(`\nStaged v${pkg.version}: server.mjs (${kb} KB) and the UI.`);
console.log('`npm run app` runs it from here; `npm run app:dist` makes Exo-mind.app.');
