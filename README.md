# GameBridge — AI 玩法制作工作台

用户描述“在宿主游戏里体验另一款游戏的角色、武器、招式和动作交互”，GameBridge 将需求转为动作规则，检查素材和宿主接口缺口，逐步完成原生 Mod 制作与真实游戏验收。

**当前版本 0.5.2 Alpha：增加 Mac tModLoader 环境预检与未编译的可信宿主探针。** 本机 .NET 8 x64 已运行自有测试程序，但用户尚未拥有 Terraria，真实 Mod 编译和游戏测试均未运行。尚无已验证动作宿主，不能生成可安装的动作 Mod。[Mac 测试记录与缺口](docs/macos-host-probe.md)

工作台支持动作规则设计与有限回放；闪避目前只是规则状态，没有实际位移、动画或碰撞。现有 SMAPI 源码、编译与修复保留为单独管线测试；0.5.1 的密钥、取消、预算与源码检查修复继续保留。[审查修复与下一轮方向](docs/review-fixes.md) · [动作规则说明](docs/action-rules.md) · [此前动作验收](docs/action-workbench-acceptance.md)

此前 SMAPI 自有模拟器在 OS 沙盒通过 21 场景、75 断言，但该轮新分析曾出现格式失败；失败记录继续保留。真实 Mod 编译及游戏实测仍未验收。[历史沙盒报告](docs/sandbox-verification.md)

[公开预览](https://loganwon.github.io/gamebridge/) · [产品目标与开发规划](docs/product-plan.md) · [工具使用与实现状态](docs/ai-mod-workbench.md) · [GitHub](https://github.com/Loganwon/gamebridge)

## 产品目标与首版门槛

面向会安装 Mod、希望用自然语言改造单机动作体验的玩家，交付能影响宿主真实敌人与世界的玩法。首版目标是一个宿主、一个来源武器动作片段，覆盖攻击时序、连击或蓄力、闪避或取消、资源和中断；再证明至少三种不同需求及一次修改能自动制作并通过真实游戏验收。现有两种 Buff 继续作为管线测试能力。

后续采用来源玩法规格、宿主能力与受约束动作规则，再生成宿主原生 Mod。新宿主需先通过真实能力探针；Bannerlord 是优先研究候选，尚未接入，精确游戏组合尚未冻结。[完整规划及开发阶段](docs/product-plan.md)

## 本地启动与 DeepSeek

需要 Node.js 24+，无第三方 npm 运行依赖。

```sh
npm test
npm run dev
```

打开 `http://127.0.0.1:4173`。将 `.env.example` 复制为本地 `.env`，填写 `DEEPSEEK_API_KEY`，或在工作台模型设置中临时输入。配置后重启本地服务。默认端点 `https://api.deepseek.com`，模型 `deepseek-flash`；可改为账号支持的型号。密钥不进入 Git、下载包、浏览器存储或编译子进程。

默认 Key 仅用于配置的 API origin。切换域名或端口后需要填写对应 Key；界面会清除手动旧 Key，后端也会阻断默认密钥跨 origin 复用。

首页输入宿主、玩法来源和完整需求，点击“AI 分析并设计动作规则”；也可不调用 AI，回放三种自有规则示例。导出的是设计 JSON。[动作规则与宿主门控](docs/action-rules.md) · [何时准备游戏环境](docs/host-environment.md)

独立 SMAPI 管线入口为 `http://127.0.0.1:4173/pipeline.html`。核对旧版计划后可选择：

- **AI 生成源码**：最多一次代码模型调用，无需游戏环境，下载未编译的源工程。
- **AI 生成并编译**：先检查环境，再生成源码、编译；仅 C# 源码错误触发模型修复，默认一次、最多两次。
- **固定模板示例**：不调用模型，用于检查界面与下载流程，始终标明示例来源。

分析调用另计；模型请求不会自动进行网络重试。界面显示调用上限、执行阶段、每次诊断并支持取消。缺 SDK/游戏引用、NuGet 问题、重复源码或重复错误会停止，不冒充修复成功。

## 准备完整编译环境

以下为旧 SMAPI 管线的编译环境。Mac tModLoader 候选使用独立的精确 SDK 与只读预检：`npm run host:check`。缺真实安装会返回 `blocked`、退出码 2；预检不会生成或构建 Mod，也不会安装游戏。[Mac 路线记录](docs/macos-host-probe.md)

安装 .NET SDK 8+（推荐 10 LTS）；生成工程目标仍为游戏使用的 `net6.0`。工作台会探测项目 `.tools/dotnet` 和 PATH，也可通过 `GAMEBRIDGE_DOTNET_PATH` 指定绝对路径。

准备 Stardew Valley 1.6.14+ 与 SMAPI 4.5.2+，在本地 `.env` 中设置 `GAMEBRIDGE_GAME_PATH`。该目录应包含 `Stardew Valley.dll`、`StardewValley.GameData.dll`、`MonoGame.Framework.dll`、`xTile.dll`、`StardewModdingAPI.dll` 和 `smapi-internal/SMAPI.Toolkit.CoreInterfaces.dll`。本地检查文件存在与 PE 格式，不自动证明游戏版本或行为兼容。

编译在临时目录运行，固定项目与依赖，不执行模型提供的命令、不执行或自动安装生成 DLL。通过后 ZIP 可包含自有 DLL/PDB；失败时保留已接受的源码和诊断。构建通过仍标记 `game=not_run`、`readyToInstall=false`，需要另行游戏验收。

## 独立 SMAPI 管线生成边界

当前宿主只有 Stardew Valley / SMAPI，模型只修改受限工程里的 `ModEntry.cs`，项目、依赖、配置与其他文件保持固定。范围仍是明确声明的短时速度 Buff 与近战倍率机制；不是来源游戏的完整冲刺、武器模型、招式或角色系统。GTA/CS、角色与动画资源等继续列为待适配或需素材，不能由模型自行宣布完成。

源码文本检查不是沙箱，也不证明动作等价或安全；当前不执行产物。原始请求、未实现项、模型/示例来源、构建尝试和游戏状态分别保存在工程报告里。用户游戏文件、资产、存档与凭据不上传模型或公开仓库；云端接收需求、允许修改的源码与脱敏后的编译诊断。

## 持续更新

每次修改测试、构建后普通推送到已验证的 GitHub 仓库，GitHub Actions 随 main 更新公开页面。CI 配置真实 .NET SDK 验证编译工具与语法解析器，不保存 Key、不调用收费模型，也不持有商业游戏引用。公开 Pages 仅展示界面与说明，制作和模型设置在本地服务中进行。

## 独立沙盒验收

macOS + .NET SDK 10 可运行 `npm run test:sandbox`，无模型调用。它先验证文件/网络/执行边界，再在 OS 沙盒中编译并运行项目自有的接口模拟器，检查当前固定机制，报告始终保持 `realModBuild=not_run`、`game=not_run`。它不是生产游戏编译器，也不是虚拟机；主工作台不会自动执行 Mod DLL。

`npm run test:sandbox -- --live` 另行调用本地配置的 DeepSeek，最多一次分析、一次生成和一次受控编译错误修复；任一步失败即停止，不自动重试。可以用 `--source file.cs --plan plan.json` 无费用回放已有源码，或再加 `--repair-live` 只验收一次收费修复。原始产物默认保存在被忽略的 `artifacts/sandbox-verification/`。
