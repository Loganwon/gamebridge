import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { inspectTmodloaderEnvironment } from '../src/hosts/tmodloader/environment.mjs';

const USAGE = 'Usage: npm run host:check -- [--install-path /absolute/tModLoader] [--dotnet-path /absolute/dotnet] [--output /new/report.json]\nRead-only metadata and SDK checks only; no model, game, build or packaging execution.\nExit 0: environment conditions met; 2: blocked, cancelled or invalid input.\n';
function invalid() { const error = new Error('Invalid preflight arguments. Use --help for the accepted options.'); error.code = 'INVALID_PREFLIGHT_ARGUMENT'; return error; }
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  const names = new Map([['--install-path', 'installPath'], ['--dotnet-path', 'dotnetPath'], ['--output', 'output']]);
  for (let index = 0; index < args.length; index++) {
    const key = names.get(args[index]);
    const value = args[++index];
    if (!key || Object.hasOwn(options, key) || !value || value.startsWith('--') || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw invalid();
    if (key !== 'output' && !path.isAbsolute(value)) throw invalid();
    if (key === 'output' && path.extname(value) !== '.json') throw invalid();
    options[key] = value;
  }
  return options;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const report = await inspectTmodloaderEnvironment({
      installPath: options.installPath || process.env.GAMEBRIDGE_TML_PATH || undefined,
      dotnetPath: options.dotnetPath || process.env.GAMEBRIDGE_TML_DOTNET_PATH || undefined,
      signal: controller.signal,
    });
    const text = JSON.stringify({ ...report, modelCalls: 0 }, null, 2) + '\n';
    // No credential is passed to the inspector or its SDK subprocess. Also stop
    // an accidental echo before writing/printing any local report.
    const key = process.env.DEEPSEEK_API_KEY;
    if (Buffer.byteLength(text) > 2 * 1024 * 1024 || (key && (text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1))))) {
      const error = new Error('Preflight report could not be safely emitted.'); error.code = 'UNSAFE_PREFLIGHT_REPORT'; throw error;
    }
    if (options.output) {
      const target = path.resolve(options.output);
      await mkdir(path.dirname(target), { recursive: true });
      // A diagnostic command must not overwrite existing user files.
      await writeFile(target, text, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(text);
    if (!report.readyForProbeBuild) process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => {
  const codes = new Set(['INVALID_PREFLIGHT_ARGUMENT', 'UNSAFE_PREFLIGHT_REPORT', 'EEXIST']);
  const code = codes.has(error?.code) ? error.code : 'PREFLIGHT_COMMAND_FAILED';
  const message = code === 'EEXIST' ? 'Output file already exists; choose a new report path.' : code === 'INVALID_PREFLIGHT_ARGUMENT' ? invalid().message : 'Preflight command did not complete; no game or Mod was run.';
  process.stdout.write(JSON.stringify({ status: 'blocked', error: { code, message }, modelCalls: 0, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }) + '\n');
  process.exitCode = 2;
});
