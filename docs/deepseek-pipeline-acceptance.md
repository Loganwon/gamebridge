# DeepSeek 与编译修复流程验收记录

日期：2026-10-28（Asia/Shanghai）· GameBridge 0.4 Alpha。

## 已实际执行

1. 用户在本机提供 DeepSeek 凭据后，向官方 `/chat/completions` 发起真实请求，模型为 `deepseek-flash`。首次计划因本地结构校验失败被拒绝，后续有效计划通过；没有把错误结果视为成功，也没有自动重试收费请求。
2. 分析请求明确把完整角色、武器、动画和冲刺控制器保留为缺口；仅用 V 键短时速度和 B 键近战强化作为当前代码生成接口的验收子集。宿主为 Stardew Valley，玩法来源意图为 Terraria，未宣称移植完整玩法。
3. 使用真实 DeepSeek 返回一个 `ModEntry.cs`，经本地策略检查通过。一次 CLI 生成结果为 5009 bytes，SHA-256：`9be1f73a5720fd82f42337deea39217d23e327433dfc898014fd7905c3258800`。
4. 使用官方 .NET SDK 10.0.403 的 Roslyn 解析该源码，原始语法通过；在测试副本中有意删除一处分号，取得真实 `CS1002`。将源码和结构化诊断发送给 DeepSeek 修复一次，重新解析后语法通过、诊断数为 0。修复结果恢复到原文件哈希。
5. 本地工作台另行验证了真实模型分析、AI 代码生成任务、状态轮询及源码下载。此处与上面的 CLI 调用分别记录，不能把模拟编译器测试称为游戏编译。
6. 真正执行过独立普通 .NET 项目的编译与故障诊断测试。受控自动化测试覆盖“生成→编译失败→模型修复→再次编译”等分支，其中 Mod 编译结果由明确的测试替身注入。

凭据和原始验收产物保留在被 Git 忽略的本地文件中，不发布 API Key、游戏程序集、存档或资产。以上哈希用于标识一次模型返回，不承诺模型输出可重复。

## 尚未取得的证据

用户明确说明暂时没有游戏环境。本机没有配置 Stardew Valley / SMAPI 引用，所以完整构建模式返回环境阻塞，收费代码生成数为 0。

`CS1002` 来自真实编译器的语法解析，但没有进行游戏类型绑定、API 解析或目标程序集编译。因此：

- 真实 Mod DLL 编译：`not_run`。
- 游戏内加载和动作验收：`not_run`。
- 完整需求覆盖：未证明。
- 可安装/可玩声明：未作出。

## 可复查方法

```sh
npm test
npm run dev
# 独立语法检查，仅解析文本，不执行该 Mod：
node scripts/check-csharp-syntax.mjs /absolute/path/ModEntry.cs
```

语法工具输出固定 `scope=syntax-only`、`build=not_run`、`game=not_run`。真实 .NET 探针也只证明编译工具可用。CI 不配置用户 Key，不进行收费模型调用，不下载游戏或制作虚假游戏引用。

准备真实游戏/SMAPI、设置本地 `GAMEBRIDGE_GAME_PATH` 后，才可继续完整生成、编译、自动修复和自有 DLL 产出的验收；游戏内测试还需要单独记录版本、日志及行为结果。

实现依据：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[SMAPI 开发环境](https://wiki.stardewvalley.net/Modding:Modder_Guide/Get_Started)、[dotnet build](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build)。
