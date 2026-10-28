# GameBridge — AI Mod 制作工作台

用户描述“在宿主游戏里体验另一款游戏的角色、武器、招式和动作交互”，GameBridge 调用 DeepSeek 分析需求，检查能力与素材缺口，生成 Mod 源码，并在本地编译、根据编译错误进行有限次数的修复。

**当前版本 0.4 Alpha：已完成真实 DeepSeek 需求分析、代码生成，以及真实 Roslyn 语法诊断到模型修复的受控验收。完整 Mod 编译器与自动修复调度已实现，但用户尚无星露谷/SMAPI 环境，真实 Mod 编译及游戏实测仍未验收。** 语法通过不等于游戏 API 正确或 Mod 可玩。[验收范围与证据](docs/deepseek-pipeline-acceptance.md)

[公开预览](https://loganwon.github.io/gamebridge/) · [工具设计与使用说明](docs/ai-mod-workbench.md) · [GitHub](https://github.com/Loganwon/gamebridge)

## 本地启动与 DeepSeek

需要 Node.js 24+，无第三方 npm 运行依赖。

```sh
npm test
npm run dev
```

打开 `http://127.0.0.1:4173`。将 `.env.example` 复制为本地 `.env`，填写 `DEEPSEEK_API_KEY`，或在工作台模型设置中临时输入。配置后重启本地服务。默认端点 `https://api.deepseek.com`，模型 `deepseek-flash`；可改为账号支持的型号。密钥不进入 Git、下载包、浏览器存储或编译子进程。

输入宿主、玩法来源和完整需求，点击“分析需求”。核对计划后可选择：

- **AI 生成源码**：最多一次代码模型调用，无需游戏环境，下载未编译的源工程。
- **AI 生成并编译**：先检查环境，再生成源码、编译；仅 C# 源码错误触发模型修复，默认一次、最多两次。
- **固定模板示例**：不调用模型，用于检查界面与下载流程，始终标明示例来源。

分析调用另计；模型请求不会自动进行网络重试。界面显示调用上限、执行阶段、每次诊断并支持取消。缺 SDK/游戏引用、NuGet 问题、重复源码或重复错误会停止，不冒充修复成功。

## 准备完整编译环境

安装 .NET SDK 8+（推荐 10 LTS）；生成工程目标仍为游戏使用的 `net6.0`。工作台会探测项目 `.tools/dotnet` 和 PATH，也可通过 `GAMEBRIDGE_DOTNET_PATH` 指定绝对路径。

准备 Stardew Valley 1.6.14+ 与 SMAPI 4.5.2+，在本地 `.env` 中设置 `GAMEBRIDGE_GAME_PATH`。该目录应包含 `Stardew Valley.dll`、`StardewValley.GameData.dll`、`MonoGame.Framework.dll`、`xTile.dll`、`StardewModdingAPI.dll` 和 `smapi-internal/SMAPI.Toolkit.CoreInterfaces.dll`。本地检查文件存在与 PE 格式，不自动证明游戏版本或行为兼容。

编译在临时目录运行，固定项目与依赖，不执行模型提供的命令、不执行或自动安装生成 DLL。通过后 ZIP 可包含自有 DLL/PDB；失败时保留已接受的源码和诊断。构建通过仍标记 `game=not_run`、`readyToInstall=false`，需要另行游戏验收。

## 当前生成能力与边界

当前宿主只有 Stardew Valley / SMAPI，模型只修改受限工程里的 `ModEntry.cs`，项目、依赖、配置与其他文件保持固定。范围仍是明确声明的短时速度 Buff 与近战倍率机制；不是来源游戏的完整冲刺、武器模型、招式或角色系统。GTA/CS、角色与动画资源等继续列为待适配或需素材，不能由模型自行宣布完成。

源码文本检查不是沙箱，也不证明动作等价或安全；当前不执行产物。原始请求、未实现项、模型/示例来源、构建尝试和游戏状态分别保存在工程报告里。用户游戏文件、资产、存档与凭据不上传模型或公开仓库；云端接收需求、允许修改的源码与脱敏后的编译诊断。

## 持续更新

每次修改测试、构建后普通推送到已验证的 GitHub 仓库，GitHub Actions 随 main 更新公开页面。CI 配置真实 .NET SDK 验证编译工具与语法解析器，不保存 Key、不调用收费模型，也不持有商业游戏引用。公开 Pages 仅展示界面与说明，制作和模型设置在本地服务中进行。
