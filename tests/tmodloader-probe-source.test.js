// Source-contract regression checks only: these do not compile, load or run a Mod.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const probeRoot = fileURLToPath(new URL('../probes/tmodloader/', import.meta.url));
const projectRoot = path.join(probeRoot, 'GameBridgeHostProbe');
const sourceFiles = ['ProbeMod.cs', 'ProbePlayer.cs', 'ProbeGlobalItem.cs', 'ProbeSystem.cs'];
const contract = JSON.parse(await readFile(path.join(probeRoot, 'probe-contract.json'), 'utf8'));
const project = await readFile(path.join(projectRoot, 'GameBridgeHostProbe.csproj'), 'utf8');
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await readFile(path.join(projectRoot, file), 'utf8')])));
const allSource = Object.values(sources).join('\n');

test('tModLoader probe source records all runtime capabilities as unverified and is not installable', () => {
  assert.equal(contract.scope, 'trusted-uncompiled-host-probe-source');
  assert.equal(contract.provenance, 'project-authored-not-model-generated');
  assert.equal(contract.hostGame, 'terraria');
  assert.equal(contract.sourceGame, null);
  assert.equal(contract.status.realModBuild, 'not_run');
  assert.equal(contract.status.packaging, 'not_run');
  assert.equal(contract.status.game, 'not_run');
  assert.equal(contract.status.hostAdmission, 'blocked');
  assert.equal(contract.status.readyToInstall, false);
  assert.ok(contract.capabilitiesToProbe.length >= 6);
  assert.ok(contract.capabilitiesToProbe.every(capability => capability.status === 'unverified'));
  assert.ok(contract.officialApiSources.every(url => url.startsWith('https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/')));
});

test('compile-only probe pins the exact x64 SDK contract and only imports bundled SDK files', async () => {
  const sdk = JSON.parse(await readFile(path.join(projectRoot, 'global.json'), 'utf8'));
  assert.deepEqual(sdk.sdk, { version: '8.0.427', rollForward: 'disable', allowPrerelease: false });
  assert.equal(contract.hostRuntime.sdkVersion, sdk.sdk.version);
  assert.equal(contract.hostRuntime.sdkArchitecture, 'x64');
  assert.equal(contract.hostRuntime.exactVersion, '2026.08.3.0');
  const imports = [...project.matchAll(/<Import\s+Project="([^"]+)"\s+Sdk="([^"]+)"\s*\/>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(imports, [['Sdk.props', 'Microsoft.NET.Sdk'], ['Sdk.targets', 'Microsoft.NET.Sdk']]);
  assert.equal((project.match(/<Import\b/g) || []).length, imports.length);
  for (const setting of ['ImportDirectoryBuildProps', 'ImportDirectoryBuildTargets', 'RunAnalyzers', 'RunAnalyzersDuringBuild', 'EnableNETAnalyzers', 'AllowUnsafeBlocks', 'UseSharedCompilation', 'EnableDefaultCompileItems']) {
    assert.match(project, new RegExp(`<${setting}>false</${setting}>`));
  }
  assert.doesNotMatch(project, /<(?:Exec|UsingTask|Analyzer|PackageReference|ProjectReference)\b|(?:Before|After)Targets="Build"/);
  assert.deepEqual([...project.matchAll(/<Compile Include="([^"]+)"/g)].map(match => match[1]), sourceFiles);
});

test('compile-only references are explicit local metadata inputs and cannot copy game assemblies', async () => {
  const referenceTags = [...project.matchAll(/<Reference\b[^>]+\/>/g)].map(match => match[0]);
  assert.equal(referenceTags.length, 2);
  assert.ok(referenceTags.every(tag => tag.includes('Private="false"') && !tag.includes('*')));
  assert.match(referenceTags[0], /\$\(GameBridgeTmlPath\)\/tModLoader\.dll/);
  assert.match(referenceTags[1], /\$\(GameBridgeReferencePaths\)/);
  assert.match(project, /Name="RequireRealHostReferences" BeforeTargets="ResolveReferences"/);
  assert.match(project, /GameBridgePreflightApproved/);
  assert.match(project, /Do not use stub game assemblies/);
  const nuget = await readFile(path.join(projectRoot, 'NuGet.Config'), 'utf8');
  assert.match(nuget, /<packageSources>\s*<clear\s*\/>\s*<\/packageSources>/);
  assert.equal(contract.buildBoundary.compileOnly, true);
  assert.equal(contract.buildBoundary.automaticExecution, false);
  assert.equal(contract.buildBoundary.automaticInstallation, false);
  assert.equal(contract.buildBoundary.referenceValidation, 'external-preflight-required-not-proved-by-msbuild-flag');
});

test('trusted probe source has no added content, persistence, injection, external code or resource loading', () => {
  assert.doesNotMatch(allSource, /\b(?:ModItem|ModProjectile|ModTile|SaveData|LoadData|SaveWorldData|LoadWorldData|AddRecipes|NewItem|QuickSpawnItem|NewProjectile|DllImport|LibraryImport|Harmony|HttpClient|WebClient|Process|Assembly\.Load|File\.|Directory\.|ModContent\.Request)\b/);
  assert.equal(contract.resources.policy, 'resource-owning-host-only');
  assert.deepEqual(contract.resources.bundledHostAssets, []);
  assert.deepEqual(contract.resources.bundledHostAssemblies, []);
  assert.equal(contract.resources.newItems, false);
  assert.equal(contract.resources.newRecipes, false);
  assert.equal(contract.limits.savePersistence, false);
});

test('probe eligibility remains a pure query with consumption in actual native animation start', () => {
  const player = sources['ProbePlayer.cs'];
  const query = player.match(/internal bool CanStartSwing\(\)\s*\{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(query);
  assert.doesNotMatch(query, /(?:_\w+\s*(?:\+\+|--|[+\-*/]?=)|\b(?:Log|Interrupt|StartSwing)\()/);
  const canUse = sources['ProbeGlobalItem.cs'].match(/public override bool CanUseItem\([\s\S]*?\n    \}/)?.[0];
  assert.ok(canUse);
  assert.doesNotMatch(canUse, /\b(?:StartSwing|RecordHit|Interrupt)\(/);
  assert.match(player, /internal void StartSwing\(Item item\)[\s\S]*?_stamina -= cost;/);
  assert.match(sources['ProbeGlobalItem.cs'], /public override void UseAnimation\(Item item, Player player\)/);
  assert.match(sources['ProbeGlobalItem.cs'], /public override void OnHitNPC\(Item item, Player player, NPC target, NPC\.HitInfo hit, int damageDone\)/);
});

test('default single-player gate, bounded logs and cancellation suppression are retained in probe source', () => {
  const player = sources['ProbePlayer.cs'];
  assert.match(player, /private bool _enabled = false;/);
  assert.match(player, /!Main\.dedServ[\s\S]*?Main\.netMode == NetmodeID\.SinglePlayer && Player\.whoAmI == Main\.myPlayer/);
  assert.match(player, /MaximumLogRecords = 64;/);
  assert.match(player, /_logRecords >= MaximumLogRecords/);
  assert.match(player, /ReferenceEquals\(Player\.HeldItem, _ownedItem\)/);
  assert.match(sources['ProbeGlobalItem.cs'], /IsSuppressedSwing\(item\)\)\s*return false;/);
  assert.match(sources['ProbeSystem.cs'], /public override void OnWorldUnload\(\)/);
  assert.match(sources['ProbeSystem.cs'], /ResetForWorldExit\(\)/);
  assert.match(player, /public override void OnHurt\(Player\.HurtInfo info\)/);
  assert.match(player, /public override void UpdateDead\(\)/);
});

test('probe inputs contain only reviewable source and metadata, never packaged host or Mod binaries', async () => {
  const allowed = new Set(['.md', '.json', '.cs', '.csproj', '.config']);
  async function inspectDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'probe source must not hide files through symlinks');
      const entryPath = path.join(directory, entry.name);
      if (directory === projectRoot && entry.isDirectory() && ['bin', 'obj'].includes(entry.name)) continue;
      if (entry.isDirectory()) await inspectDirectory(entryPath);
      else {
        assert.equal(entry.isFile(), true);
        assert.ok(entry.name === '.gitignore' || allowed.has(path.extname(entry.name).toLowerCase()), `unexpected probe file type: ${entry.name}`);
      }
    }
  }
  await inspectDirectory(probeRoot);
});
