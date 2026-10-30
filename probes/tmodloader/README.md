# tModLoader 宿主动作用探针源码

这是一份项目自有、非模型生成的**未编译源码**，用于下一步判断 macOS 上的 Terraria/tModLoader 是否适合作为动作宿主。当前用户没有 Terraria 环境，因此没有真实 Mod 编译、`.tmod` 打包、加载或游戏实测；所有能力仍未验证，`readyToInstall=false`。它不表示 GameBridge 已支持 Terraria，也不是把另一款游戏移植进来的成果。

版本锁为官方 `tModLoader v2026.08.3.0`、`.NET SDK 8.0.427 x64`、`net8.0/C# 12`。该固定 tag 的 [Terraria 工程补丁](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/Terraria/Terraria/Terraria.csproj.patch) 保留 `Version=1.4.4.9`，这是源码中的宿主内容基线；本地程序集身份仍必须由真实安装预检确认，不能从目录名推断。现有其他 SDK、假引用程序集、语法检查、项目契约测试都不能替代该检查。完整范围与状态在 [probe-contract.json](probe-contract.json)。

## 探针准备验证什么

探针只对宿主已有的 `ItemID.WoodenSword` 添加瞬时规则，不创建物品或配方，不复制纹理、动画、音频或游戏 DLL。素材策略是 `resource-owning-host-only`：显示与近战碰撞均由用户本地宿主提供。

| 操作或事件 | 源码中的预期行为 | 待真实游戏核验 |
| --- | --- | --- |
| 进入单人世界 | 会话默认关闭；P 手动开启，攻击中不能开启 | 键位、启停与普通攻击共存 |
| 持原生木剑，使用原生攻击键 | 开始原生挥击，第一段扣 30 点独立体力 | 可见挥击、次数与资源扣除时机 |
| 第一段对敌对 NPC 造成真实正伤害 | 记录 `npc-hit-confirmed`；挥击完成后开启 30 tick 窗口 | 回调顺序、命中与结束时机 |
| 窗口内松开再按攻击键 | 第二段扣 20 点体力，复用原生挥击；不能接第三段 | 手动输入与连段边界 |
| 未命中、窗口超时或第二段完成 | 下一次攻击回到第一段；空闲每 tick 回复 1 体力，上限 100 | 超时、资源不足与恢复 |
| 挥击最后三分之一时按 V | 清除当前拥有的原生动画/使用计时，并以 `CanHitNPC=false` 抑制被取消挥击 | 同一帧钩子顺序、取消后是否仍有伤害 |
| 早期按 V | 拒绝取消，记录 `cancel-too-early` | 取消条件 |
| 连段等待中按 V | 清除后续窗口 | 不误启动攻击 |
| 受击、暂停、打开物品栏或换武器 | 清理动作和连段；不改新武器计时 | 受击与界面清理 |
| 死亡、退出世界或 P 关闭 | 清理并关闭会话 | 重进世界仍默认关闭 |
| 联机或专用服务器 | 不启用探针，保持原生钩子返回值 | 尚不支持联机 |

两段使用相同的宿主原生挥击，只证明“实际动作开始 → 真实命中 → 有条件后续动作”的接口是否可用；没有自定义动作资源、位移、无敌帧、碰撞体或来源游戏保真。取消操作的运行顺序尚未实测，不能保证仅凭计时归零已停止本帧命中，因此另加命中门控；它仍需通过游戏中的正反例验证。

日志只含固定事件名与数值，最多每个世界 64 条，同时进入 tModLoader 日志与游戏文字；达到限额后探针仍运行但不再记录。体力、连段与启用状态不实现 `SaveData/LoadData`。真实原生攻击仍会造成正常游戏变化；以后验收应使用独立测试角色/世界，不能把“不写 Mod 存档”理解成“游戏存档完全不会变化”。

## 编译与执行边界

`GameBridgeHostProbe/GameBridgeHostProbe.csproj` 仅允许编译这四份可信源码。它不导入 `tMLMod.targets`，不调用打包工具，不使用第三方分析器、NuGet 包、`Exec`、外部工程引用或源码生成器，也不启动或安装 DLL。官方 tML targets 的 BuildMod 后置步骤会启动宿主打包工具，且关闭 BuildMod 后仍可能引入分析器，因此不能直接导入。

工程要求显式提供 `GameBridgeTmlPath`、`GameBridgeReferencePaths` 和 `GameBridgePreflightApproved=true`。引用路径应逐项来自真实预检报告的托管 DLL 文件列表；不得通配整个安装目录，不得导入游戏目录提供的 props/targets，不得传入替身引用。引用 `Private=false`，不会把游戏 DLL 复制到产物。该布尔属性只是防误用门槛，**不是对文件版本/身份的验证或安全沙箱**；普通 MSBuild 也不是隔离器。

当前没有可用的真实引用列表，所以不要运行该工程。后续必须先核验实际 SDK x64、官方固定版本安装与所有引用，再另行确定清洁环境、受控编译、产物检查及 `.tmod` 打包/加载边界。不得把直接 `dotnet build` 的可信源码工程等同于可执行任意模型工程的构建器。

当前已执行 7 项 Node 源码契约检查，均通过；另用现有 `.NET 10.0.403` 的 Roslyn 将四份 C# 作为文本逐份解析，均无语法诊断。具体源码摘要见 [syntax-verification.json](syntax-verification.json)。该 SDK 仅运行可信文本解析器，不是目标宿主构建环境；报告为 `syntax-only`、`realModBuild=not_run`、`game=not_run`。解析不绑定类型，不能证明这些钩子或引用真实编译通过。

## 后续人工游戏验收

获得合法游戏和精确 tModLoader 环境后，先复核并编译项目，再单独确定并验证受控打包/加载流程。验收需记录版本、SDK/架构、编译诊断、原生动作画面及有限事件日志，至少覆盖：默认关闭、启停、第一段命中与未命中、窗口内/外第二段、第二段结束、取消允许/拒绝、取消后无额外命中、体力不足、受击、切武器、死亡、暂停、退出重进。运行顺序或签名不匹配时停止，不用 Buff 或模拟器替代。

这一步成功后才讨论声明式规则到宿主后端及三种不同动作需求；仍需分别验证来源语义、资源许可与完整需求覆盖。没有绕过反作弊、注入、内存修改、Harmony 或联机支持。

## 官方固定版本接口

- [GlobalItem](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/GlobalItem.cs)：`CanUseItem`、`UseAnimation`、`CanAutoReuseItem`、`CanHitNPC` 与 `OnHitNPC`。资格查询不得扣资源，真正使用开始时才扣除。
- [ModPlayer](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/ModPlayer.cs)：按键、更新、受击、死亡、暂停与进世界钩子。
- [ModSystem](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/ModSystem.cs)：`OnWorldUnload` 清理。
- [KeybindLoader](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/KeybindLoader.cs) 与 [ModKeybind](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/ModKeybind.cs)：注册与 `JustPressed`。
- [Player 补丁](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/Player.cs.patch)：原生动画/使用计时字段；引用字段不等于证明取消运行语义。
- [官方构建 targets](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/release_extras/tMLMod.targets)：只用于研究框架与引用边界，本工程不导入。
