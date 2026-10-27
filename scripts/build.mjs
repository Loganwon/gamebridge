import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js']) {
  await copyFile(path.join(root, 'site', file), path.join(dist, file));
}
for (const file of ['core.js', 'schematic.js']) {
  await copyFile(path.join(root, 'src', file), path.join(dist, file));
}
console.log('Built static studio in dist/');
