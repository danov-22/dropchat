import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ tsconfigRaw: {}, entryPoints: ['./dropchat.js'], bundle: true, format: 'esm', outfile: 'dist/dropchat.js', minify: true, sourcemap: false });
for (const file of ['index.html', 'dropchat.css', 'logo.svg', 'theme.js', '_headers']) await copyFile(file, `dist/${file}`);

await cp("fonts", "dist/fonts", { recursive: true });
