import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceZip } from '../src/zip.mjs';

test('generic archive writer packages only explicitly provided data', () => {
  const bytes = sourceZip([{ name: 'conversion/manifest.json', data: Buffer.from('{"kind":"analysis-only"}') }]);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(bytes.includes(Buffer.from('analysis-only')));
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
});

test('generic archives reject path traversal, duplicates and data over budget', () => {
  for (const name of ['../outside', '/absolute', 'a/../../outside', 'a//b']) assert.throws(() => sourceZip([{ name, data: 'x' }]));
  assert.throws(() => sourceZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]));
  assert.throws(() => sourceZip([{ name: 'a', data: '12345' }], { maxBytes: 4 }));
});
