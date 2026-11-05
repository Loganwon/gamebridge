import path from 'node:path';
import { prepareSuperTuxProbeBundle } from '../src/hosts/supertux-bundle.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args.some(value => !path.isAbsolute(value))) throw new Error('Usage: npm run prepare:host -- /absolute/vendor.app /absolute/new-probe.app');
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  console.log(JSON.stringify(await prepareSuperTuxProbeBundle({ sourceApp: args[0], destinationApp: args[1], signal: controller.signal }), null, 2));
} finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
