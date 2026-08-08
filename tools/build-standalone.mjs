// Builds the whole game into one self-contained HTML file.
//
// The Pages deploy serves the repo as-is (separate module files plus vendored
// Phaser), which is the right thing for the real site. This produces a single
// file with everything inlined instead — useful for sharing a build that has to
// run somewhere with no relative fetches available, or for handing someone one
// file they can open locally.
//
//   node tools/build-standalone.mjs [outfile] [--fragment]
//
// --fragment omits <!doctype>/<html>/<head>/<body>, emitting only the page
// content, for hosts that supply their own document skeleton.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const FRAGMENT = args.includes('--fragment');
const OUT = args.find((a) => !a.startsWith('--')) || 'dist/age-of-skirmish.html';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A literal </script> inside inlined JS would close the tag early.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

// 1. Bundle the ES module graph into one IIFE. Phaser stays external: it is a
//    global from a classic script tag, not an importable module.
const bundlePath = path.join(ROOT, 'dist/.bundle.tmp.js');
fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
execFileSync(
  'npx',
  ['esbuild', 'src/main.js', '--bundle', '--format=iife', '--external:phaser',
    '--minify', `--outfile=${bundlePath}`],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
);
const bundle = fs.readFileSync(bundlePath, 'utf8');
fs.rmSync(bundlePath);

const phaser = read('vendor/phaser.min.js');
const css = read('src/ui/hud.css');
const html = read('index.html');

// 2. Lift the body markup out of index.html, dropping the tags that pull in
//    external files — their contents are inlined below instead.
let body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
body = body
  .replace(/<script[^>]*><\/script>/gi, '')
  .replace(/<script[^>]*src=[^>]*>[\s\S]*?<\/script>/gi, '')
  .trim();

// 3. Stamp build info into the same placeholders the Pages workflow fills.
let sha = 'local';
try {
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
    .toString().trim();
} catch {
  // Not a git checkout — leave the placeholder as "local".
}
body = body
  .replace(/__COMMIT_SHA__/g, sha)
  .replace(/__BUILD_TIME__/g, new Date().toISOString().replace(/\.\d+Z$/, 'Z'));

const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'Age of Skirmish'])[1];

const parts = [
  `<title>${title}</title>`,
  `<style>\n${css}\n</style>`,
  body,
  `<script>${safe(phaser)}</script>`,
  `<script>${safe(bundle)}</script>`,
];

const page = FRAGMENT
  ? parts.join('\n')
  : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#1a1410">
${parts[0]}
${parts[1]}
</head>
<body>
${parts.slice(2).join('\n')}
</body>
</html>`;

const outPath = path.resolve(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, page);

const mb = (page.length / 1024 / 1024).toFixed(2);
console.log(`wrote ${OUT} — ${mb} MB (phaser ${(phaser.length / 1024 / 1024).toFixed(2)} MB, game ${(bundle.length / 1024).toFixed(0)} KB) @ ${sha}`);
