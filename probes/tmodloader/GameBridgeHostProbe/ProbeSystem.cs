using Terraria;
using Terraria.ModLoader;

namespace GameBridgeHostProbe;

public sealed class ProbeSystem : ModSystem
{
    public override void OnWorldUnload()
    {
        if (!Main.dedServ && Main.myPlayer >= 0 && Main.myPlayer < Main.player.Length)
            Main.player[Main.myPlayer]?.GetModPlayer<ProbePlayer>().ResetForWorldExit();
    }
}
