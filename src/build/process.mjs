import { spawn } from 'node:child_process';
import path from 'node:path';

/** Infrastructure for future registered adapters; no HTTP execution endpoint.
 * Runs a locally trusted program, not model-authored commands. This is not a sandbox.
 * Termination targets the controlled process group; escaped descendants need OS isolation.
 */
export async function runBuildProcess(command, args, { cwd, signal, timeoutMs = 30000, maxOutputBytes = 65536 } = {}) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args) || args.length > 128 ||
      args.some(value => typeof value !== 'string' || value.length > 8192 || value.includes('\0')) ||
      typeof cwd !== 'string' || !path.isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 180000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1048576 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('Invalid trusted build process options.');
  const empty = { exitCode: null, output: '', cancelled: false, timedOut: false, overflow: false, spawnError: false };
  if (signal?.aborted) return { ...empty, cancelled: true };
  const env = { PATH: process.platform === 'win32' ? '' : '/usr/bin:/bin', HOME: cwd, USERPROFILE: cwd,
    TMPDIR: cwd, TMP: cwd, TEMP: cwd, LANG: 'C', LC_ALL: 'C' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { ...empty }, chunks = []; let bytes = 0, settled = false, force;
    function kill(hard) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); else child.kill(hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already exited. */ }
    }
    function finish(code) {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', cancel);
      kill(true); child.stdout.destroy(); child.stderr.destroy();
      result.exitCode = result.cancelled || result.timedOut || result.overflow ? null : code;
      result.output = Buffer.concat(chunks).toString('utf8'); resolve(result);
    }
    function stop() { kill(false); force ??= setTimeout(() => { kill(true); finish(null); }, 750); }
    function cancel() { result.cancelled = true; stop(); }
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    function collect(chunk) {
      if (settled || result.overflow) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { result.overflow = true; stop(); return; }
      chunks.push(chunk);
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { result.spawnError = true; finish(null); }); child.once('close', finish);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
