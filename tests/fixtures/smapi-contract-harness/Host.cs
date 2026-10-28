// CONTRACT SIMULATION ONLY: project-owned test doubles, not SMAPI or game code.
// This deliberately small fake host cannot prove real API or game compatibility.
using System;
using System.Collections.Generic;

namespace StardewModdingAPI
{
    public enum SButton { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z }
    public enum LogLevel { Info }
    public static class Context
    {
        public static bool IsWorldReady { get; set; }
        public static bool IsPlayerFree { get; set; }
        public static bool IsMultiplayer { get; set; }
    }
    public interface IMonitor { void Log(string message, LogLevel level); }
    public interface IModHelper
    {
        FakeEvents Events { get; }
        FakeInput Input { get; }
        T ReadConfig<T>();
    }
    public abstract class Mod
    {
        public IModHelper Helper { get; set; } = null!;
        public IMonitor Monitor { get; set; } = new FakeMonitor();
        public abstract void Entry(IModHelper helper);
    }
    public sealed class FakeMonitor : IMonitor
    {
        public readonly List<string> Messages = new();
        public void Log(string message, LogLevel level) => this.Messages.Add(message);
    }
    public sealed class FakeHelper : IModHelper
    {
        public FakeEvents Events { get; } = new();
        public FakeInput Input { get; } = new();
        public GameBridge.Generated.ModConfig Config { get; }
        public FakeHelper(bool enabled) { this.Config = new() { Enabled = enabled }; }
        public T ReadConfig<T>() => (T)(object)this.Config;
    }
    public sealed class FakeInput
    {
        public List<SButton> Suppressed { get; } = new();
        public void Suppress(SButton button) => this.Suppressed.Add(button);
    }
    public sealed class FakeEvents
    {
        public FakeInputEvents Input { get; } = new();
        public FakeGameLoopEvents GameLoop { get; } = new();
        public FakePlayerEvents Player { get; } = new();
    }
    public sealed class FakeInputEvents
    {
        public event EventHandler<Events.ButtonPressedEventArgs>? ButtonPressed;
        public void Press(SButton button) => this.ButtonPressed?.Invoke(this, new(button));
    }
    public sealed class FakeGameLoopEvents
    {
        public event EventHandler<Events.UpdateTickedEventArgs>? UpdateTicked;
        public event EventHandler<Events.SavingEventArgs>? Saving;
        public event EventHandler<Events.ReturnedToTitleEventArgs>? ReturnedToTitle;
        public void Tick() => this.UpdateTicked?.Invoke(this, new());
        public void Save() => this.Saving?.Invoke(this, new());
        public void Title() => this.ReturnedToTitle?.Invoke(this, new());
    }
    public sealed class FakePlayerEvents
    {
        public event EventHandler<Events.WarpedEventArgs>? Warped;
        public void Warp(bool local) => this.Warped?.Invoke(this, new(local));
    }
}
namespace StardewModdingAPI.Events
{
    public sealed class ButtonPressedEventArgs : EventArgs
    {
        public StardewModdingAPI.SButton Button { get; }
        public ButtonPressedEventArgs(StardewModdingAPI.SButton button) { this.Button = button; }
    }
    public sealed class UpdateTickedEventArgs : EventArgs { }
    public sealed class SavingEventArgs : EventArgs { }
    public sealed class ReturnedToTitleEventArgs : EventArgs { }
    public sealed class WarpedEventArgs : EventArgs
    {
        public bool IsLocalPlayer { get; }
        public WarpedEventArgs(bool local) { this.IsLocalPlayer = local; }
    }
}
namespace StardewValley.Buffs
{
    public sealed class ValueSlot<T> { public T Value { get; set; } = default!; }
    public sealed class BuffEffects
    {
        public ValueSlot<int> Speed { get; } = new();
        public ValueSlot<float> AttackMultiplier { get; } = new();
    }
}
namespace StardewValley
{
    public class Tool { }
    public sealed class Buff
    {
        public string Id { get; }
        public int Duration { get; }
        public Buffs.BuffEffects Effects { get; }
        public Buff(string id, string source, string displayName, string description, int duration, Buffs.BuffEffects effects)
        { this.Id = id; this.Duration = duration; this.Effects = effects; }
    }
    public sealed class FakeBuffCollection
    {
        private readonly Dictionary<string, Buff> values = new();
        public int Count => this.values.Count;
        public bool Contains(string id) => this.values.ContainsKey(id);
        public Buff this[string id] => this.values[id];
        public void Add(Buff buff) => this.values[buff.Id] = buff;
        public bool Remove(string id) => this.values.Remove(id);
    }
    public sealed class Farmer
    {
        public Tool? CurrentTool { get; set; }
        public int health = 100;
        public readonly FakeBuffCollection buffs = new();
        public int AppliedCount { get; private set; }
        public void applyBuff(Buff buff) { this.AppliedCount++; this.buffs.Add(buff); }
    }
    public static class Game1
    {
        public static Farmer player = new();
        public static object? activeClickableMenu;
        public static bool eventUp;
    }
}
namespace StardewValley.Tools
{
    public sealed class MeleeWeapon : StardewValley.Tool { }
}
