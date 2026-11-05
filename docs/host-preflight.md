# 真实宿主预检：0.8.1 Alpha

更新于 2026-11-05（Asia/Shanghai）。本轮新增通用 Squirrel 行为生成器、独立宿主预检记录合同，以及本机受信探针的 macOS 隔离运行入口。真实候选是免费开源游戏 SuperTux 0.7.0；**没有登记为已支持宿主，没有完成来源游戏到宿主的转换**。

这是 0.8.1 初轮记录；后续 0.8.2 启动桥、实际隔离控制、黑屏与严格交互验收见 [窗口接入记录](host-window-verification.md)。后续结果没有覆盖本页的失败。

## 本轮实际结果

| 项目 | 观察到的结果 |
| --- | --- |
| 官方 Mac arm64 包 | 下载 SHA-256 与官方发行资产一致；启动被系统终止。系统诊断为 `SIGKILL (Code Signature Invalid)` / `CODESIGNING Invalid Page`；没有重签名、删除隔离属性或修改系统安全设置 |
| 官方 Mac x86_64 包 | 下载 SHA-256 一致；在现有 Rosetta 环境中启动，报告 `supertux2 v0.7.0` |
| OS 边界 | 正向应用读取及工作区读写通过；凭据 canary、真实 `.env` 打开、工作区外写入、策略写入、回环与外部 TCP 六项控制均 `EPERM` |
| 同一 BehaviorSpec 的另一后端 | 三种内核结构与一次修改生成四份 Squirrel；SuperTux 原生 VM 编译执行了 40 步显式预期，包含 7 次拒绝后的状态不变断言 |
| 错误脚本 | 原生编译器对固定坏脚本报告 `init-script line = (1) column = (18) : error expression expected`，及 `Source cannot be compiled!`；不可达标记未执行。随后超时回收进程，超时不是正常退出 |
| 宿主状态写入 | 日志读回速度 `120` 和安全标志 `true`；这不证明物理位移、受击免疫或角色招式正确 |
| 真实计时、位移及输入 | **阻断**。脚本在等待后没有恢复；采样见原版 `LevelIntro` 介绍界面，关卡环境尚未继续。用户与桌面工具都未看到可操作的探针窗口 |
| AI、Mod 与转换验收 | 本轮云端调用 0；真实 Mod 构建与转换游戏验收均 `not_run`，`readyToInstall=false` |

40 个步骤仍是项目自有内核向量，不是用户提出的三种游戏交互需求，不覆盖全部状态/算子，更不证明来源玩法保真。此前 .NET/C# 证据与本轮 Squirrel 原生证据分开记录。

本地失败与后续尝试均保留于被 Git 忽略的 `artifacts/host-preflight/attempt-*`，每次有独立快照、日志与私有文件产物 handle；发行校验及 arm64 诊断摘录在 `artifacts/host-preflight-20261105/`。公开仓库不包含游戏包、原版关卡、存档、二进制或本地日志。

## 通用能力与候选探针的分工

`emitSquirrelBehavior()` 与 C# 后端接受同一份有界 BehaviorSpec 和独立绑定的需求 ID。生成代码没有宿主名、按键、武器、路径、文件导入或命令能力；短路求值、整数范围、同时更新与错误原子性遵循已有合同。模型仍不能输出或执行自由源码，分析结果尚未自动转成该规格。

`src/hosts/preflight.mjs` 接受有界普通数据，绑定本地提供的宿主、准确版本、平台、架构与可执行文件哈希；接口出处与正负探针记录分开，证据只能引用私有 handle。它不读取这些文件、不认证观察、不授予权限，也不登记适配器。即使正负记录齐备，仍固定 `status=blocked`、`supportRegistered=false`、`readyToGenerate=false`，保持转换验收未运行。

`src/hosts/supertux-probe.mjs` 是单独的本地接口实验。读取准确哈希的原有关卡，仅在私有副本增加原生 sector 初始化扩展，保留原地图、敌人、物理、统计与署名。固定原生绑定脉冲用于检查接口，**不是转换器交付的固定玩法模板**，也不接入分析工作台或游戏支持目录。

## 入口与边界

需要 Node.js 24+、macOS 和准确官方 0.7.0 应用副本；命令不自动下载、安装或调整安全设置。

```sh
npm run verify:host -- /absolute/path/SuperTux.app
# 在真实窗口按空格/Return 通过介绍页；以下另测试左 Control 按下和松开
npm run verify:host -- /absolute/path/SuperTux.app --interactive
```

可执行文件仅接受本轮核验的两个官方二进制哈希；未核验版本和平台不回退执行。生成与坏脚本都由本地锁定，不能由模型传入源码、可执行文件、环境、工作目录或命令。该入口没有 HTTP 路由。

OS 策略先通过正负控制才运行游戏。只允许读取应用、必要系统目录和本次工作区，只允许工作区写入；拒绝网络、凭据和策略文件访问。GUI IPC 采用精确服务名单。为 Rosetta 增加了精确系统目录只读；没有放开整个用户目录、共享偏好数据或所有 mach 服务。子进程没有模型 Key 或其他继承的凭据、解释器钩子。执行前后复核主程序指纹及输入，支持取消、超时和输出上限，关闭阻断等待后的晚启动。

这仅用于受信官方程序与自有确定性探针，不是任意模型 Mod runner。应用依赖和资源未递归签名/逐文件绑定，GUI IPC 也不是完整隔离证明；进程组回收不保证终止已经逃离的全部后代。

## 失败保留与下一道门槛

早期 Rosetta 运行时拒读、版本探针误用默认配置目录、相对关卡路径、未操作介绍页等失败均未覆盖。版本探针已使用独立 `--userdir`；关卡文件使用明确本地路径。额外关闭两个统计显示开关的试验也未能通过介绍页，这项改动已撤回，不能算修复或验收。

官方 bundle 的 `CFBundleExecutable` 指向 shell 包装器，而包装器调用实际程序时没有转发 `"$@"`：直接打开应用会丢失探针参数并进入普通菜单。桌面工具按 bundle 启动的一次普通菜单观察不是探针关卡证据，随后已关闭。直接运行实际程序与桌面识别失败之间的具体因果尚未证实，不能归因于某个缺失权限。

下一步优先解决**可追溯、保留参数且可观察的宿主启动方式**，保持私有用户目录与现有文件/网络边界。若采用自有 launcher 或修改自有应用副本，需记录新文件哈希与重打包差异，重新验证，不能沿用原包身份。通过真实输入→状态→物理作用→恢复后，再登记窄范围宿主后端、桥接 AI 到规格，并验证不同需求及一次修改。角色、骨骼、动画、命中、存档与全游戏作用域仍需各自补齐，不能被一次状态写入替代。

接口出处：[官方 0.7.0 发行](https://github.com/SuperTux/supertux/releases/tag/v0.7.0)、[玩家导出与输入实现](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/object/player.cpp)、[挂载与启动](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/supertux/main.cpp)、[脚本 VM](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/squirrel/squirrel_virtual_machine.cpp)、[介绍界面按键条件](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/supertux/levelintro.cpp)、[官方默认按键](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/control/keyboard_config.cpp)。
