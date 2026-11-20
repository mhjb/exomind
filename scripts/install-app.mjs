// Usage: npm run app:install   (build Exo-mind.app and put it in ~/Applications)
//
// Replaces any copy already there. Quit the app first: macOS won't replace a running app cleanly.
// The config, usage log and window size live in ~/Library/Application Support/exo-mind and the
// notes in the vault, so replacing the app touches neither.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const built = path.join(process.cwd(), 'dist-app', 'mac-arm64', 'Exo-mind.app');
if (!fs.existsSync(built)) {
  console.error(`No ${path.relative(process.cwd(), built)}. Run \`npm run app:dist\` first.`);
  process.exit(1);
}
const dest = path.join(os.homedir(), 'Applications', 'Exo-mind.app');
fs.mkdirSync(path.dirname(dest), { recursive: true });
try {
  execFileSync('pgrep', ['-x', 'Exo-mind'], { stdio: 'ignore' });
  console.error('Exo-mind is running. Quit it (Cmd+Q) and run this again.');
  process.exit(1);
} catch {
  /* not running */
}
fs.rmSync(dest, { recursive: true, force: true });
// ditto, not cp: an app bundle is full of framework symlinks that must survive the copy.
execFileSync('ditto', [built, dest], { stdio: 'inherit' });
// Built here, so it's not "downloaded": clearing quarantine skips the right-click → Open dance.
try {
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest], { stdio: 'ignore' });
} catch {
  /* nothing to clear */
}
console.log(`Installed ${dest}`);
