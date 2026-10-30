# GameBridge：自动化 AI Mod 制作工具

实现版本：0.5.2 Alpha，更新于 2026-10-30（Asia/Shanghai）。后续目标用户、首版范围、架构与交付门槛以 [产品目标与开发规划](product-plan.md) 为准；本文记录现有工作台的实现与使用方法。[Mac 环境预检记录](macos-host-probe.md) · [审查修复与下一轮方向](review-fixes.md) · [动作规则与宿主门控](action-rules.md) · [历史 OS 沙盒记录](sandbox-verification.md)。

0.5.2 增加独立的 `npm run host:check`：只读检查用户指定 tModLoader 安装的托管元数据与固定 .NET 8 x64 SDK，不连接模型、编译、打包或启动游戏。本机自有 SDK 测试程序已编译和运行；用户尚未拥有 Terraria，实际宿主引用、探针编译和游戏仍未验证。`probes/tmodloader/` 是项目自有的未编译源码，不是模型生成的玩法移植成果，尚未接入工作台生成后端。

## 1. 产品目标与当前范围

用户提出“在 A 游戏框架里玩 B 游戏的动作交互”，工具调用模型、分析宿主接口与资源、生成 Mod、编译修复并最终验收。A 是宿主，B 是玩法来源，代码统一使用 `hostGame` / `sourceGame`。

“星露谷里玩泰拉瑞亚”“GTA 里玩 CS”是产品意图。当前仅有 SMAPI 宿主适配器，受支持的生成子集是短时速度 Buff 和近战倍率；完整角色、武器、动画、招式、冲刺控制器以及其他宿主继续列为缺口。模型不能宣布这些已实现，也不能把原始需求悄悄替换成两个 Buff。

此前被拒绝的建筑转换器与 Glitch/Repixture 原型不在当前源码和主线中。

后续主线是面向单机 Mod 玩家的自动化玩法制作：先证明一组真实动作在宿主中可玩，再证明不同自然语言需求能自动产生不同动作逻辑。采用来源玩法规格、宿主能力清单与受约束动作规则，交付宿主原生 Mod；不默认要求两款游戏同时运行。现有两种 Buff 只保留为管线验证。新动作宿主尚未确定，建议先对 Bannerlord 做有真实环境的能力探针，不能将候选写成已支持。

## 2. 动作规则工作流

首页现为动作制作入口：需求→一次模型规则设计→本地结构和引用校验→宿主能力门控→确定性规则回放→设计 JSON。三种项目自有示例可以在公开页免费回放。当前无动作宿主适配器；动作蓝图不生成 C#、不编译或执行 Mod，所有宿主仍被阻断。[规则语义和接口](action-rules.md) · [本轮验收](action-workbench-acceptance.md)

模型返回的规则只用于受限数据解释器，不包含表达式或可执行脚本。原始需求、无法表达的需求、资源缺口、来源版本和出处保留；来源特征和完整语义覆盖仍未验证。闪避状态尚无真实位移、无敌帧或碰撞。[真实宿主环境准备](host-environment.md)

## 3. 独立 SMAPI 管线

以下是 `/pipeline.html` 保留的两种 Buff 测试流程，不代表新动作规则已经接入游戏。

```text
宿主、玩法来源、完整需求
        ↓ DeepSeek JSON 请求（真实接口）
本地校验计划：方向、参数、原始请求与缺口
        ↓
        ├─ AI 生成源码：一次调用 → 受限 C# 检查 → 未编译 ZIP
        │
        └─ AI 生成并编译：先检查 SDK 和真实游戏引用
                       ↓ 环境就绪才收费生成
                  模型生成 ModEntry.cs
                       ↓ 固定工程隔离编译
                       ├─ 通过 → 工程 + 自有 DLL/PDB + 报告
                       ├─ C# 源码错误 → 模型修复 → 重编译（最多两次修复）
                       └─ 缺引用 / SDK / NuGet / 超时等 → 停止，报告环境问题

构建产物仍需另行在游戏中验收，当前不执行或自动安装 DLL。
```

分析、代码生成、有限源码检查、C# 编译和游戏验收分别记录。`staticValidation` 只代表有限的代码策略检查；不是沙箱、语义覆盖证明或可玩证明。构建通过也始终保持 `game=not_run`、`readyToInstall=false`。

## 4. 既有 SMAPI 验收

已用用户在本机配置的 DeepSeek Key 实际完成需求分析和 `ModEntry.cs` 生成。还使用真实 SDK 的 Roslyn 对生成源码进行语法解析，注入缺分号错误取得 `CS1002`，把诊断交给真实 DeepSeek 修复，重新解析后无语法错误。

这是受控语法故障验收；没有解析游戏类型或引用，**不是 Mod 编译成功**。编译调度、预算、失败、修复和取消分支使用明确标注的模拟编译器做契约测试；SDK 子进程另有真实普通 .NET 编译测试。用户已说明暂时没有游戏环境，真实 Mod 编译和游戏实测仍待验收。[验收记录](deepseek-pipeline-acceptance.md)

## 5. DeepSeek 接入与额度

默认 HTTPS 原点 `https://api.deepseek.com`，请求 `/chat/completions`，模型默认 `deepseek-flash`。模型名称可改；目前其他供应商也须使用同样的根路径和 JSON Chat Completions 形状，否则需增加适配器。[官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)

请求明确要求 JSON，并设置 `response_format: {"type":"json_object"}`。DeepSeek 请求关闭 thinking，减少结构化结果的额外推理预算。计划上限 4000 输出 tokens；代码生成/修复上限 8192；响应限 256 KiB。分析截止 45 秒，代码生成/修复截止 120 秒。空响应、截断、不合法结构、凭据回显或超限会失败，不静默接受。[JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/)

一次分析单独计费。源码模式最多一次代码模型调用；编译模式一次生成加 0–2 次修复，默认一次修复。界面显示次数上限与已尝试调用数；这不是供应商实际 token 账单。网络、认证或额度错误不自动重试。取消阻止后续工作并尝试中止当前请求，已经发出的请求仍可能计费。

完整构建模式在生成前检查环境，缺少 SDK 或游戏引用时为 `blocked`，代码模型调用数为 0。仅 C# 源码错误可以触发修复；缺程序集等 C# 环境错误同样不可修复。重复源码或重复编译错误会提前停止。

## 6. 源码、编译器与数据边界

模型仅能返回 `ModEntry.cs` 和简要说明。项目、NuGet 依赖、配置、清单、路径和其他文件由本地固定生成器控制。`ModConfig.cs`、`config.json` 的 `Enabled=false` 以及工程构建参数不可由模型修改。

0.5.1 将 SMAPI 壳限定为固定字段、数据类、Entry 接线和清理回调；两个动作处理器必须以固定有效条件和退出分支开头。合同之外的等价 C# 也可能被拒绝。该结构检查不证明任意控制流安全，不替代沙箱、行为测试或游戏验收。

本地先检查文件数量/大小、入口、配置门控和越界能力；编译器独立复验。文本策略拒绝常见进程、文件、网络、反射、动态加载、原生调用和 Harmony 等调用，但不等于执行隔离或行为证明。当前不运行生成 DLL。

上述限制指主工作台生产流程。独立验收脚本可在用户要求的 macOS OS 沙盒内运行带受限源码的自有契约模拟器；它不是生产游戏宿主，不会产出或替代真实游戏引用。其10项边界探针、行为断言、故意错误的对照组、模型分析失败和编译修复结果均在最新报告中分开记录。

编译器使用临时目录、固定项目和 nuget.org 源，关闭用户 Directory.Build 导入、自动部署、打包、调试、Harmony、共享编译服务和分析器。子进程不继承 API Key 或其他应用凭据。三分钟截止、64 KiB 日志、20 MiB 自有 DLL/PDB 上限；完成后清理临时目录。NuGet 缓存在被忽略的 `.tools/build-cache/`。编译只读取明确配置的游戏引用，不把游戏程序集或资源装入 ZIP。

云端接收需求、计划、两份自有 C# 源码上下文与去路径的 C# 诊断，不读取游戏资产、存档或任意目录。模型不能输出 shell 命令或新增依赖。游戏文件、Key 与验收生成物不进入公开仓库。

Key 可来自被忽略的 `.env` 或当前表单，不保存到浏览器存储、任务公开状态、日志或下载包；成功响应和错误都检查凭据回显。任务最多 8 项、计划/工程各 16 项，终态或产物一小时后不可访问；运行中凭据仅在内存闭包中使用。源码包最多 2 MiB，编译包最多 22 MiB，工程归档内存总计最多 64 MiB。

## 7. 本地准备与使用

```sh
npm test
npm run dev
```

打开 `http://127.0.0.1:4173`。将 `.env.example` 复制为本地 `.env`，配置后重启服务：

```dotenv
DEEPSEEK_API_KEY=在本地填写
GAMEBRIDGE_API_BASE=https://api.deepseek.com
GAMEBRIDGE_MODEL=deepseek-flash
GAMEBRIDGE_GAME_PATH=/your/local/Stardew Valley
# 可选绝对路径；也会探测 .tools/dotnet 与 PATH
GAMEBRIDGE_DOTNET_PATH=
```

下述游戏环境仅用于独立 SMAPI 管线。首页规则设计不需要游戏环境；Bannerlord 准入另按 [动作宿主准备指南](host-environment.md)。仅 AI 生成源码不需要游戏环境。SMAPI 完整编译需要可运行的 .NET SDK 8+（推荐 10 LTS），Stardew Valley 1.6.14+ / SMAPI 4.5.2+，工程以 `net6.0` 为目标，ModBuildConfig 固定 4.4.0。SDK 与目标框架是不同概念；本机 SDK 为 10.0.403。[Mod 开发环境](https://wiki.stardewvalley.net/Modding:Modder_Guide/Get_Started)

`GAMEBRIDGE_GAME_PATH` 指向程序集目录（macOS 的 Steam 安装通常在游戏目录的 `Contents/MacOS` 中），要求以下真实文件；清单核对了固定 [ModBuildConfig 4.4.0 包](https://www.nuget.org/packages/Pathoschild.Stardew.ModBuildConfig/4.4.0) 的构建目标：

- `Stardew Valley.dll`
- `StardewValley.GameData.dll`
- `MonoGame.Framework.dll`
- `xTile.dll`
- `StardewModdingAPI.dll`
- `smapi-internal/SMAPI.Toolkit.CoreInterfaces.dll`

检查存在和 PE 文件结构不证明版本或游戏兼容，`versionValidated=false`。未知/缺失引用明确阻断，不能用测试桩替代真实游戏程序集。

检查分析结果中的缺口后，选择 AI 源码或完整编译模式，并在需要时选择修复上限。任务界面显示阶段、诊断、尝试与模型调用数；可取消。失败仍保留此前通过本地筛查的源码和报告，非法初始响应不会被替换成一个冒称 AI 生成的固定模板。

## 8. SMAPI 产物与状态

源码 ZIP 包含固定工程、清单、`ModEntry.cs`、配置、完整 `plan.json`、本次 README、`validation-report.json` 和 `generation.json`。真实编译通过后，增加本次产生的自有 DLL/PDB；不包含游戏 DLL。

报告分别记录 `planProvenance` / `codeProvenance`、模型调用次数、构建尝试、缺口、`build` 和 `game`。示例计划可以用于测试模型代码生成，但会同时标明“计划来自示例、代码来自模型”。编译成功不改写需求覆盖结果。

API：

| 接口 | 作用 |
| --- | --- |
| `GET /api/config` | 本地状态和默认供应商，不返回 Key |
| `GET /api/environment` | SDK、游戏引用、缺失项和版本未验收提示 |
| `POST /api/plan` | 真实模型需求分析并本地校验 |
| `POST /api/example` | 固定非 AI 示例计划 |
| `POST /api/projects` | 固定模板源码生成 |
| `POST /api/jobs` | 以 planId 启动 `source` 或 `build` 任务、指定 0–2 次修复 |
| `GET /api/jobs/:id` | 状态、事件、诊断、调用数与最终工程 |
| `POST /api/jobs/:id/cancel` | 取消任务和后续模型调用 |
| `GET /api/projects/:id/download` | 下载实际源码或编译 ZIP |

本地服务仅监听 127.0.0.1，检查 Host/Origin、JSON 类型与 96 KiB 请求上限；完整制作任务一次运行一个，避免并发超出预算。公开 GitHub Pages 禁用制作与 Key 设置，不连接用户本机。main 推送经过测试和构建后更新网页；网页部署不等于 Mod 已更新或游戏已接入。

## 9. 下一步验收与扩展

1. 修复并评估新的需求分析结构可靠性，保留每次失败；不能只回放旧有效计划。
2. 按产品规划准备合适动作宿主的真实环境，通过输入、动作、命中与恢复探针，冻结精确版本和来源动作规格。
3. 开发受约束的动作规则与宿主适配器，先完成真实动作片段，再验证三种不同需求及一次修改的自动制作；源码和构建通过不足以替代实机验收。
4. 星露谷/SMAPI 如具备环境，可独立补齐现有管线的真实编译与游戏测试，但不以此锁定动作首版或宣称完成来源玩法迁移。
5. 达到内测门槛后再扩展来源玩法包和宿主；每种组合分别验证，记录资产来源、动作时序、碰撞与特征损失。

使用官方或获允许的 Mod/编辑接口；不实现进程注入、内存修改或反作弊规避，不承诺零封禁。第一条完整真实可玩的串联链路仍未完成。
