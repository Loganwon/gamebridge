// GameBridge's fixed, parameterized SMAPI source generator.
// It never executes model text, writes a game directory, or claims game validation.
const HOST = 'stardew-valley';
const TYPES = new Set(['speed_burst', 'melee_modifier']);
const STATUSES = new Set(['draft_supported', 'needs_assets', 'needs_adapter', 'unsupported']);
const REFERENCES = Object.freeze([
  { title: 'SMAPI mod structure and .NET target', url: 'https://wiki.stardewvalley.net/Modding:Modder_Guide/Get_Started' },
  { title: 'SMAPI events', url: 'https://wiki.stardewvalley.net/Modding:Modder_Guide/APIs/Events' },
  { title: 'Stardew Valley 1.6 Buff API', url: 'https://wiki.stardewvalley.net/Modding:Buffs' },
  { title: 'Pinned ModBuildConfig 4.4.0', url: 'https://www.nuget.org/packages/Pathoschild.Stardew.ModBuildConfig/4.4.0' },
  { title: 'Mod author example of applying and removing a namespaced buff', url: 'https://github.com/Pathoschild/StardewMods/blob/develop/TractorMod/Framework/TractorManager.cs' },
]);

function record(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error(`Invalid ${name}.`);
}
function string(value, max, name, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof value !== 'string' || !value.trim() || value.length > max || controls.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}
function bounded(value, low, high, name, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${name}.`);
  return value;
}

function checkedPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.schemaVersion !== 1) throw new Error('Unsupported plan schema.');
  if (plan.hostGame !== HOST) throw new Error('No source generator is registered for this host game.');
  string(plan.title, 120, 'plan title');
  string(plan.sourceGame, 120, 'source game');
  string(plan.summary, 1800, 'plan summary', true);
  if (!Array.isArray(plan.mechanics) || plan.mechanics.length < 1 || plan.mechanics.length > 2) throw new Error('A SMAPI draft requires one or two declared mechanics.');
  if (!Array.isArray(plan.requirements) || plan.requirements.length < 1 || plan.requirements.length > 32) throw new Error('The original requirement list must be retained.');
  const ids = new Set();
  for (const requirement of plan.requirements) {
    record(requirement, ['id', 'description', 'capability', 'status', 'reason'], 'requirement');
    string(requirement.id, 64, 'requirement id');
    if (ids.has(requirement.id)) throw new Error('Duplicate requirement id.');
    ids.add(requirement.id);
    const original = requirement.id === 'original-request';
    if (original && requirement.capability !== 'request_scope') throw new Error('The original request row must remain informational.');
    string(requirement.description, original ? 8000 : 2000, 'requirement description', true);
    string(requirement.capability, 100, 'requirement capability');
    string(requirement.reason, 1000, 'requirement reason', true);
    if (!STATUSES.has(requirement.status)) throw new Error('Unknown requirement status.');
  }
  for (const [field, max] of [['assetRequirements', 16], ['limitations', 24]]) {
    if (!Array.isArray(plan[field]) || plan[field].length > max) throw new Error(`Invalid ${field}.`);
    plan[field].forEach(value => string(value, 1000, field, true));
  }
  const types = new Set(), keys = new Set();
  for (const mechanic of plan.mechanics) {
    record(mechanic, ['type', 'key', 'amount', 'durationTicks', 'cooldownTicks'], 'mechanic');
    if (!TYPES.has(mechanic.type) || types.has(mechanic.type)) throw new Error('Unknown or duplicate mechanic.');
    if (typeof mechanic.key !== 'string' || !/^[A-Z]$/.test(mechanic.key) || keys.has(mechanic.key)) throw new Error('A mechanic needs a unique A–Z key.');
    types.add(mechanic.type); keys.add(mechanic.key);
    bounded(mechanic.amount, 1, mechanic.type === 'speed_burst' ? 6 : 3, 'amount', mechanic.type === 'speed_burst');
    bounded(mechanic.durationTicks, 1, 600, 'durationTicks');
    bounded(mechanic.cooldownTicks, mechanic.durationTicks, 3600, 'cooldownTicks');
    if (!plan.requirements.some(requirement => requirement.capability === mechanic.type && requirement.status === 'draft_supported')) throw new Error('Each generated mechanic needs an explicit draft-supported requirement.');
  }
  // The model cannot claim a character, original animation, or asset was generated.
  for (const requirement of plan.requirements) {
    if (requirement.id === 'original-request' && requirement.capability === 'request_scope') continue;
    if (requirement.status === 'draft_supported' && !types.has(requirement.capability)) throw new Error('A draft-supported requirement has no implemented generator.');
  }
  return plan;
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const prose = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '&#96;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('\r', '').replaceAll('\n', ' / ');
const number = value => Number.isInteger(value) ? String(value) : String(value);

function source(mechanics) {
  const definitions = mechanics.map((mechanic, index) => `        new Mechanic(${index}, SButton.${mechanic.key}, ${mechanic.type === 'speed_burst' ? 'false' : 'true'}, ${number(mechanic.amount)}f, ${mechanic.durationTicks}, ${mechanic.cooldownTicks})`).join(',\n');
  return `// Generated from GameBridge's fixed SMAPI template. No model text is executed.
// Target: Stardew Valley 1.6.14+ / SMAPI 4.5.2+. Unbuilt, untested source draft.
using System;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buffs;
using StardewValley.Tools;

namespace GameBridge.Generated;

public sealed class ModEntry : Mod
{
    private const string BuffPrefix = "GameBridge.Generated.Mod.";
    private ModConfig Config = new();
    private readonly Mechanic[] Mechanics =
    {
${definitions}
    };

    public override void Entry(IModHelper helper)
    {
        this.Config = helper.ReadConfig<ModConfig>();
        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.Saving += (_, _) => this.RemoveOwnBuffs();
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.ResetSession();
        helper.Events.Player.Warped += (_, e) => { if (e.IsLocalPlayer) this.RemoveOwnBuffs(); };
        this.Monitor.Log("GameBridge source draft loaded. Review config.json and validate in a new single-player save.", LogLevel.Info);
    }

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (!this.Config.Enabled || !Context.IsWorldReady || !Context.IsPlayerFree || Context.IsMultiplayer)
            return;

        foreach (Mechanic mechanic in this.Mechanics)
        {
            if (e.Button != mechanic.Key || mechanic.CooldownLeft > 0)
                continue;
            if (mechanic.Melee && Game1.player.CurrentTool is not MeleeWeapon)
                continue;

            BuffEffects effects = new();
            if (mechanic.Melee)
                effects.AttackMultiplier.Value = mechanic.Amount - 1f;
            else
                effects.Speed.Value = (int)mechanic.Amount;

            // A namespaced, finite-duration buff leaves equipment and save fields intact.
            Buff buff = new Buff(
                id: BuffPrefix + mechanic.Index,
                source: "GameBridge",
                displayName: mechanic.Melee ? "GameBridge melee draft" : "GameBridge speed draft",
                description: "Generated mechanism draft; source-game fidelity is not validated.",
                duration: (int)Math.Ceiling(mechanic.DurationTicks * (1000d / 60d)),
                effects: effects
            );
            Game1.player.applyBuff(buff);
            mechanic.ActiveTicks = mechanic.DurationTicks;
            mechanic.CooldownLeft = mechanic.CooldownTicks;
            mechanic.ActiveTool = mechanic.Melee ? Game1.player.CurrentTool : null;
            this.Helper.Input.Suppress(e.Button);
        }
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady)
            return;
        // Using a weapon can temporarily make the player non-free; keep the
        // melee Buff through the swing instead of removing it before impact.
        if (!this.Config.Enabled || Context.IsMultiplayer || Game1.activeClickableMenu is not null || Game1.eventUp || Game1.player.health <= 0)
        {
            this.RemoveOwnBuffs();
            return;
        }
        foreach (Mechanic mechanic in this.Mechanics)
        {
            if (mechanic.CooldownLeft > 0)
                mechanic.CooldownLeft--;
            if (mechanic.ActiveTicks <= 0)
                continue;
            mechanic.ActiveTicks--;
            bool switchedTool = mechanic.Melee && !ReferenceEquals(mechanic.ActiveTool, Game1.player.CurrentTool);
            if (mechanic.ActiveTicks == 0 || switchedTool)
                this.RemoveOwnBuff(mechanic);
        }
    }

    private void RemoveOwnBuff(Mechanic mechanic)
    {
        if (Context.IsWorldReady)
            Game1.player.buffs.Remove(BuffPrefix + mechanic.Index);
        mechanic.ActiveTicks = 0;
        mechanic.ActiveTool = null;
    }

    private void RemoveOwnBuffs()
    {
        foreach (Mechanic mechanic in this.Mechanics)
            this.RemoveOwnBuff(mechanic);
    }

    private void ResetSession()
    {
        this.RemoveOwnBuffs();
        foreach (Mechanic mechanic in this.Mechanics)
            mechanic.CooldownLeft = 0;
    }

    private sealed class Mechanic
    {
        public int Index { get; }
        public SButton Key { get; }
        public bool Melee { get; }
        public float Amount { get; }
        public int DurationTicks { get; }
        public int CooldownTicks { get; }
        public int ActiveTicks { get; set; }
        public int CooldownLeft { get; set; }
        public Tool? ActiveTool { get; set; }

        public Mechanic(int index, SButton key, bool melee, float amount, int durationTicks, int cooldownTicks)
        {
            this.Index = index;
            this.Key = key;
            this.Melee = melee;
            this.Amount = amount;
            this.DurationTicks = durationTicks;
            this.CooldownTicks = cooldownTicks;
        }
    }
}
`;
}

function readme(plan, unresolved) {
  const requirements = plan.requirements.map(item => `- [${item.status}] ${prose(item.description)} — ${prose(item.reason)}`).join('\n');
  const mechanics = plan.mechanics.map(item => `- ${item.type}：${item.key} 键，amount=${item.amount}，持续 ${item.durationTicks} tick，冷却 ${item.cooldownTicks} tick。`).join('\n');
  return `# ${prose(plan.title)} — 未构建的 SMAPI 源码草稿

宿主：Stardew Valley 1.6.14+；玩法来源意图：${prose(plan.sourceGame)}。适配接口：SMAPI 4.5.2+。生成器版本：0.1.0。

${prose(plan.summary)}

## 当前验证状态

已完成固定生成器的参数、文件路径和工程结构检查。尚未执行 C# 编译，也未在游戏中验证。此目录没有 DLL，不能直接作为可玩的 Mod 安装。不是完整来源游戏或角色、武器、招式的自动迁移。

本次只生成两种受限机制模板：短时速度增益，或手持原生近战武器时的短时攻击倍率。速度增益不等于带碰撞位移的冲刺；攻击倍率不创建来源武器、动画、判定框、连招或投射物。来源游戏的参数、反馈、素材与动作时序仍需单独适配和验收。

## 本次生成的机制

${mechanics}

## 保留的完整需求清单

${requirements}

未实现需求数量：${unresolved.length}。这些需求未被删除或视为完成。需要的素材与已知限制继续保存在 plan.json 和 validation-report.json；包内不含任何商业游戏资源。

## 构建与新存档验证

准备 .NET 6 SDK、合法安装的 Stardew Valley 1.6.14+ 和 SMAPI 4.5.2+。工程固定使用 Pathoschild.Stardew.ModBuildConfig 4.4.0；该包需要本机游戏引用，不能仅凭 NuGet 下载验证兼容。

\`\`\`sh
dotnet build GameBridge.Generated.csproj -c Release -p:GamePath="/path/to/Stardew Valley"
\`\`\`

工程已关闭自动部署和构建后自动安装。编译通过后，人工检查输出，再将项目 DLL、manifest.json 和 config.json 放入独立 Mods/GameBridgeGenerated 目录，在新的单人测试存档中验证。不要复制游戏 DLL 或原始资源一起分发。

config.json 默认 Enabled=false。确认构建结果与未实现项后，将它设为 true 才启用按键动作。模板在菜单、跨地图和保存时清理自身的短时 Buff，不永久更改武器或玩家速度字段；不会移除其他 Mod 的 Buff。多人尚未实现，模板在多人会话中不生效。

先检查按键冲突、冷却和时长，再检查宿主碰撞、近战伤害、武器切换、菜单、保存、退出及重开。记录游戏、SMAPI、系统和插件版本；编译或实机失败时保留日志，不能把源文件生成当作融合体验完成。

## 接口依据

${REFERENCES.map(reference => `- [${reference.title}](${reference.url})`).join('\n')}
`;
}

/** Return source files only. This function performs no filesystem/network/game access. */
export function generateProject(input) {
  const plan = checkedPlan(input);
  const unresolved = plan.requirements.filter(item => item.status !== 'draft_supported');
  const report = {
    status: 'static_checked',
    artifactType: 'smapi-source-draft',
    generatorVersion: '0.1.0',
    hostGame: HOST,
    sourceGame: plan.sourceGame,
    targets: { stardewValley: '1.6.14+', smapi: '4.5.2+', dotnet: 'net6.0', modBuildConfig: '4.4.0' },
    staticValidation: { passed: true, kind: 'generator-contract', checks: ['bounded-mechanic-parameters', 'fixed-project-and-file-paths', 'original-requirements-retained', 'no-game-assets-or-game-assemblies'] },
    build: 'not_run',
    game: 'not_run',
    readyToInstall: false,
    completeRequirementCoverage: false,
    declaredTemplateRequirementsResolved: unresolved.length === 0,
    unimplementedRequirements: structuredClone(unresolved),
    assetRequirements: [...plan.assetRequirements],
    limitations: [
      'Only a source engineering draft was produced; no game DLL or playable result is included.',
      'speed_burst is a finite speed Buff, not a source-game dash controller.',
      'melee_modifier changes a native melee attack multiplier, not weapon assets, moves or hitboxes.',
      'Target versions and generated APIs require actual compilation and single-player game validation.',
      ...plan.limitations,
    ],
    references: REFERENCES.map(reference => ({ ...reference })),
  };
  const files = [
    { path: 'GameBridge.Generated.csproj', content: `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net6.0</TargetFramework>\n    <LangVersion>latest</LangVersion>\n    <Nullable>enable</Nullable>\n    <AssemblyName>GameBridge.Generated</AssemblyName>\n    <RootNamespace>GameBridge.Generated</RootNamespace>\n    <Version>0.1.0</Version>\n    <EnableModDeploy>false</EnableModDeploy>\n    <EnableModZip>false</EnableModZip>\n    <EnableGameDebugging>false</EnableGameDebugging>\n    <EnableHarmony>false</EnableHarmony>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Pathoschild.Stardew.ModBuildConfig" Version="4.4.0" />\n  </ItemGroup>\n</Project>\n` },
    { path: 'manifest.json', content: json({ Name: plan.title, Author: 'GameBridge user', Version: '0.1.0', Description: 'Generated source draft; compile and validate before use.', UniqueID: 'GameBridge.Generated.Mod', EntryDll: 'GameBridge.Generated.dll', MinimumApiVersion: '4.5.2', UpdateKeys: [] }) },
    { path: 'ModEntry.cs', content: source(plan.mechanics) },
    { path: 'ModConfig.cs', content: 'namespace GameBridge.Generated;\n\npublic sealed class ModConfig\n{\n    public bool Enabled { get; set; } = false;\n}\n' },
    { path: 'config.json', content: json({ Enabled: false }) },
    { path: 'README.md', content: readme(plan, unresolved) },
    { path: 'plan.json', content: json(plan) },
    { path: 'validation-report.json', content: json(report) },
  ];
  return { files, report };
}

export const SMAPI_GENERATOR_TARGET = Object.freeze({ hostGame: HOST, status: 'source-draft-only', references: REFERENCES });
