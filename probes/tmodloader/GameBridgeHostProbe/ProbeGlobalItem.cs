using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace GameBridgeHostProbe;

// Stateless global hook. All transient per-player state lives in ProbePlayer.
public sealed class ProbeGlobalItem : GlobalItem
{
    private static bool IsProbeWeapon(Item item) => item.type == ItemID.WoodenSword;

    public override bool CanUseItem(Item item, Player player)
    {
        // This eligibility hook must never consume stamina or change action state.
        return !IsProbeWeapon(item) || player.GetModPlayer<ProbePlayer>().CanStartSwing();
    }

    public override bool? CanAutoReuseItem(Item item, Player player)
    {
        // Separate manual uses make the hit-confirm follow-up observable.
        return IsProbeWeapon(item) && player.GetModPlayer<ProbePlayer>().IsActiveSession ? false : null;
    }

    public override void UseAnimation(Item item, Player player)
    {
        if (IsProbeWeapon(item))
            player.GetModPlayer<ProbePlayer>().StartSwing(item);
    }

    public override bool? CanHitNPC(Item item, Player player, NPC target)
    {
        if (IsProbeWeapon(item) && player.GetModPlayer<ProbePlayer>().IsSuppressedSwing(item))
            return false;

        return null;
    }

    public override void OnHitNPC(Item item, Player player, NPC target, NPC.HitInfo hit, int damageDone)
    {
        if (IsProbeWeapon(item))
            player.GetModPlayer<ProbePlayer>().RecordHit(item, target, damageDone);
    }
}
