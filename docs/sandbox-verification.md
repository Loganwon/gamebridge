# GameBridge 沙盒验收：受限流程可运行，尚未达到稳定交付

日期：2026-10-28（Asia/Shanghai）· 0.4.1 Alpha。

这次实际使用了 macOS Seatbelt / `sandbox-exec`，不是只运行单元测试或语法检查。它限制受测编译器和模拟程序的文件内容读取、写入、联网和可执行程序。**通过的是项目自有接口模拟器中的有限机制；真实 Mod 编译、游戏加载和完整跨游戏体验仍未验证。**

[结构化结果](sandbox-verification-results.json) 包含失败记录、源码哈希、模型调用数与验证范围。

## 实测结果

| 检查 | 观察结果 | 能证明什么 |
| --- | --- | --- |
| OS 沙盒边界 | 10 项探针通过 | 外部 canary 读/写、符号链接目标读取、策略文件改写/改权限/删除、联网和 shell 执行被系统拒绝；内部写入可用；子进程无 API Key |
| 原有模型源码 | 初次 20/21 场景通过，1 项失败 | 抓到 120 ticks 被换算为 2001 ms，期望 2000 ms |
| 修正后的代码 | 21/21 场景、75 条断言通过 | 在有限模拟器内满足键位、参数、时长、冷却、状态门控和清理契约 |
| 故意错误的对照组 | C# 编译通过，行为检查失败 | 把速度额外加 1 时，测试确实识别错误，不是恒定返回成功 |
| 新的 DeepSeek 需求分析 | 失败并停止，`INVALID_PLAN` | 素材列表不符合本地格式要求；不能宣称端到端可靠性已通过 |
| 使用此前有效计划的真实 DeepSeek 生成 | 成功 | 模型返回了源码；最初遇到的两个事件类型编译错误来自测试夹具缺项 |
| 受控编译错误 → 真实 DeepSeek 修复 | 成功 | 在 OS 沙盒中取得真实 `CS1002`，模型修复后重新编译并通过 21 个行为场景 |
| 故意不给游戏引用的生产通道 | `blocked`，0 次收费生成，0 个 DLL | 没有用模拟接口绕过生产构建门槛 |

本轮总计三次真实模型调用：一次新分析失败、一次沿用旧计划的代码生成、一次受控编译错误修复。没有额外收费重试，也没有把回放旧计划标为新分析通过。素材列表提示已补充明确类型与长度规则，但本轮预算内未再次检验全新分析，稳定性仍待后续验证。

## 行为场景是什么

自有 `GameBridge.ContractSimulation` 普通 .NET 10 程序模拟输入事件、Buff 容器、工具和状态，不含商业游戏代码、资产或真实 SMAPI 引用，不会生成游戏同名 DLL，也不会用于 `GAMEBRIDGE_GAME_PATH`。

场景覆盖默认关闭、非自由/未进世界/多人门控、V/B 参数与输入抑制、近战工具限制、时长和冷却边界、两个机制独立计时、攻击过程中保留效果、切换武器、菜单、保存、换图、死亡、事件、多人转换、关闭配置、标题重置及保留其他 Mod 的 Buff。

新模型采用了真实 API 中合法的 `SavingEventArgs` 和 `ReturnedToTitleEventArgs`。第一次契约编译失败是因为模拟器只有通用 EventArgs；核对官方类型后补足夹具，没有让模型删除合法 API。这也说明模拟器不能替代真实游戏引用。[Saving 类型](https://raw.githubusercontent.com/Pathoschild/SMAPI/develop/src/SMAPI/Events/SavingEventArgs.cs)、[ReturnedToTitle 类型](https://raw.githubusercontent.com/Pathoschild/SMAPI/develop/src/SMAPI/Events/ReturnedToTitleEventArgs.cs)

受测代码在模拟器中的编译和执行，不会更新 `realModBuild` 或 `game`。所有报告仍为 `realModBuild=not_run`、`game=not_run`、`readyToInstall=false`。

## 本次发现并修复的问题

1. **时长浮点舍入**：先算 `1000 / 60` 再乘 ticks，120 ticks 会被向上取整到 2001 ms。改为先乘再除，模拟器确认结果为 2000 ms。
2. **显式配置绕过**：代码策略会漏过 `Enabled |= true`、别名、ref/out 和常见 TypeDescriptor 写入。现补充显式写入检查与回归；这仍不是控制流、安全或语义证明。
3. **编译进程截止不硬**：脱离进程组的后代若持有管道，原进程退出后观察者仍可能卡住。现超时/取消/溢出后有强制截止并销毁管道。只尝试终止受控进程组，不声称所有逃离后代都能被杀死。
4. **测试沙盒策略可被篡改**：最初策略文件在可写 scratch 中，受测程序能修改它，使下次调用失去约束。现策略位于独立不可写目录；修改、改权限、删除和后续外部读取的复测均被拒绝。

SDK 会调用固定 Roslyn `csc` apphost，因此执行白名单只增加精确 SDK 编译器路径，没有放开 shell。模型调用由沙盒外的受控进程处理；沙盒内没有凭据与网络权限。最终模型修复产物在最新保护策略下再次离线回放通过，没有追加模型费用。

这个 profile 不是虚拟机，也不代表对所有恶意代码或系统 IPC 的全面隔离保证。生产工作台仍然不执行生成 DLL；这里的运行只属于独立验收工具。

## 复查命令

需要 macOS 和 .NET SDK 10；未找到 OS 沙盒会失败，不用模拟结果替代。

```sh
# 不收费：固定示例 + OS 边界 + C# 行为检查 + 故意错误的对照组
npm run test:sandbox

# 不收费：回放指定源码与完整计划
npm run test:sandbox -- --source /path/ModEntry.cs --plan /path/plan.json

# 收费：新分析、生成与一次受控错误修复，最多三次模型调用；失败立即停止
npm run test:sandbox -- --live

# 收费：用已有源码/计划，只调用模型修复一次受控编译错误
npm run test:sandbox -- --source /path/ModEntry.cs --plan /path/plan.json --repair-live
```

原始输出默认进入被 Git 忽略的 `artifacts/sandbox-verification/`；临时程序、数据与沙盒策略在结束后清理。CI 只跑自有固定示例，不配置 Key、不调用模型；新增 macOS 沙盒检查作为发布门槛。

## 对“真的能用吗”的结论

需求规划、有限源码生成、编译诊断修复和有限行为测试已有实际运行证据，但新分析本轮仍发生格式失败。它目前不具备稳定的通用跨游戏转换能力，不能据此说角色、武器和招式已成功放进另一款真实游戏。

下一步仍需要真实 Stardew Valley / SMAPI 引用进行目标编译和游戏内验收，并继续改善模型结构输出的可靠性。沙盒不能生成缺失的游戏程序集、资产或适配能力。
