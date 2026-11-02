// Game-neutral request contract. A name is input, never a support declaration.
export const CONTENT_KINDS = Object.freeze(['character', 'weapon', 'moveset', 'rules', 'world', 'audio', 'ui', 'assets', 'other']);
export const REQUEST_LIMITS = Object.freeze({ bytes: 12 * 1024, descriptionCharacters: 8000, gameCharacters: 80 });

export class RequestValidationError extends Error {
  constructor(message) { super(message); this.name = 'RequestValidationError'; this.code = 'INVALID_CONVERSION_REQUEST'; }
}
function fail(message) { throw new RequestValidationError(message); }
function text(value, label, max, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
export function validateRequest(raw) {
  const allowed = ['hostGame', 'sourceGame', 'description', 'contentKinds', 'hostVersion', 'sourceVersion'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))) fail('Invalid request fields.');
  const kinds = raw.contentKinds === undefined ? [] : raw.contentKinds;
  if (!Array.isArray(kinds) || kinds.length > CONTENT_KINDS.length || Reflect.ownKeys(kinds).length !== kinds.length + 1 ||
      Object.values(Object.getOwnPropertyDescriptors(kinds)).some(item => !Object.hasOwn(item, 'value')) ||
      Array.from({ length: kinds.length }, (_, index) => !Object.hasOwn(kinds, index)).some(Boolean) ||
      kinds.some(kind => !CONTENT_KINDS.includes(kind)) || new Set(kinds).size !== kinds.length) fail('Invalid content kinds.');
  const result = {
    hostGame: text(raw.hostGame, 'host game', REQUEST_LIMITS.gameCharacters),
    sourceGame: text(raw.sourceGame, 'source game', REQUEST_LIMITS.gameCharacters),
    description: text(raw.description, 'description', REQUEST_LIMITS.descriptionCharacters, true),
    contentKinds: [...kinds], hostVersion: raw.hostVersion === undefined ? 'unknown' : text(raw.hostVersion, 'host version', 80),
    sourceVersion: raw.sourceVersion === undefined ? 'unknown' : text(raw.sourceVersion, 'source version', 80),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > REQUEST_LIMITS.bytes) fail('Request exceeds its byte limit.');
  return result;
}
