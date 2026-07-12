// build.mjs — bundles src/game.js + Three.js into dist/maestro.js
//
// Output is a single self-contained IIFE served from GitHub via jsDelivr:
//   https://cdn.jsdelivr.net/gh/danieloquelis/maestro@latest/dist/maestro.js
//
// OTA update flow:  edit src/game.js  ->  npm run build  ->  git push
// The hosted index.html never changes; jsDelivr serves the new bundle.
//
// Flags:  --watch  rebuild on change   |   --serve  dev server at :8000

import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/game.js'],
  outfile: 'dist/maestro.js',
  bundle: true,        // pull three (and anything else) into one file
  minify: true,        // ship small; source is in src/game.js
  format: 'iife',      // self-executing — just drop a <script> tag, no import map
  target: ['es2020'],
  legalComments: 'none',
  sourcemap: false,
  banner: {
    js: '/* MAESTRO MAYHEM — bundled (three r160 inlined). Source: src/game.js */',
  },
};

if (args.has('--serve')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { host, port } = await ctx.serve({ servedir: '.', port: 8000 });
  console.log(`dev server: http://localhost:${port}  (serving repo root, live rebuild)`);
} else if (args.has('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching src/ — rebuilding dist/maestro.js on change …');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const out = result.metafile.outputs['dist/maestro.js'];
  const kb = (out.bytes / 1024).toFixed(1);
  console.log(`built dist/maestro.js — ${kb} KB (minified, three bundled in)`);
}
