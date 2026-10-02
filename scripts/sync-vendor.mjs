// Keeps public/vendor (the browser copies of jsQR, JSZip and qrcode-generator) identical to what
// bun installed in node_modules.
//
//   node scripts/sync-vendor.mjs            copy whatever differs (after "bun update")
//   node scripts/sync-vendor.mjs --check    only report; exits 1 when something is out of date
//   --dest <dir>                            use another target folder (for tests)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/sync-vendor.mjs [--check] [--dest dir]';

export const VENDOR_FILES = [
  { from: 'jsqr/dist/jsQR.js', to: 'jsQR.js' },
  { from: 'jszip/dist/jszip.min.js', to: 'jszip.js' },
  { from: 'qrcode-generator/dist/qrcode.js', to: 'qrcode-generator.js' },
];

function main(argv) {
  let check = false;
  let dest = path.join(ROOT, 'public', 'vendor');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--dest' && argv[i + 1]) dest = path.resolve(argv[++i]);
    else {
      console.error(`${argv[i] === '--dest' ? '--dest needs a folder' : `Unknown option ${argv[i]}`}\n${USAGE}`);
      return 1;
    }
  }

  const outdated = [];
  for (const { from, to } of VENDOR_FILES) {
    const sourceFile = path.join(ROOT, 'node_modules', from);
    if (!fs.existsSync(sourceFile)) {
      console.error(`node_modules/${from} is missing: run "bun install" first`);
      return 1;
    }
    const wanted = fs.readFileSync(sourceFile);
    const target = path.join(dest, to);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current?.equals(wanted)) continue;
    outdated.push(to);
    if (!check) {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(target, wanted);
      console.log(`updated ${to}`);
    }
  }

  if (check && outdated.length > 0) {
    console.error(`Out of date: ${outdated.join(', ')}. Run "bun run vendor" to refresh them.`);
    return 1;
  }
  if (outdated.length === 0) console.log('public/vendor is up to date');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
