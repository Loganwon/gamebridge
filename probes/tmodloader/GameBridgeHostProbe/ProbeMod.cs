using Terraria;
using Terraria.ModLoader;

namespace GameBridgeHostProbe;

// Trusted host API probe, not model-generated Mod output.
public sealed class ProbeMod : Mod
{
    internal static ModKeybind? ToggleProbe { get; private set; }
    internal static ModKeybind? CancelRecovery { get; private set; }

    public override void Load()
    {
        if (Main.dedServ)
            return;

        ToggleProbe = KeybindLoader.RegisterKeybind(this, "ToggleProbe", "P");
        CancelRecovery = KeybindLoader.RegisterKeybind(this, "CancelRecovery", "V");
    }

    public override void Unload()
    {
        ToggleProbe = null;
        CancelRecovery = null;
    }
}
