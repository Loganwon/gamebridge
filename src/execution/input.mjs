import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { assertRunData } from '../orchestration/store.mjs';
import { validateConversionRequest } from '../converter/spec.mjs';
import { validateBehaviorSpec } from '../behavior/index.mjs';
import { evaluateBehaviorVectors } from './csharp-backend.mjs';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function validateBehaviorCompilationInput(raw, { secrets = [] } = {}) {
  assertRunData(raw, { secrets, maxBytes: 128 * 1024 });
  const fields = ['schemaVersion', 'request', 'requirementIds', 'spec', 'steps'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length ||
      Object.keys(raw).some(key => !fields.includes(key)) || raw.schemaVersion !== 1 || !Array.isArray(raw.requirementIds) || !raw.requirementIds.length) fail('INVALID_COMPILATION_INPUT', 'A request, independently bound requirements, behavior spec and verification steps are required.');
  const request = validateConversionRequest(raw.request), requirementIds = [...raw.requirementIds];
  const spec = validateBehaviorSpec(raw.spec, { requirementIds });
  evaluateBehaviorVectors(spec, raw.steps, { requirementIds });
  return { schemaVersion: 1, request, requirementIds, spec, steps: structuredClone(raw.steps) };
}
/** A CLI-local explicit JSON input, never a model-selected filesystem operation. */
export async function readBehaviorCompilationInput(file, options) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('INVALID_COMPILATION_INPUT', 'The local input file must have an explicit absolute path.');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > 128 * 1024) fail('INVALID_COMPILATION_INPUT', 'Input must be a bounded, ordinary JSON file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await handle.stat();
    if (current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size) fail('INVALID_COMPILATION_INPUT', 'Input file identity changed.');
    const bytes = Buffer.alloc(current.size); let at = 0;
    while (at < bytes.length) { const read = await handle.read(bytes, at, bytes.length - at, at); if (!read.bytesRead) fail('INVALID_COMPILATION_INPUT', 'Input was truncated.'); at += read.bytesRead; }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, at), after = await handle.stat();
    if (extra.bytesRead || after.size !== current.size || after.mtimeMs !== current.mtimeMs) fail('INVALID_COMPILATION_INPUT', 'Input bytes changed during observation.');
    let parsed; try { parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID_COMPILATION_INPUT', 'Input is not a valid UTF-8 JSON object.'); }
    return validateBehaviorCompilationInput(parsed, options);
  } finally { await handle.close(); }
}
