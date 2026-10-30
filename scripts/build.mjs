import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'docs'), { recursive: true });
for (const file of ['index.html', 'actions.css', 'actions.js', 'pipeline.html', 'style.css', 'app.js']) {
  await copyFile(path.join(root, 'site', file), path.join(dist, file));
}
for (const file of ['product-plan.md', 'host-environment.md', 'macos-host-probe.md', 'macos-host-probe-results.json', 'action-rules.md', 'review-fixes.md', 'action-workbench-acceptance.md', 'ai-mod-workbench.md', 'deepseek-pipeline-acceptance.md', 'sandbox-verification.md', 'sandbox-verification-results.json', 'gameplay-bridge.md', 'runtime-protocol.md', 'product-and-validation.md']) {
  await copyFile(path.join(root, 'docs', file), path.join(dist, 'docs', file));
}
for (const name of ['actions/spec.mjs', 'actions/runtime.mjs', 'actions/hosts.mjs', 'ai/plan.mjs']) {
  await mkdir(path.dirname(path.join(dist, 'core', name)), { recursive: true });
  await copyFile(path.join(root, 'src', name), path.join(dist, 'core', name));
}
console.log('Built AI Mod workbench and documentation in dist/');
