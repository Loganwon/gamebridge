import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const owner = 'gamebridge-test-owner';
const verifiedUrl = `https://github.com/${owner}/gamebridge.git`;
const localHead = 'a'.repeat(40);

// These executables replace BOTH external commands. Unexpected calls fail closed;
// PATH contains only this fixture, never a real gh/git executable directory.
const fakeTool = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(process.env.GAMEBRIDGE_TEST_CONFIG);
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GAMEBRIDGE_TEST_CALLS, JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n');
const key = command + ' ' + args.join(' ');
const responses = {
  'gh auth status': '',
  'gh api user --jq .login': config.owner,
  'git status --porcelain': config.dirty ? ' M README.md' : '',
  'git branch --show-current': 'main',
  'git rev-parse --verify HEAD': config.localHead,
  'git remote': 'origin',
  'git remote get-url origin': config.fetchUrl,
  ['gh repo view ' + config.owner + '/gamebridge --json visibility --jq .visibility']: 'PUBLIC',
  'git remote get-url --push --all origin': config.pushUrls.join('\\n'),
  'git push -u origin main': '',
  'git rev-parse HEAD': config.localHead,
  'git ls-remote origin refs/heads/main': config.remoteHead + '\\trefs/heads/main',
};
if (!Object.hasOwn(responses, key)) {
  console.error('Unexpected external call: ' + key);
  process.exit(97);
}
if (responses[key]) process.stdout.write(responses[key] + '\\n');
`;

async function runFixture(overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gamebridge-publish-test-')));
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  const callsFile = path.join(root, 'calls.jsonl');
  try {
    await mkdir(bin);
    await mkdir(scripts);
    await copyFile(new URL('../scripts/publish-github.mjs', import.meta.url), path.join(scripts, 'publish-github.mjs'));
    await writeFile(callsFile, '');
    for (const command of ['gh', 'git']) await writeFile(path.join(bin, command), fakeTool, { mode: 0o755 });
    const config = {
      owner, fetchUrl: verifiedUrl, pushUrls: [verifiedUrl], dirty: false,
      localHead, remoteHead: localHead, ...overrides,
    };
    const result = spawnSync(process.execPath, [path.join(scripts, 'publish-github.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: bin,
        GAMEBRIDGE_TEST_CONFIG: JSON.stringify(config),
        GAMEBRIDGE_TEST_CALLS: callsFile,
      },
      timeout: 15000,
    });
    if (result.error) throw result.error;
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.cwd === root), 'publisher must operate only inside the copied fixture');
    return { ...result, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const pushed = (calls) => calls.filter(({ command, args }) => command === 'git' && args[0] === 'push');

test('publisher refuses a different push destination even when the fetch URL is verified', async () => {
  const result = await runFixture({ pushUrls: ['https://github.com/another-owner/another-repository.git'] });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /origin push URL differs/);
  assert.equal(pushed(result.calls).length, 0);
  assert.doesNotMatch(result.stdout, /Published/);
});

test('publisher refuses multiple push URLs before any push', async () => {
  const result = await runFixture({ pushUrls: [verifiedUrl, `git@github.com:${owner}/gamebridge.git`] });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /origin push URL differs/);
  assert.equal(pushed(result.calls).length, 0);
});

test('publisher refuses a dirty checkout before remote changes or publication', async () => {
  const result = await runFixture({ dirty: true });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Commit or stash local changes/);
  assert.deepEqual(result.calls.map(({ command, args }) => [command, ...args]), [
    ['gh', 'auth', 'status'],
    ['gh', 'api', 'user', '--jq', '.login'],
    ['git', 'status', '--porcelain'],
  ]);
  assert.doesNotMatch(result.stdout, /Published/);
});

test('publisher pushes a verified clean checkout, verifies remote HEAD, and explains the Pages variable', async () => {
  const result = await runFixture({ pushUrls: [`git@github.com:${owner}/gamebridge.git`] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pushed(result.calls).map(({ args }) => args), [['push', '-u', 'origin', 'main']]);
  const keys = result.calls.map(({ command, args }) => [command, ...args].join(' '));
  assert.ok(keys.indexOf('git remote get-url --push --all origin') < keys.indexOf('git push -u origin main'));
  assert.ok(keys.indexOf('git ls-remote origin refs/heads/main') > keys.indexOf('git push -u origin main'));
  assert.match(result.stdout, new RegExp(`Published https://github.com/${owner}/gamebridge`));
  assert.match(result.stdout, /PAGES_ENABLED=true/);
  assert.match(result.stdout, /run the workflow/);
});

test('publisher never claims synchronization when remote main differs after push', async () => {
  const result = await runFixture({ remoteHead: 'b'.repeat(40) });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(pushed(result.calls).length, 1);
  assert.match(result.stderr, /Remote main does not match local HEAD/);
  assert.doesNotMatch(result.stdout, /Published/);
});
