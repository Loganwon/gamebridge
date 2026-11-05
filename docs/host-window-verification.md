# Mac 宿主启动与交互验收：0.8.2 Alpha

更新于 2026-11-05（Asia/Shanghai）。**官方 SuperTux 0.7.0 x64 经 Rosetta，在本机 OS 隔离下完成了一次真实按键、位移和状态恢复验证。** 用户手动操作，原生控制器记录按下、后续保持和松开；同一周期的实际坐标变化、状态归零及四次稳定恢复全部通过严格检查。桌面工具仍无法绑定窗口，不能称为自动桌面验收；这也不是来源内容转换、Mod 构建或正式宿主支持。

## 可重复入口

```sh
npm run verify:host -- /absolute/path/official-SuperTux-0.7.0-x64.app --interactive --gui-launch
```

需要 macOS、Node.js 24+、现有 Rosetta 和 Xcode Command Line Tools 的 clang/libsandbox。命令不下载软件或游戏、不调用模型。它将准确版本的本地应用及运行工作区放到新的私有 ASCII 临时目录，生成受信启动器，并打印一次性 `appPath`。桌面控制器或用户需要在该次 CLI 仍运行时打开这个路径；点击窗口获得焦点，按 Return 通过原版介绍页，松开所有键，等原生文字出现 `READY` 再保持左 Control 并松开。提示仅用于本地接口检查，没有替换控制器。

这是限时诊断入口，成功后会主动退出，交互阶段最多等待 180 秒；不适合作为日常游玩启动器。关闭、取消或过期后启动器不能获得新的执行许可。旧流程在交互完成后还会启动错误脚本控制，叠加人工追加尝试，造成用户看到连续开关窗口。本轮用户指出打断操作后，停止全部追加游戏启动；代码已改为先错误脚本控制、后交互，并为前者配置官方 `null` 无窗口渲染后端。**这个最终顺序和 null 路径尚未再次运行游戏验证**；下述完整通过记录来自调整前的顺序与 SDL 错误脚本控制，不冒充新路径实测。

开发者也可单独用 `npm run prepare:host -- /absolute/vendor.app /absolute/new-probe.app` 检查普通重排布局；这仅准备副本，不启动、安装或交付 Mod。

## 改动与实际观察

| 层次 | 实现与本轮证据 |
| --- | --- |
| 原包与重排 | 固定官方 x64 主程序、Info 与原包装器哈希。实际将 5524 条源树条目复制为 5583 条，主程序字节不变，Frameworks 成套移到标准相对位置；源内容/布局/执行位前后相同。副本是项目重排产物，不沿用原包身份 |
| 文件安全 | 新目标必须不存在；限制条目、大小、深度与链接范围。macOS 仅查询 xattr 名称，发现 quarantine 或查询失败即拒绝准备，不删除安全标记。树哈希不涵盖全部 xattr、权限、UID 或发行者认证 |
| GUI 启动桥 | LaunchServices 启动同包的固定脚本入口，再进入本地 clang 编译的受信 C helper。PID/组/微秒启动身份与 nonce 握手，绑定复核后才 ack。参数、环境、工作目录、程序和策略由本地锁定；模型没有源码或命令入口 |
| OS 隔离 | helper 本进程加载与 Node 预检相同哈希的 `sandbox_init` 策略，再执行固定游戏；真实游戏输出中记录了工作区读写/应用读取正控和六项拒绝控制。真实 `.env` 仅尝试打开，未读取内容 |
| 标准描述符 | 修复 LaunchServices 可能关闭 0/1/2 时的重定向问题。实际自有 C payload 经关闭标准描述符→脚本入口→helper→原策略→六项拒绝控制，输出预期标记并观察到退场。该用例不是游戏交互验收 |
| 原生脚本 | 新的严格观察脚本实际被游戏 VM 编译，仍运行了 40 个内核向量及 7 次预期拒绝；它们仍属于内核用例 |
| 窗口与画面 | 原生/脚本入口、同进程隔离与 ASCII 应用路径分别尝试。用户从无窗口、黑屏更新为已有画面及可进入游戏，最终手动完成完整输入周期；桌面绑定仍报超时/找不到运行应用，没有自动按键或截图验收 |
| 渲染调查 | 软件 SDL 在 Cocoa 上仍需显示表面。依实际拒绝增加精确 `IOSurfaceRootUserClient`、`AGXDeviceUserClient`、`IOGPUGLDrawableUserClient`、`IOGPUSurfaceMTL` 与 `MTLCompilerService`；不导入全部 graphics/IOKit，不增加全局 HID、屏幕捕获、网络或用户目录权限。独立 OpenGL 仍失败 1286，最终正向使用 SDL 软件渲染路径 |
| 工作区与查询 | 两次采样在原生配置读取的 `open` 停留；将工作区也移出 Documents/中文路径后越过该阶段。随后补充两个精确 TCC 查询端点，不授予 TCC 同意。没有逐项对照证明哪项单独修复了画面、焦点或目录访问，不能声称已经定位唯一根因 |
| 进程观察 | 修复检查器执行失败/超时被当作退出的缺口。只有实际 `ESRCH` 或原 PID 身份变化才能记录退出；检查失败回收绑定组，不提升退出证据。自有 fork/reap 实测缺失为 0 字节/errno 3，生成 C helper 另经真实编译与身份查询 |
| 准备与取消 | 准备阶段纳入统一 try/finally 并先落尝试状态，失败诊断保存传递取消信号。真实不存在路径保存 failed/admission；准备官方包 500ms 后取消保存 cancelled/bundle-preparation，无游戏启动、无晚产物/写入 |
| 转换状态 | 云端调用 0，游戏适配器仍空；真实 Mod 构建、来源保真与转换游戏验收均 `not_run`，`readyToInstall=false` |

Node 原有的六项拒绝控制继续保留。C helper 另行实测凭据 canary、策略读取、工作区外写入、真实 `.env` 打开、回环和外部 TCP 的拒绝；不能把两组控制相加当作游戏通过次数。图形客户端权限的用途是渲染/显示，不证明任意模型程序可以安全运行。

## 完整真实记录

本地 `artifacts/host-preflight/attempt-KhTmfB/summary.json` 为 `passed`；正向私有产物清单 SHA-256 为 `7491c6253470944c18a7d437341dd54b2bd45f0c81cee89da02e8923d2f370ce`，独立只读复核通过清单/文件哈希并重跑严格解析。没有再次启动游戏复核。

| 观察 | 原生记录 |
| --- | --- |
| 内核 | 40 步、7 次预期拒绝，不将其当作 40 次游戏交互 |
| 自动脉冲 | tick 43 的 x=96 → tick 52 的 x=100.793；53–56 四次 x 不变、vx=0、safe=false |
| 真实按下/保持 | tick 160，p/h=true，x=100.793、active、remaining=12；161–171 的 p=false/h=true |
| 交互位移/状态 | tick 172，x=139.178、ready、remaining=0、vx=0、safe=false，水平位移约 38.385 原生坐标单位 |
| 松开/恢复 | tick 253，h=false/r=true；254–257 四次坐标不变、ready、remaining=0、vx=0、safe=false |
| OS 与退出 | C 正控及六项拒绝通过；观察到原进程身份结束，无超时/取消/溢出/绑定失败；末次检查未另存，不区分 PID 缺失或身份变化，退出码仍未知/null |
| 错误脚本 | 独立原生编译器在 1 行 18 列拒绝 expression；15 秒受控回收，该项使用当时 SDL 路径 |

此前 `attempt-MKHBwX` 只通过自动脉冲与恢复，输入周期未完成；`fmaB0o`/`BS6Sb6` 为等待超时阻断，`5H22zo` 为 OpenGL 1286 失败。它们全部保留，未被最终成功覆盖。用户能够操作不代表每次诊断都完成，早先将未完成记录反复作为重开理由的操作已停止。

## 交互通过条件

真实脚本输出严格的 `GB_OBS` 整行记录，包含周期、递增更新计数、坐标、速度、安全标志、状态、剩余计数和真实输入。必须按同一周期依次观察：

1. 静止基线，方向与动作键未保持。
2. 原生更新后自动脉冲产生实际水平位移，安全标志和水平速度恢复，之后四次原生更新仍稳定。
3. 动作键按下；至少一次后续更新为保持且不是再次按下；随后松开。
4. 状态 `ready → active → ready`，12 次更新使剩余计数逐步归零，真实坐标增加。
5. 安全标志恢复基线、水平速度近零，四次后续原生更新不再漂移，最后才产生完整结束标记。

水平速度容差 0.01、恢复位移容差 0.05；不重置 X/Y 或垂直速度。不把离散更新计数称为准确墙钟时长，也不把安全 flag 读回称为受击免疫。缺记录、倒序、额外周期、无限值、缺保持/松开、伪结束后缀或未完成恢复都会拒收。

退出状态分开记录：LaunchServices 不是 Node 的子进程，桥接只报告观察到退场，`exitCode` 保持 `null`，不会伪造正常退出码 0。完整原生观察、实际隔离控制与进程退场必须分别满足；坏脚本的受控超时回收仍单独保留。

## 记录与限制

失败、追加尝试、原生输出、编译源码、启动器二进制、策略和阶段日志保存在私有文件产物中，快照只存 handle 与元数据；源码/策略等有界诊断在临时策略目录关闭前捕获。旧阶段只保留哈希的启动诊断没有冒充完整原始文件留存。原始游戏包、关卡、临时副本、存档和凭据均不进入 Git。

主要本地记录在 `artifacts/host-window-20261105/` 与 `artifacts/host-preflight/attempt-*`。原生入口、经 `sandbox-exec` 的中间进程、直接 `sandbox_init`、脚本主入口、ASCII 临时路径和软件显示的尝试分别记录，不能把后来的运行覆盖为此前自动成功。复制 Apple 平台二进制作为 stdout payload 的一次空输出失败也保留，原因未当作已解决。

代码检查为 195 项 Node 测试通过、0 跳过；这不是 195 项真实游戏测试。新增 GUI 检查器生成 C 编译/查询、CLI 不存在路径与准备期取消验证另行记录。最终仅调整负控顺序、官方 null 后端和启动说明后，没有为复测这些低影响流程修改再打开游戏。

当前仅限本机受信官方程序与自有确定性探针。没有生产级任意源码沙箱、完整 AppKit/IPC 权限证明或跨进程同 ID 并发保证；同用户恶意文件替换/PID 竞争不在完整防护范围，CLI 验证应逐次运行。这一次原生接口通过尚不具备资源/动作语义适配、打包、正式宿主后端或其他版本验收，仍不登记游戏支持。下一步应把已验证的输入→规格→宿主效果→恢复抽成受限适配接口，不继续用重复探针或固定玩法替代转换器。

依据：[Apple 应用 bundle 布局](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/BundleTypes/BundleTypes.html)、[LaunchServices 应用登记](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCConcepts/LSCConcepts.html)、[SuperTux 0.7.0 SDL renderer](https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/video/sdl/sdl_video_system.cpp)、[SDL 2.32.10 renderer hint](https://raw.githubusercontent.com/libsdl-org/SDL/release-2.32.10/include/SDL_hints.h)。精确图形客户端参照本机 macOS 26.1 `system.sb` 和 `com.apple.HydraRenderingService.sb`，没有导入整份系统策略。

无窗口后端的依据为官方 [null 参数映射](https://github.com/SuperTux/supertux/blob/v0.7.0/src/video/video_system.cpp#L115) 与 [NullVideoSystem 说明](https://github.com/SuperTux/supertux/blob/v0.7.0/src/video/null/null_video_system.hpp)；它仍会进行 SDL 视频初始化，不能扩大为完全不访问 OS 视频服务。
