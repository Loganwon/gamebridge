// CONTRACT SIMULATION ONLY. Run only in the caller's OS sandbox.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using GameBridge.Generated;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buffs;
using StardewValley.Tools;

namespace GameBridge.ContractSimulation;

public static class Program
{
    private const string SpeedId = "GameBridge.Generated.Mod.0";
    private const string MeleeId = "GameBridge.Generated.Mod.1";
    private const string OtherId = "AnotherMod.Preserved";
    private static int Assertions;
    private static Contract Expected = new();
    private static readonly List<CaseResult> Results = new();

    public static int Main(string[] args)
    {
        if (args.Length > 1) return 2;
        if (args.Length == 1)
        {
            // The caller provides this local contract file; no environment or secrets are read.
            Expected = JsonSerializer.Deserialize<Contract>(File.ReadAllText(args[0])) ?? throw new Exception("Invalid contract.");
        }
        if (!Enum.TryParse<SButton>(Expected.SpeedKey, out _) || !Enum.TryParse<SButton>(Expected.MeleeKey, out _) ||
            Expected.DurationTicks < 1 || Expected.CooldownTicks < Expected.DurationTicks || Expected.CooldownTicks > 3600)
            throw new Exception("Contract parameters are outside the harness limits.");

        Run("disabled_config_has_no_effect", () => {
            World world = new(false); world.PressSpeed(); world.PressMelee();
            Check(Game1.player.AppliedCount == 0, "Disabled config must not apply buffs.");
            Check(world.Helper.Input.Suppressed.Count == 0, "Disabled config must not suppress input.");
        });
        Run("input_context_guards", () => {
            World world = new(); Context.IsWorldReady = false; world.PressSpeed();
            Check(Game1.player.AppliedCount == 0, "World-unready input must not apply a buff.");
            Context.IsWorldReady = true; Context.IsPlayerFree = false; world.PressSpeed();
            Check(Game1.player.AppliedCount == 0, "Non-free input must not apply a buff.");
            Context.IsPlayerFree = true; Context.IsMultiplayer = true; world.PressSpeed(); world.PressMelee();
            Check(Game1.player.AppliedCount == 0, "Multiplayer input must not apply buffs.");
        });
        Run("speed_value_duration_and_suppression", () => {
            World world = new(); world.PressSpeed();
            Check(Game1.player.buffs.Contains(SpeedId), "Speed buff must exist.");
            Check(Game1.player.buffs[SpeedId].Effects.Speed.Value == Expected.SpeedAmount, "Speed amount must match the declared contract.");
            int expectedMs = (int)Math.Ceiling(Expected.DurationTicks * 1000d / 60d);
            Check(Game1.player.buffs[SpeedId].Duration == expectedMs, "Buff duration must match declared ticks: expected " + expectedMs + " ms, observed " + Game1.player.buffs[SpeedId].Duration + " ms.");
            Check(world.Helper.Input.Suppressed.SequenceEqual(new[] { world.SpeedKey }), "Only the accepted speed key is suppressed.");
            world.OtherPreserved();
        });
        Run("melee_requires_weapon_and_has_declared_multiplier", () => {
            World world = new(); Game1.player.CurrentTool = null; world.PressMelee();
            Check(!Game1.player.buffs.Contains(MeleeId), "Empty hands must not get melee bonus.");
            Check(world.Helper.Input.Suppressed.Count == 0, "Rejected melee input must not be suppressed.");
            Game1.player.CurrentTool = new Tool(); world.PressMelee();
            Check(!Game1.player.buffs.Contains(MeleeId), "A non-melee tool must not get melee bonus.");
            Game1.player.CurrentTool = new MeleeWeapon(); world.PressMelee();
            Check(Game1.player.buffs.Contains(MeleeId), "Melee weapon must permit the bonus.");
            Check(Math.Abs(Game1.player.buffs[MeleeId].Effects.AttackMultiplier.Value - (Expected.MeleeMultiplier - 1f)) < .0001f, "Additive attack bonus must equal declared multiplier minus one.");
            Check(world.Helper.Input.Suppressed.SequenceEqual(new[] { world.MeleeKey }), "Only accepted melee input must be suppressed.");
            world.OtherPreserved();
        });
        Run("active_duration_and_cooldown", () => {
            World world = new(); world.PressSpeed(); world.PressSpeed();
            Check(Game1.player.AppliedCount == 1, "Repeated key must be blocked by cooldown.");
            world.Tick(Expected.DurationTicks - 1);
            Check(Game1.player.buffs.Contains(SpeedId), "Buff must remain before its duration boundary.");
            world.Tick(1); Check(!Game1.player.buffs.Contains(SpeedId), "Buff must end at its declared tick boundary.");
            if (Expected.CooldownTicks > Expected.DurationTicks)
            {
                world.PressSpeed(); Check(Game1.player.AppliedCount == 1, "Expired buff cannot bypass remaining cooldown.");
                world.Tick(Expected.CooldownTicks - Expected.DurationTicks);
            }
            world.PressSpeed(); Check(Game1.player.AppliedCount == 2, "Buff must become available at cooldown boundary.");
            world.OtherPreserved();
        });
        Run("melee_duration_and_cooldown", () => {
            World world = new(); world.PressMelee(); world.PressMelee();
            Check(Game1.player.AppliedCount == 1, "Repeated melee input must respect cooldown.");
            world.Tick(Expected.DurationTicks - 1);
            Check(Game1.player.buffs.Contains(MeleeId), "Melee bonus must remain before its duration boundary.");
            world.Tick(1); Check(!Game1.player.buffs.Contains(MeleeId), "Melee bonus must end at its duration boundary.");
            if (Expected.CooldownTicks > Expected.DurationTicks)
            {
                world.PressMelee(); Check(Game1.player.AppliedCount == 1, "Expired melee bonus must not bypass cooldown.");
                world.Tick(Expected.CooldownTicks - Expected.DurationTicks);
            }
            world.PressMelee(); Check(Game1.player.AppliedCount == 2, "Melee bonus must recover at cooldown boundary."); world.OtherPreserved();
        });
        Run("mechanic_timers_are_independent", () => {
            World world = new(); int stagger = Math.Min(10, Expected.DurationTicks - 1);
            world.PressSpeed(); world.Tick(stagger); world.PressMelee();
            Check(Game1.player.AppliedCount == 2, "Speed cooldown must not block melee activation.");
            if (stagger > 0)
            {
                world.Tick(Expected.DurationTicks - stagger);
                Check(!Game1.player.buffs.Contains(SpeedId) && Game1.player.buffs.Contains(MeleeId), "Staggered bonuses must expire on their separate timers.");
                world.Tick(stagger);
                Check(!Game1.player.buffs.Contains(MeleeId), "Staggered melee bonus must expire after its own duration.");
            }
            world.OtherPreserved();
        });
        Run("melee_survives_normal_swing_nonfree_state", () => {
            World world = new(); world.PressMelee(); Context.IsPlayerFree = false; world.Tick(1);
            Check(Game1.player.buffs.Contains(MeleeId), "Melee buff must not disappear merely because a swing temporarily makes the player non-free.");
            world.OtherPreserved();
        });
        Run("switching_melee_weapon_removes_only_melee_bonus", () => {
            World world = new(); world.ActivateBoth(); Game1.player.CurrentTool = new MeleeWeapon(); world.Tick(1);
            Check(!Game1.player.buffs.Contains(MeleeId), "Changing the weapon must remove its melee bonus.");
            Check(Game1.player.buffs.Contains(SpeedId), "Changing the weapon must not remove speed bonus.");
            world.OtherPreserved();
        });
        Run("switching_to_nonmelee_removes_melee_bonus", () => {
            World world = new(); world.PressMelee(); Game1.player.CurrentTool = new Tool(); world.Tick(1);
            Check(!Game1.player.buffs.Contains(MeleeId), "Switching to a non-melee tool must remove the melee bonus."); world.OtherPreserved();
        });
        Cleanup("menu_clears_own_buffs", world => { Game1.activeClickableMenu = new object(); world.Tick(1); });
        Cleanup("saving_clears_own_buffs", world => world.Helper.Events.GameLoop.Save());
        Cleanup("local_warp_clears_own_buffs", world => world.Helper.Events.Player.Warp(true));
        Cleanup("death_clears_own_buffs", world => { Game1.player.health = 0; world.Tick(1); });
        Cleanup("event_clears_own_buffs", world => { Game1.eventUp = true; world.Tick(1); });
        Cleanup("multiplayer_transition_clears_own_buffs", world => { Context.IsMultiplayer = true; world.Tick(1); });
        Cleanup("disabling_config_clears_own_buffs", world => { world.Helper.Config.Enabled = false; world.Tick(1); });
        Run("nonlocal_warp_does_not_clear_own_buffs", () => {
            World world = new(); world.ActivateBoth(); world.Helper.Events.Player.Warp(false);
            Check(Game1.player.buffs.Contains(SpeedId) && Game1.player.buffs.Contains(MeleeId), "Another player's warp must not clear local bonuses."); world.OtherPreserved();
        });
        Run("save_cleanup_does_not_reset_cooldown", () => {
            World world = new(); world.PressSpeed(); world.Helper.Events.GameLoop.Save(); world.PressSpeed();
            Check(Game1.player.AppliedCount == 1, "Saving must not bypass cooldown.");
            world.Tick(Expected.CooldownTicks); world.PressSpeed();
            Check(Game1.player.AppliedCount == 2, "Cooldown must progress after save cleanup."); world.OtherPreserved();
        });
        Run("title_event_cleans_and_resets_session_contract", () => {
            World world = new(); world.ActivateBoth(); world.Helper.Events.GameLoop.Title();
            world.NoOwnBuffs(); world.PressSpeed();
            Check(Game1.player.buffs.Contains(SpeedId), "Title reset must clear cooldown for a new simulated session."); world.OtherPreserved();
            // Actual game player lifetime / IsWorldReady ordering is not modeled here.
        });
        Run("unrelated_input_has_no_effect", () => {
            World world = new();
            SButton unrelated = Enum.GetValues<SButton>().First(button => button != world.SpeedKey && button != world.MeleeKey);
            world.Helper.Events.Input.Press(unrelated);
            Check(Game1.player.AppliedCount == 0 && world.Helper.Input.Suppressed.Count == 0, "Unrelated keys must remain untouched."); world.OtherPreserved();
        });

        bool passed = Results.All(result => result.Passed);
        Console.WriteLine(JsonSerializer.Serialize(new {
            scope = "contract-simulation-only", host = "project-owned-test-double", passed,
            cases = Results.Count, assertions = Assertions, results = Results,
            realModBuild = "not_run", game = "not_run", readyToInstall = false,
            limitation = "No real SMAPI/game references or execution. Only simplified event and Buff contracts are simulated; passing cannot establish API compatibility or gameplay fidelity."
        }));
        return passed ? 0 : 1;
    }

    private static void Cleanup(string id, Action<World> action) => Run(id, () => { World world = new(); world.ActivateBoth(); action(world); world.NoOwnBuffs(); });
    private static void Run(string id, Action test)
    {
        try { test(); Results.Add(new(id, true, null)); }
        catch (Exception error) { Results.Add(new(id, false, error.Message)); }
    }
    private static void Check(bool condition, string message) { Assertions++; if (!condition) throw new Exception(message); }
    private sealed record CaseResult(string Id, bool Passed, string? Failure);
    public sealed class Contract
    {
        public string SpeedKey { get; set; } = "V";
        public string MeleeKey { get; set; } = "B";
        public int SpeedAmount { get; set; } = 2;
        public float MeleeMultiplier { get; set; } = 1.5f;
        public int DurationTicks { get; set; } = 120;
        public int CooldownTicks { get; set; } = 300;
    }
    private sealed class World
    {
        public FakeHelper Helper { get; }
        private readonly Buff Other;
        public SButton SpeedKey => Enum.Parse<SButton>(Expected.SpeedKey);
        public SButton MeleeKey => Enum.Parse<SButton>(Expected.MeleeKey);
        public World(bool enabled = true)
        {
            Context.IsWorldReady = true; Context.IsPlayerFree = true; Context.IsMultiplayer = false;
            Game1.player = new() { CurrentTool = new MeleeWeapon() }; Game1.activeClickableMenu = null; Game1.eventUp = false;
            this.Other = new(OtherId, "another-test", "other", "contract sentinel", 60000, new BuffEffects());
            Game1.player.buffs.Add(this.Other); this.Helper = new(enabled);
            ModEntry mod = new() { Helper = this.Helper }; mod.Entry(this.Helper);
        }
        public void PressSpeed() => this.Helper.Events.Input.Press(this.SpeedKey);
        public void PressMelee() => this.Helper.Events.Input.Press(this.MeleeKey);
        public void ActivateBoth() { this.PressSpeed(); this.PressMelee(); Check(Game1.player.buffs.Contains(SpeedId) && Game1.player.buffs.Contains(MeleeId), "Both bonuses must activate before cleanup test."); }
        public void Tick(int count) { for (int index = 0; index < count; index++) this.Helper.Events.GameLoop.Tick(); }
        public void OtherPreserved() => Check(Game1.player.buffs.Contains(OtherId) && ReferenceEquals(Game1.player.buffs[OtherId], this.Other), "Other mods' buffs must remain untouched.");
        public void NoOwnBuffs() { Check(!Game1.player.buffs.Contains(SpeedId) && !Game1.player.buffs.Contains(MeleeId), "Own bonuses must be removed."); this.OtherPreserved(); }
    }
}
