import test from 'node:test';
import assert from 'node:assert/strict';
import { generateModCode, repairModCode, validateModCode, sanitizeCompilerDiagnostics, CODE_POLICY_NOTICE } from '../src/ai/code.mjs';
import { generateProject } from '../src/generator/smapi.mjs';
import { createExamplePlan } from '../src/ai/plan.mjs';

const KEY = 'sk-code-test-secret';
const plan = createExamplePlan();
const files = generateProject(plan).files;
const original = files.find(file => file.path === 'ModEntry.cs').content;
function proposal(content = original) { return { files: [{ path: 'ModEntry.cs', content }], summary: 'Generated the declared source subset; assets and game validation remain unresolved.' }; }
function completion(value) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })); }

test('code generation makes one bounded JSON call with source context and preserves the full plan', async () => {
  const before = structuredClone({ plan, files }); let calls = 0;
  const result = await generateModCode({ plan, files }, { apiKey: KEY, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.match(body.messages[0].content, /not a sandbox/);
    const context = JSON.parse(body.messages[1].content);
    assert.equal(context.task, 'generate');
    assert.deepEqual(context.plan, plan);
    assert.deepEqual(context.files.map(file => file.path), ['ModEntry.cs', 'ModConfig.cs']);
    assert.ok(!options.body.includes(KEY));
    assert.ok(!options.body.includes('<Project'));
    return completion(proposal(original.replace('source draft loaded', 'AI source draft loaded')));
  } });
  assert.equal(calls, 1);
  assert.equal(result.files[0].path, 'ModEntry.cs');
  assert.match(result.files[0].content, /AI source draft loaded/);
  assert.deepEqual({ plan, files }, before);
  assert.match(CODE_POLICY_NOTICE, /not a sandbox/);
});

test('repair passes only source and bounded C# diagnostics with absolute paths removed', async () => {
  let calls = 0;
  const result = await repairModCode({ plan, files, attempt: 1, diagnostics: [{
    code: 'CS1061', severity: 'error', file: '/Users/alice/private/GameBridge/ModEntry.cs', line: 27,
    message: 'Member missing in /Users/alice/private/GameBridge/ModEntry.cs and C:\\Users\\alice\\game\\Stardew.dll; see https://example.com/private',
    rawOutput: 'not to be sent', environment: { secret: KEY },
  }] }, { apiKey: KEY, fetchImpl: async (_url, options) => {
    calls++;
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(context.task, 'repair'); assert.equal(context.attempt, 1);
    assert.deepEqual(Object.keys(context).sort(), ['attempt', 'diagnostics', 'files', 'plan', 'task']);
    assert.deepEqual(context.diagnostics[0], { code: 'CS1061', severity: 'error', message: 'Member missing in [local-path] and [local-path]; see [location]', line: 27 });
    assert.ok(!options.body.includes('alice'));
    assert.ok(!options.body.includes('rawOutput'));
    return completion(proposal());
  } });
  assert.equal(calls, 1); assert.equal(result.files.length, 1);
});

test('repair refuses missing infrastructure diagnostics, no-error reports and out-of-budget attempts before networking', async () => {
  let calls = 0;
  const options = { apiKey: KEY, fetchImpl: async () => { calls++; return completion(proposal()); } };
  for (const diagnostics of [[], [{ code: 'NETSDK1045', severity: 'error', message: 'SDK missing' }], [{ code: 'NU1301', severity: 'error', message: 'network failure' }], [{ code: 'CS0168', severity: 'warning', message: 'unused' }]]) {
    await assert.rejects(repairModCode({ plan, files, attempt: 1, diagnostics }, options), error => error.code === 'INVALID_CODE');
  }
  for (const attempt of [0, 3, 1.5]) await assert.rejects(repairModCode({ plan, files, attempt, diagnostics: [{ code: 'CS1002', severity: 'error', message: '; expected' }] }, options));
  assert.equal(calls, 0);
});

test('model cannot replace project/config/plan files, emit extra fields or amplify source', () => {
  for (const response of [
    { files: [{ path: '../ModEntry.cs', content: original }], summary: 'bad path' },
    { files: [{ path: 'GameBridge.Generated.csproj', content: original }], summary: 'project replacement' },
    { files: [{ path: 'ModConfig.cs', content: original }], summary: 'config replacement' },
    { ...proposal(), files: [...proposal().files, ...proposal().files] },
    { ...proposal(), plan }, { ...proposal(), summary: '' },
    proposal(''), proposal(original + '\n'.repeat(50 * 1024)),
  ]) assert.throws(() => validateModCode(response), error => error.code === 'INVALID_CODE');
});

test('unsafe source capabilities and obfuscated/alternate declarations are rejected', () => {
  for (const inserted of [
    'System.IO.File.ReadAllText("secrets");', 'global::System.Diagnostics.Process.Start("sh");',
    'System.Net.Http.HttpClient client = new();', 'var x = this.GetType();',
    '[System.Runtime.InteropServices.DllImport("x")] static extern void X();',
    'dynamic x = null;', 'unsafe { int* x = null; }', 'var x = typeof(ModEntry);',
    'System.Threading.Tasks.Task.Run(() => {});', 'helper.WriteConfig(this.Config);',
    'this.Config.Enabled = true;', '\\u0050rocess.Start("sh");',
    'System.ComponentModel.TypeDescriptor.GetProperties(this.Config)["Enabled"].SetValue(this.Config, true);',
    'var x = $"{System.IO.File.ReadAllText(\"secret\")}";',
    '#if DEBUG\n#endif',
  ]) assert.throws(() => validateModCode(proposal(original.replace('this.Config = helper.ReadConfig<ModConfig>();', 'this.Config = helper.ReadConfig<ModConfig>();\n' + inserted))), error => error.code === 'INVALID_CODE', inserted);
  assert.throws(() => validateModCode(proposal('/* ' + original + ' */')), /entry point/);
  assert.throws(() => validateModCode(proposal(original.replaceAll('!this.Config.Enabled', 'false'))), /guards/);
  assert.throws(() => validateModCode(proposal(original.replace('using System;', 'using Alias = System;'))), /namespace/);
});

test('explicit writes and aliases cannot force-enable or replace the opt-in configuration', () => {
  const read = 'this.Config = helper.ReadConfig<ModConfig>();';
  for (const inserted of [
    'this.Config.Enabled |= true;', 'this.Config.Enabled &= false;', 'this.Config.Enabled ^= true;',
    'this.Config.Enabled ??= true;', 'this.Config.Enabled += true;', 'this.Config.Enabled++;',
    '++this.Config.Enabled;', '(this.Config.Enabled) = true;',
    'var settings = this.Config; settings.Enabled |= true;',
    'Replace(ref this.Config);', 'Replace(out this.Config);',
    'Replace(ref this.Config.Enabled);', 'Replace(out settings.Enabled);',
    'this.Config = new ModConfig();', 'Config ??= new ModConfig();',
    '(this.Config) = new ModConfig();', '(this.Config, ignored) = (new ModConfig(), 0);',
    '(ignored, this.Config) = (0, new ModConfig());',
    'var settings = this.Config; (settings.Enabled, ignored) = (true, 0);',
    'this.Config = new ModConfig { Enabled = true };',
    'this.Config = helper.ReadConfig<ModConfig>();',
  ]) assert.throws(() => validateModCode(proposal(original.replace(read, read + '\n' + inserted))), error => error.code === 'INVALID_CODE', inserted);
  assert.throws(() => validateModCode(proposal(original.replace(read, '') + '\nclass Extra { void Reset() { this.Config = helper.ReadConfig<ModConfig>(); } }')), /Entry|guards/);
  const missingSemicolon = original.replace('private ModConfig Config = new();', 'private ModConfig Config = new()');
  assert.equal(validateModCode(proposal(missingSemicolon)).files[0].content, missingSemicolon, 'a missing semicolon remains available to the compiler/repair path');
  assert.equal(validateModCode(proposal()).files[0].content, original);
});

test('fixed handler guards reject ineffective conditions, empty branches and relocated checks', () => {
  const buttonGuard = 'if (!this.Config.Enabled || !Context.IsWorldReady || !Context.IsPlayerFree || Context.IsMultiplayer)\n            return;';
  const updateGuard = 'if (!this.Config.Enabled || Context.IsMultiplayer || Game1.activeClickableMenu is not null || Game1.eventUp || Game1.player.health <= 0)';
  for (const change of [
    source => source.replaceAll('!this.Config.Enabled', '(!this.Config.Enabled && false)'),
    source => source.replaceAll('Context.IsMultiplayer', '(Context.IsMultiplayer && false)'),
    source => source.replaceAll('!this.Config.Enabled', '(!this.Config.Enabled || true)'),
    source => source.replaceAll('!this.Config.Enabled', '(true && !this.Config.Enabled)'),
    source => source.replace(buttonGuard, buttonGuard.replace('return;', '{}')),
    source => source.replace(buttonGuard, buttonGuard.replace('return;', '{} else return;')),
    source => source.replace(buttonGuard, 'if (true) { ' + buttonGuard + ' }'),
    source => source.replace(buttonGuard, 'this.RemoveOwnBuffs();\n' + buttonGuard),
    source => source.replace('            this.RemoveOwnBuffs();\n            return;', '            return;\n            this.RemoveOwnBuffs();'),
    source => source.replace(updateGuard, updateGuard.replace('Context.IsMultiplayer', '!Context.IsMultiplayer')),
    source => source.replace('if (!Context.IsWorldReady)\n            return;', 'if (!Context.IsWorldReady) {}'),
    source => source.replace(buttonGuard, '').replace('private void ResetSession()\n    {', 'private void ResetSession()\n    {\n        ' + buttonGuard),
  ]) {
    const changed = change(original);
    assert.notEqual(changed, original, 'the mutation must exercise an actual guard change');
    assert.throws(() => validateModCode(proposal(changed)), error => error.code === 'INVALID_CODE');
  }
  const bracedGuard = original.replace(buttonGuard, buttonGuard.replace('return;', '{ return; }'));
  assert.equal(validateModCode(proposal(bracedGuard)).files[0].content, bracedGuard);
});

test('all C# single-line comment endings preserve normal guards without hiding preceding code', () => {
  const guard = '        if (!this.Config.Enabled || !Context.IsWorldReady || !Context.IsPlayerFree || Context.IsMultiplayer)';
  const logLiteral = '"GameBridge source draft loaded. Review config.json and validate in a new single-player save."';
  for (const [name, ending] of [['LF', '\n'], ['CR', '\r'], ['NEL', '\u0085'], ['LS', '\u2028'], ['PS', '\u2029'], ['CRLF', '\r\n']]) {
    const normal = original.replace(guard, '        // ordinary comment' + ending + guard);
    assert.equal(validateModCode(proposal(normal)).files[0].content, normal, name + ': normal comments preserve source text');
    const hidden = original.replace(guard, '        // hidden' + ending + 'this.RemoveOwnBuffs();\n' + guard);
    assert.throws(() => validateModCode(proposal(hidden)), { code: 'INVALID_CODE' }, name + ': pre-guard code must remain visible');
    const literal = original.replace(logLiteral, '@"// literal text' + ending + 'Game1.player.health = 100;"');
    assert.equal(validateModCode(proposal(literal)).files[0].content, literal, name + ': verbatim string contents stay literal and unchanged');
  }
});

test('fixed source shell rejects alternate callbacks and effects before the guarded handlers', () => {
  const wiring = 'helper.Events.Input.ButtonPressed += this.OnButtonPressed;';
  const configRead = 'this.Config = helper.ReadConfig<ModConfig>();';
  for (const changed of [
    original.replace(wiring, wiring + '\n        helper.Events.Input.ButtonPressed += (_, e) => this.RemoveOwnBuffs();'),
    original.replace(wiring, 'helper.Events.Input.ButtonPressed += (_, e) => this.RemoveOwnBuffs();'),
    original.replace(configRead, configRead + '\n        Game1.player.health = 100;'),
    original.replace('private const string BuffPrefix', 'private object Extra = Game1.player;\n    private const string BuffPrefix'),
    original.replace('private void ResetSession()\n    {', 'public ModEntry() { Game1.player.health = 100; }\n    private void ResetSession()\n    {'),
    original.replace('        this.RemoveOwnBuffs();\n        foreach (Mechanic mechanic', '        Game1.player.health = 100;\n        this.RemoveOwnBuffs();\n        foreach (Mechanic mechanic'),
    original.replace('        foreach (Mechanic mechanic in this.Mechanics)\n        {', '        goto skip;\n        skip: foreach (Mechanic mechanic in this.Mechanics)\n        {'),
    original.replace('        foreach (Mechanic mechanic in this.Mechanics)\n        {', '        Action later = () => this.RemoveOwnBuffs();\n        foreach (Mechanic mechanic in this.Mechanics)\n        {'),
    original.replace('        foreach (Mechanic mechanic in this.Mechanics)\n        {', '        var events = this.Helper.Events;\n        foreach (Mechanic mechanic in this.Mechanics)\n        {'),
  ]) assert.throws(() => validateModCode(proposal(changed)), error => error.code === 'INVALID_CODE');
});

test('fixed guard profile retains equivalent named lifecycle callbacks used by accepted model source', () => {
  let named = original
    .replace('helper.Events.GameLoop.Saving += (_, _) => this.RemoveOwnBuffs();', 'helper.Events.GameLoop.Saving += this.OnSaving;')
    .replace('helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.ResetSession();', 'helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;')
    .replace('helper.Events.Player.Warped += (_, e) => { if (e.IsLocalPlayer) this.RemoveOwnBuffs(); };', 'helper.Events.Player.Warped += this.OnWarped;');
  const callbacks = `private void OnSaving(object? sender, SavingEventArgs e) { this.RemoveOwnBuffs(); }
    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e) { this.ResetSession(); }
    private void OnWarped(object? sender, WarpedEventArgs e) { if (e.IsLocalPlayer) this.RemoveOwnBuffs(); }
    `;
  named = named.replace('private void OnButtonPressed', callbacks + 'private void OnButtonPressed');
  assert.equal(validateModCode(proposal(named)).files[0].content, named);
  assert.throws(() => validateModCode(proposal(named.replace('SavingEventArgs e) { this.RemoveOwnBuffs();', 'SavingEventArgs e) { Game1.player.health = 100;'))), /guards/);
  assert.throws(() => validateModCode(proposal(named.replace('helper.Events.GameLoop.Saving += this.OnSaving;', 'helper.Events.GameLoop.Saving += this.OnButtonPressed;'))), /guards/);
});

test('a generated guard violation stops after one call and an invalid input guard stops before repair', async () => {
  const invalidGuard = original.replaceAll('!this.Config.Enabled', '(!this.Config.Enabled && false)');
  let calls = 0;
  const options = { apiKey: KEY, fetchImpl: async () => { calls++; return completion(proposal(invalidGuard)); } };
  await assert.rejects(generateModCode({ plan, files }, options), { code: 'INVALID_CODE' });
  assert.equal(calls, 1, 'an unsafe guard result must not trigger a paid retry');
  const input = files.map(file => file.path === 'ModEntry.cs' ? { ...file, content: invalidGuard } : file);
  await assert.rejects(repairModCode({ plan, files: input, diagnostics: [{ code: 'CS1002', severity: 'error', message: '; expected' }], attempt: 1 }, options), { code: 'INVALID_CODE' });
  assert.equal(calls, 1, 'an invalid guard in repair context must be rejected before networking');
});

test('code errors, successful credential echoes and credentials embedded in inputs never leak', async () => {
  for (const response of [ { ...proposal(), summary: KEY }, proposal(original.replace('GameBridge source draft loaded', KEY)) ]) {
    await assert.rejects(generateModCode({ plan, files }, { apiKey: KEY, fetchImpl: async () => completion(response) }), error => {
      assert.equal(error.code, 'CREDENTIAL_IN_RESPONSE'); assert.ok(!String(error).includes(KEY)); return true;
    });
  }
  let calls = 0;
  const changed = structuredClone(files);
  changed.find(file => file.path === 'ModEntry.cs').content = original.replace('GameBridge source draft loaded', KEY);
  await assert.rejects(generateModCode({ plan, files: changed }, { apiKey: KEY, fetchImpl: async () => { calls++; return completion(proposal()); } }), error => error.code === 'CREDENTIAL_IN_REQUEST');
  assert.equal(calls, 0);
});

test('invalid or changed fixed input contexts cannot trigger a paid generation', async () => {
  let calls = 0; const options = { apiKey: KEY, fetchImpl: async () => { calls++; return completion(proposal()); } };
  const changed = structuredClone(files); changed.find(file => file.path === 'ModConfig.cs').content += '// changed';
  for (const input of [{ plan: { ...plan, hostGame: 'gta-v' }, files }, { plan, files: changed }, { plan, files: [] }, { plan, files: files.concat(files.filter(file => file.path === 'ModEntry.cs')) }]) await assert.rejects(generateModCode(input, options));
  assert.equal(calls, 0);
});

test('diagnostic count, message size, severity and file paths are bounded before repair', () => {
  assert.throws(() => sanitizeCompilerDiagnostics(Array.from({ length: 65 }, () => ({ code: 'CS1002', severity: 'error', message: '; expected' }))));
  assert.throws(() => sanitizeCompilerDiagnostics([{ code: 'CS1002', severity: 'error', message: 'x'.repeat(4001) }]));
  assert.throws(() => sanitizeCompilerDiagnostics([{ code: 'CS1002', severity: 'fatal', message: '; expected' }]));
  assert.deepEqual(sanitizeCompilerDiagnostics([{ code: 'CS1002', severity: 'error', message: 'Location /tmp; expected.', file: 'ModEntry.cs', line: 14 }]), [{ code: 'CS1002', severity: 'error', message: 'Location [local-path]; expected.', file: 'ModEntry.cs', line: 14 }]);
});
