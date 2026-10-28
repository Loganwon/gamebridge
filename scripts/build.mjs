import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'docs'), { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js']) {
  await copyFile(path.join(root, 'site', file), path.join(dist, file));
}
for (const file of ['gameplay-bridge.md', 'runtime-protocol.md', 'product-and-validation.md']) {
  await copyFile(path.join(root, 'docs', file), path.join(dist, 'docs', file));
}
console.log('Built design site and specifications in dist/');
