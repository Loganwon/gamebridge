using System;
using Terraria;
using Terraria.GameInput;
using Terraria.ID;
using Terraria.ModLoader;

namespace GameBridgeHostProbe;

public sealed class ProbePlayer : ModPlayer
{
    private const int MaximumStamina = 100;
    private const int FirstSwingCost = 30;
    private const int FollowupCost = 20;
    private const int FollowupWindowTicks = 30;
    private const int MaximumLogRecords = 64;

    private bool _enabled = false;
    private bool _ownsSwing;
    private bool _hitConfirmed;
    private Item? _ownedItem;
    private Item? _suppressedItem;
    private int _stage;
    private int _comboTicks;
    private int _stamina = MaximumStamina;
    private int _logRecords;

    private bool IsLocalSinglePlayer => !Main.dedServ
        && Main.netMode == NetmodeID.SinglePlayer && Player.whoAmI == Main.myPlayer;

    private bool InputContextReady => !Main.gameMenu && !Main.gamePaused
        && !Main.playerInventory && !Player.dead;

    internal bool IsActiveSession => IsLocalSinglePlayer && _enabled;

    public override void OnEnterWorld()
    {
        _enabled = false;
        _ownsSwing = false;
        _hitConfirmed = false;
        _ownedItem = null;
        _suppressedItem = null;
        _stage = 0;
        _comboTicks = 0;
        _stamina = MaximumStamina;
        _logRecords = 0;
    }

    public override void ProcessTriggers(TriggersSet triggersSet)
    {
        if (!IsLocalSinglePlayer || !InputContextReady)
            return;

        if (ProbeMod.ToggleProbe?.JustPressed == true)
        {
            if (_enabled)
            {
                Interrupt("disabled");
                _enabled = false;
            }
            else
            {
                // Enabling in the middle of an existing vanilla attack is ambiguous.
                if (Player.itemAnimation > 0 || Player.itemTime > 0)
                    return;
                _enabled = true;
                _stamina = MaximumStamina;
                Log("enabled");
            }
        }

        if (IsActiveSession && ProbeMod.CancelRecovery?.JustPressed == true)
            TryCancelRecovery();
    }

    public override void PreUpdate()
    {
        if (!IsLocalSinglePlayer)
        {
            // Never touch a remote player's or a multiplayer action's timers.
            ResetTransient();
            _enabled = false;
            return;
        }
        if (!_enabled)
            return;

        if (!InputContextReady)
        {
            if (_ownsSwing || _comboTicks > 0)
                Interrupt("context-interrupted");
            return;
        }
        if (_ownsSwing && !ReferenceEquals(Player.HeldItem, _ownedItem))
        {
            // Do not zero the newly selected weapon's animation or item time.
            _ownedItem = null;
            Interrupt("weapon-changed");
        }
        if (!_ownsSwing && Player.HeldItem.type != ItemID.WoodenSword && _comboTicks > 0)
            Interrupt("weapon-changed");

        if (_comboTicks > 0 && --_comboTicks == 0)
            Log("followup-expired");

        if (!_ownsSwing && Player.itemAnimation == 0 && _stamina < MaximumStamina)
        {
            _stamina++;
            if (_stamina == MaximumStamina)
                Log("stamina-full");
        }
    }

    public override void PostUpdate()
    {
        if (!IsActiveSession || !_ownsSwing || Player.itemAnimation > 0)
            return;

        bool opensFollowup = _stage == 1 && _hitConfirmed;
        _ownsSwing = false;
        _ownedItem = null;
        _hitConfirmed = false;
        _comboTicks = opensFollowup ? FollowupWindowTicks : 0;
        Log(opensFollowup ? "hit-confirm-window" : "swing-complete");
    }

    public override void UpdateAutopause()
    {
        if (IsActiveSession && (_ownsSwing || _comboTicks > 0))
            Interrupt("pause-interrupted");
    }

    public override void OnHurt(Player.HurtInfo info)
    {
        if (IsActiveSession)
            Interrupt("hurt-interrupted");
    }

    public override void UpdateDead()
    {
        if (IsActiveSession)
        {
            Interrupt("death-disabled");
            _enabled = false;
        }
    }

    internal bool CanStartSwing()
    {
        // CanUseItem may run without an actual attack. Keep this query pure.
        return !IsActiveSession || (InputContextReady && !_ownsSwing
            && _stamina >= (_comboTicks > 0 ? FollowupCost : FirstSwingCost));
    }

    internal void StartSwing(Item item)
    {
        if (!IsLocalSinglePlayer)
            return;

        // A new native use is the only place that releases previous cancellation.
        _suppressedItem = null;
        if (!IsActiveSession)
            return;

        int cost = _comboTicks > 0 ? FollowupCost : FirstSwingCost;
        if (!InputContextReady || _ownsSwing || _stamina < cost)
        {
            // Defensive guard for an eligibility/use race. Never charge twice.
            _suppressedItem = item;
            if (ReferenceEquals(Player.HeldItem, item))
            {
                Player.itemAnimation = 0;
                Player.itemTime = 0;
            }
            Log("start-rejected");
            return;
        }

        _stage = _comboTicks > 0 ? 2 : 1;
        _comboTicks = 0;
        _stamina -= cost;
        _ownsSwing = true;
        _ownedItem = item;
        _hitConfirmed = false;
        Log("native-swing-start");
    }

    internal bool IsSuppressedSwing(Item item) => IsLocalSinglePlayer
        && ReferenceEquals(item, _suppressedItem);

    internal void RecordHit(Item item, NPC target, int damageDone)
    {
        if (!IsActiveSession || !_ownsSwing || !ReferenceEquals(item, _ownedItem)
            || IsSuppressedSwing(item) || _hitConfirmed)
            return;

        // This is a real host callback, not a simulated or model-predicted hit.
        // Dead enemies may already be inactive here; do not test target.active.
        if (damageDone > 0 && !target.friendly)
        {
            _hitConfirmed = true;
            Log("npc-hit-confirmed", target.whoAmI, damageDone);
        }
    }

    private void TryCancelRecovery()
    {
        if (_ownsSwing)
        {
            int recoveryThreshold = Math.Max(1, Player.itemAnimationMax / 3);
            if (Player.itemAnimation > recoveryThreshold)
            {
                Log("cancel-too-early");
                return;
            }
            Interrupt("recovery-cancelled");
        }
        else if (_comboTicks > 0)
            Interrupt("followup-cancelled");
    }

    private void Interrupt(string eventCode)
    {
        if (_ownsSwing && _ownedItem is not null)
        {
            _suppressedItem = _ownedItem;
            if (ReferenceEquals(Player.HeldItem, _ownedItem))
            {
                Player.itemAnimation = 0;
                Player.itemTime = 0;
            }
        }
        _ownsSwing = false;
        _ownedItem = null;
        _comboTicks = 0;
        _hitConfirmed = false;
        Log(eventCode);
        _stage = 0;
    }

    internal void ResetForWorldExit()
    {
        if (IsLocalSinglePlayer && _enabled)
            Interrupt("world-exit-disabled");
        ResetTransient();
        _enabled = false;
    }

    private void ResetTransient()
    {
        _ownsSwing = false;
        _ownedItem = null;
        _suppressedItem = null;
        _comboTicks = 0;
        _hitConfirmed = false;
        _stage = 0;
    }

    private void Log(string eventCode, int npcId = -1, int damage = 0)
    {
        if (!IsLocalSinglePlayer || _logRecords >= MaximumLogRecords)
            return;

        _logRecords++;
        string message = $"[GameBridgeHostProbe] {eventCode} stage={_stage} stamina={_stamina} npc={npcId} damage={damage}";
        Mod.Logger.Info(message);
        if (!Main.gameMenu)
            Main.NewText(message);
    }
}
