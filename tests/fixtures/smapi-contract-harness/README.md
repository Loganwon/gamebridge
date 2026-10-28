# CONTRACT SIMULATION ONLY

This project-owned test fixture compiles a supplied `ModEntry.cs` into an ordinary
`GameBridge.ContractSimulation` .NET 10 executable with deliberately simplified
event, input, tool and Buff test doubles. It contains no commercial game code or
assets, no SMAPI package, and no production game reference files. It must never
be placed in `GAMEBRIDGE_GAME_PATH` or counted as a real Mod/game build.

The main process must apply its OS sandbox before **running** this executable.
The fixture itself is not a sandbox. Compile/run paths must not contain API keys.
No model credentials are needed for the fixture.

## Build in an isolated scratch directory

Copy the fixture source, project and config files into a caller-owned scratch directory,
then build with a real SDK 10 and an explicit generated source path:

```sh
dotnet build ContractHarness.csproj --configuration Release --disable-build-servers \
  --configfile NuGet.Config -p:ModSource=/absolute/path/ModEntry.cs \
  -p:NuGetAudit=false -p:ImportDirectoryBuildProps=false \
  -p:ImportDirectoryBuildTargets=false -p:UseSharedCompilation=false
```

Do not execute the generated harness outside the caller's OS sandbox. Inside an
already restricted sandbox, its entry point is:

```sh
dotnet bin/Release/net10.0/GameBridge.ContractSimulation.dll [contract.json]
```

The optional JSON contract has these defaults, matching the existing recorded
5009-byte model source and its plan:

```json
{"SpeedKey":"V","MeleeKey":"B","SpeedAmount":2,"MeleeMultiplier":1.5,"DurationTicks":120,"CooldownTicks":300}
```

The expected namespace IDs are `GameBridge.Generated.Mod.0` (speed) and `.1`
(melee). This is an explicit fixture contract, not a discovery or compatibility
test. Arbitrary model IDs or changed mechanics must cause fixture failures rather
than silently change expected results.

## Behavior assertions

The JSON result records 21 independent scenarios and an assertion count:

- Disabled config and world/player/multiplayer input gates.
- Speed value, duration and suppression of the accepted key.
- Melee-only gate and additive attack bonus (`multiplier - 1`).
- Duration expiry and exact cooldown boundaries for both mechanics, including
  repeated key presses and independently staggered effect timers.
- A normal swing's non-free state preserves the melee bonus.
- Switching melee/non-melee tools removes the melee bonus without removing speed.
- Menu, saving, local warp, death, event, multiplayer transition and disabled
  config clear the fixture's own buffs while preserving another mod's sentinel.
- Nonlocal warp does not remove local bonuses.
- Save cleanup does not reset cooldown; simulated title reset does reset it.
- Unrelated input remains untouched.

Output is always `scope=contract-simulation-only`, `realModBuild=not_run`,
`game=not_run`, `readyToInstall=false`. Exit 0 means all fixture assertions passed;
exit 1 means one or more failed. A title event here occurs while the mock player
is still accessible; real engine lifetime and `IsWorldReady` ordering are **not**
emulated. Nor are game rendering, collisions, actual damage, physics, save data,
animation, API signatures, assets, timing or source-game fidelity. These require
real game references and in-game validation.
