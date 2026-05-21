import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/tracker.ts'],
  bundle: true,
  minify: !watch,
  sourcemap: true,
  format: 'iife',
  globalName: 'MgaAnalyticsBundle',
  outfile: 'dist/tracker.js',
  target: ['es2020'],
});

if (watch) {
  await ctx.watch();
  console.log('SDK watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('SDK built → dist/tracker.js');
}
