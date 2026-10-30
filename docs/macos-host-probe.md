# macOS 宿主路线试验记录

记录日期：2026-10-30（Asia/Shanghai），版本 0.5.2 Alpha。用户希望先尝试 Mac，再判断是否需要 Windows；现已确认尚未拥有 Terraria。

**Mac 的 x64 .NET 8 工具链可用；真实游戏链路尚未开始。** 本轮阻断是缺少所选游戏环境，不能由此判断 Mac 路线失败，也不能认为换 Windows 就已解决。当前无需购买游戏或上传文件；tModLoader 仍只是候选，没有冻结首发宿主/来源组合，也没有进入支持目录。

## 实际做过什么

| 检查 | 实际结果 | 能证明的范围 |
| --- | --- | --- |
| 本机平台 | macOS 26.1 / 25B78，arm64 | 当前测试设备 |
| x64 系统程序 | `arch -x86_64 uname -m` 输出 `x86_64` | x64 命令能够启动 |
| 官方 SDK 安装 | .NET SDK 8.0.427 osx-x64，SHA-512 匹配官方清单 | 本轮下载包校验通过 |
| SDK 自报 | 8.0.427 / x64 / osx-x64 | 专用工具可启动 |
| 自有 net8.0 小程序 | 编译成功，运行输出 `sdk-probe-only:X64:8.0.33` | 自有代码的 x64 编译与运行；不是 Mod |
| Steam 已知库元数据 | 标准库中没有 Terraria / tModLoader 的安装清单 | 只检查已知清单；没有扫描整台机器 |
| 实际环境预检 | SDK 条件通过，`TML_INSTALL_PATH_REQUIRED` | 缺真实安装目录，`blocked` |
| 探针 C# 文本 | 4 份 Roslyn 语法解析通过 | 无类型绑定，不是游戏 API 编译 |
| 项目回归 | 186/186 本机测试通过，无跳过；静态站点构建通过 | 工具逻辑与现有回归，不是游戏运行 |

完整状态见 [机器可读结果](macos-host-probe-results.json)。本轮没有调用模型，没有下载商业游戏或真实游戏引用，没有安装或执行任何生成 Mod。

SDK 位于本项目被忽略的 `.tools/dotnet8-x64/`，不更改系统 PATH，也不替换原有 SDK 10。下载地址来自 [Microsoft .NET 8 发布元数据](https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json)，包大小 215155458 字节，SHA-512 为：

```text
a6c6d0a3708b15e20285f4f662195b6fd276e3df2fc91c0a38f30681ff8a23d5e322ada8a92e9b410343449eab635d01b30a4f55aeef6f884651a559cce07707
```

SDK 小程序是项目自有控制台代码，仅输出进程架构和运行时版本。工程固定 net8.0、SDK 8.0.427、禁用共享编译与分析器、清空包来源；编译与运行进程使用最小环境，不继承供应商密钥。它没有游戏引用，也没有模拟游戏 API；这次不是 OS 沙盒测试，不能与此前的契约模拟器验收混用。

## 新增工具怎么使用

```sh
npm run host:check
npm run host:check -- --help
```

缺环境返回 JSON `status=blocked` 和退出码 2，这是预期阻断。仅当固定 SDK 与安装元数据条件满足时，返回 `environment_ready`、退出码 0；此时也只是允许继续准备可信探针编译，`adapterImplemented=false`、`realModBuild=not_run`、`game=not_run`、`readyToInstall=false`。

以后已有合法安装时，可指定目录，不需要上传文件：

```sh
npm run host:check -- --install-path /absolute/tModLoader --dotnet-path /absolute/dotnet --output artifacts/new-preflight.json
```

也可在本地 `.env` 配置 `GAMEBRIDGE_TML_PATH` 与 `GAMEBRIDGE_TML_DOTNET_PATH`。后者默认探测项目专用 `.tools/dotnet8-x64/dotnet`；不会把 SDK 10 自动当成替代品。输出默认只到终端，可选 `.json` 文件以权限 0600 新建，已有文件拒绝覆盖；报告可能含本地路径，应留在被忽略的 `artifacts/` 中。

工具只读取显式安装目录中的受限文件：托管程序集元数据、运行时配置、依赖清单、官方固定 targets 配置以及配套托管引用。它不导入或执行 targets，不加载游戏程序集，不构建、打包、安装或运行游戏。SDK 只执行 `--list-sdks` / `--info`，信息来自调用者选择的可信工具自报，不是发布者签名认证。元数据版本检查也不证明文件授权或行为安全。

检查拒绝畸形 PE、越界/超限配置、被检查路径中的符号链接、MSBuild 表达式路径、错误版本、取消和超时。上限包括单程序集 128 MiB、元数据 64 MiB、单表 250000 行、配置 256 KiB、targets 16 KiB、配套引用 512 个/384 MiB、目录项 4096/深度 8、SDK 单次 10 秒/32 KiB、异步观察截止 30 秒。元数据同步解析不可抢占，受文件与行数上限约束，时间截止不是 OS 级 CPU 隔离。它是有界预检，不是任意文件解析器或执行沙箱；真实安装的正向准入尚未测试，仍可能需要修正版本配置或引用清单。

## 未编译宿主探针

源码和完整合同位于仓库的 `probes/tmodloader/`。它是项目自有接口试验，不调用模型，也不是另一款游戏的移植成果。拟验证原生木剑挥击、真实 NPC 命中回调、独立体力、命中后第二次手动挥击、后摇取消和中断清理；默认关闭、仅本地单人、不新增物品或配方。

两段动作复用宿主原生动画，没有来源游戏角色、武器或招式资源。取消只尝试结束拥有的原生计时并拦截后续命中，没有闪避位移、无敌帧或新碰撞体。钩子顺序、同帧取消和动作手感都需要实测。源码契约测试与语法解析无法证明这些行为成立。

版本画像锁为 [tModLoader v2026.08.3.0](https://github.com/tModLoader/tModLoader/releases/tag/v2026.08.3.0)、提交 `c9545cf27d56c456321e1896274c02adf67d0140`、net8.0、SDK 8.0.427 x64。官方固定源码的 Terraria 内容基线为 1.4.4.9，不等于本机已验证真实 DLL。[固定内容工程补丁](https://github.com/tModLoader/tModLoader/blob/v2026.08.3.0/patches/Terraria/Terraria/Terraria.csproj.patch)

官方开发指南要求 .NET 8 x64；其标准 targets 会引入分析器并调用打包工具，因此本探针的 compile-only 工程不导入该文件。关闭官方 `BuildMod` 不足以移除所有分析器。后续引用必须来自真实安装并逐项给出，不能用模拟程序集代替。[开发指南](https://github.com/tModLoader/tModLoader/wiki/Developing-with-Visual-Studio-Code) · [固定 targets](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/release_extras/tMLMod.targets)

## 尚缺的实际证据与下一步

1. 合法可用的 Terraria / 固定版本 tModLoader 安装；Steam 页面注明需要拥有 Terraria。当前缺失。[官方商店说明](https://store.steampowered.com/app/1281930/tModLoader/)
2. 真实安装的正向身份与完整引用预检，以及可信探针对真实 API 的编译；当前均未运行。
3. 独立确定并验证受控 `.tmod` 打包与加载流程；不能把 compile-only DLL 当作可安装包。
4. 游戏加载、画面、输入、NPC 伤害/命中、命中/落空连段、资源不足、取消后无额外伤害、受击/死亡/菜单/重进清理。
5. 宿主能力通过后，再实现动作规则到宿主后端，选择明确来源片段，验证三种不同需求及一次修改的 AI 自动制作。当前没有这条完整链路。

只有真实游戏测试暴露 Mac 的平台障碍，才有依据比较 Windows 路线。即使这份原生接口探针通过，也不能单独算作“把 B 的玩法放进 A”完成：来源语义、动作资源、规则生成、编译修复与完整需求仍需逐项验收。
