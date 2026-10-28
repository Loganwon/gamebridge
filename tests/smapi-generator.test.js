import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProject } from '../src/generator/smapi.mjs';
import { createExamplePlan, validatePlan } from '../src/ai/plan.mjs';

const fixture = () => ({
  schemaVersion: 1,
  title: 'Terraria-style interaction draft',
  hostGame: 'stardew-valley',
  sourceGame: 'terraria',
  summary: 'Bring requested movement and melee interactions into the host, preserving unresolved character requirements.',
  requirements: [
    { id: 'r1', description: 'Short movement burst', capability: 'speed_burst', status: 'draft_supported', reason: 'Only a finite host speed Buff can be generated.' },
    { id: 'r2', description: 'Melee attack effect', capability: 'melee_modifier', status: 'draft_supported', reason: 'Only a native melee multiplier can be generated.' },
    { id: 'r3', description: 'The original character and sword animation', capability: 'original_character', status: 'needs_assets', reason: 'No licensed character or animation assets were supplied.' },
  ],
  mechanics: [
    { type: 'speed_burst', key: 'V', amount: 2, durationTicks: 120, cooldownTicks: 300 },
    { type: 'melee_modifier', key: 'B', amount: 1.5, durationTicks: 120, cooldownTicks: 300 },
  ],
  assetRequirements: ['Licensed character sprites and original sword animations'],
  limitations: ['No source-game combat engine was transferred.'],
});

test('generator emits a fixed real source project and honest unbuilt validation state', () => {
  const result = generateProject(fixture());
  const files = Object.fromEntries(result.files.map(file => [file.path, file.content]));
  assert.deepEqual(Object.keys(files).sort(), ['GameBridge.Generated.csproj', 'ModConfig.cs', 'ModEntry.cs', 'README.md', 'config.json', 'manifest.json', 'plan.json', 'validation-report.json'].sort());
  assert.match(files['GameBridge.Generated.csproj'], /<TargetFramework>net6\.0<\/TargetFramework>/);
  assert.match(files['GameBridge.Generated.csproj'], /Pathoschild\.Stardew\.ModBuildConfig" Version="4\.4\.0"/);
  assert.match(files['GameBridge.Generated.csproj'], /<EnableModDeploy>false<\/EnableModDeploy>/);
  assert.match(files['GameBridge.Generated.csproj'], /<EnableHarmony>false<\/EnableHarmony>/);
  assert.match(files['ModEntry.cs'], /Game1\.player\.applyBuff\(buff\)/);
  assert.match(files['ModEntry.cs'], /buffs\.Remove\(BuffPrefix \+ mechanic\.Index\)/);
  assert.match(files['ModEntry.cs'], /ReferenceEquals\(mechanic\.ActiveTool, Game1\.player\.CurrentTool\)/);
  const update = files['ModEntry.cs'].split('private void OnUpdateTicked')[1].split('private void RemoveOwnBuff')[0];
  assert.ok(!update.includes('!Context.IsPlayerFree'), 'the attack modifier must survive the native weapon swing');
  assert.equal(JSON.parse(files['manifest.json']).EntryDll, 'GameBridge.Generated.dll');
  assert.equal(JSON.parse(files['config.json']).Enabled, false);
  assert.equal(result.report.build, 'not_run');
  assert.equal(result.report.game, 'not_run');
  assert.equal(result.report.readyToInstall, false);
  assert.equal(result.report.completeRequirementCoverage, false);
  assert.equal(result.report.unimplementedRequirements[0].id, 'r3');
  assert.match(files['README.md'], /未构建/);
  assert.ok(!result.files.some(file => /\.(dll|png|xnb|exe)$/i.test(file.path)));
});

test('user and model strings stay in data files and cannot escape C# or project configuration', () => {
  const input = fixture();
  input.title = '"; Process.Start("bad"); // <script>`[link]';
  input.summary = '</Project><Target Name="Injected">evil</Target>';
  const result = generateProject(input);
  const files = Object.fromEntries(result.files.map(file => [file.path, file.content]));
  assert.equal(JSON.parse(files['manifest.json']).Name, input.title);
  assert.ok(!files['ModEntry.cs'].includes('Process.Start'));
  assert.ok(!files['GameBridge.Generated.csproj'].includes('Injected'));
  assert.ok(files['README.md'].includes('&lt;script&gt;'));
  assert.ok(!files['README.md'].includes('</Project>'));
});

test('generation refuses unknown hosts, missing requirements and false supported capabilities', () => {
  for (const mutate of [
    p => { p.hostGame = 'gta-v'; },
    p => { p.schemaVersion = 2; },
    p => { p.requirements = []; },
    p => { p.requirements[2].status = 'draft_supported'; },
    p => { p.requirements[1].status = 'needs_adapter'; },
    p => { p.mechanics = []; },
    p => { p.mechanics[0].type = 'run_arbitrary_code'; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => generateProject(input));
  }
});

test('malformed, amplified and ambiguous mechanics are rejected before any source is emitted', () => {
  for (const mutate of [
    p => { p.mechanics[0].amount = Infinity; },
    p => { p.mechanics[0].amount = 0; },
    p => { p.mechanics[0].amount = 7; },
    p => { p.mechanics[0].amount = 1.5; },
    p => { p.mechanics[1].amount = 3.1; },
    p => { p.mechanics[0].durationTicks = 601; },
    p => { p.mechanics[0].durationTicks = 0; },
    p => { p.mechanics[0].cooldownTicks = 119; },
    p => { p.mechanics[0].cooldownTicks = 3601; },
    p => { p.mechanics[0].key = 'V; evil'; },
    p => { p.mechanics[1].key = 'V'; },
    p => { p.mechanics[1].type = 'speed_burst'; },
    p => { p.mechanics[0].code = 'arbitrary'; },
    p => { p.requirements[2].description = 'x'.repeat(2001); },
    p => { p.requirements[2].description = 'line\u0000comment'; },
    p => { p.assetRequirements = new Array(17).fill('asset'); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => generateProject(input));
  }
});

test('generation is deterministic and does not modify the retained plan', () => {
  const input = fixture();
  const before = structuredClone(input);
  assert.deepEqual(generateProject(input), generateProject(input));
  assert.deepEqual(input, before);
});

test('the actual planner example and a retained multiline request generate without losing original text', () => {
  const example = createExamplePlan();
  const generated = generateProject(example);
  const saved = JSON.parse(generated.files.find(file => file.path === 'plan.json').content);
  assert.deepEqual(saved.requirements[0], example.requirements[0]);
  assert.equal(saved.requirements[0].capability, 'request_scope');
  const raw = fixture();
  const description = `First line\nSecond line ${'x'.repeat(1900)}`;
  const plan = validatePlan(raw, { hostGame: raw.hostGame, sourceGame: raw.sourceGame, description });
  const output = generateProject(plan);
  assert.equal(JSON.parse(output.files.find(file => file.path === 'plan.json').content).requirements[0].description, description);
  assert.equal(output.report.game, 'not_run');
});
