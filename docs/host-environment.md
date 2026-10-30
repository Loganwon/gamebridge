# GameBridge 动作宿主环境准备

更新于 2026-10-30（Asia/Shanghai）。用户当前没有 Windows 环境，后续先核查 macOS 可用宿主。动作规则、需求分析与宿主能力门控无需安装游戏；目前不需要为本项目购买游戏或上传文件。Bannerlord 保留为 Windows 候选，tModLoader 是待评估的 Mac 路线，两者均未接入 GameBridge。

## 何时需要准备

进入“宿主与来源准入”阶段、准备执行真实输入与动作探针时，需要所选宿主实际可运行的设备及游戏环境。届时先记录现有游戏、工具和版本，再冻结测试组合。若选择 Bannerlord，其首轮路线按 Windows 准备；当前不要求用户准备 Windows。规则模拟、模型分析及编译工具测试不能替代真实环境。

现有本机为 macOS；它可以继续运行本地工作台与规则测试。仅在 macOS 上填写一个 Windows 安装目录，不能证明 Windows 游戏可运行或完成宿主验收。

## macOS 候选路线

tModLoader 的 Steam 页面明确支持 Mac，并要求拥有 Terraria；1.4.4 路线的系统要求列为 macOS 12 Monterey。它由社区 TML Team 开发，Steam 发布方包括 Re-Logic 和 TML Team。这里将 Terraria 研究为**宿主**，来源动作仍需单独选择与定义。[官方 Steam 页面](https://store.steampowered.com/app/1281930/tModLoader/)

项目自己的开发指南要求 .NET 8 SDK x64，明确提醒不要直接使用 .NET 9/10；本项目现有 .NET 10 不能据此算作 tModLoader 环境就绪。需要先核对实际版本、Mac 架构和运行方式，另行锁定开发环境，当前没有安装额外 SDK。[开发指南](https://github.com/tModLoader/tModLoader/wiki/Developing-with-Visual-Studio-Code)

ModPlayer 文档提供玩家更新、命中与受击等钩子，可作为动作接口调查的依据；规则到实际输入、动画、位移和敌人交互仍需探针验证。[官方项目 API](https://docs.tmodloader.net/docs/stable/class_mod_player.html)

以调研时的 `v2026.08.3.0` 工具源码为例，其目标为 net8.0，引用已安装的 tModLoader 及配套库，打包目标还会启动 tModLoader 构建程序并带有分析器。它不属于现有固定 SMAPI 编译器支持的环境，不能简单更换引用后宣称完成接入；需要独立的构建、工具执行与打包边界。该调研标签不是本机已安装或已验收版本。[该标签的构建目标](https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/release_extras/tMLMod.targets)

下一步先确认这条路线能否覆盖预定动作片段，以及本机可用条件，再决定是否进入真实游戏准备。当前候选目录没有 tModLoader 动作适配器；即使填写其名称，仍按未知宿主阻断。

这是一条二维动作候选，不能代表三维骨骼、相机或角色表现已经可转化，也不预设玩家愿意改为二维体验。

## Bannerlord 候选需要什么

| 项目 | 准备内容 | 验证目的 |
| --- | --- | --- |
| 测试设备 | 能正常运行游戏与官方 Mod 工具的 Windows 设备 | 真实输入、动画、命中与反馈 |
| 游戏 | 合法取得的 Mount & Blade II Bannerlord PC 版本 | 记录准确游戏版本和安装方式 |
| 官方工具 | Steam 工具库中的 Mount & Blade Bannerlord Modding Tools | 工具和游戏必须同版本、安装在同一硬盘 |
| 测试配置 | 独立测试存档或可重复的单人测试场景；先记录已有 Mod | 避免现有 Mod 干扰结果，核对恢复行为 |
| 来源规格 | 来源游戏及版本、武器与招式、参考出处、动作顺序和时序、允许近似 | 判断是否体现了来源玩法 |
| 可用资源 | 所需动作、武器或角色素材的来源与使用范围 | 验证导入和绑定；缺资源继续列为缺口 |

TaleWorlds 官方要求工具与游戏同版本并安装在同一硬盘；编辑器可从单人启动器进入。[官方工具说明](https://moddocs.bannerlord.com/asset-management/faq/) 游戏官方 PC 页面列出 Windows 环境要求；具体测试设备仍需实际启动核对。[官方游戏页面](https://store.steampowered.com/app/261550/Mount__Blade_II_Bannerlord/)

官方 API 索引提供多个版本的文档，但文档版本不是本地已安装或已验收版本。当前不指定“最新版本”作为兼容承诺；先确认可用游戏和工具，再将精确版本写入适配器与报告。[版本化 API 索引](https://apidoc.bannerlord.com/)

## 第一次真实测试检查什么

首先验证模块加载、版本识别与退出恢复，再检查输入能否驱动必要动作、动画和状态时序能否对应、命中能否作用于真实目标，以及死亡、菜单和场景切换后能否清理状态。动作片段需要的接口缺失时停止该候选，保留原因。

官方动画导入流程包含骨骼、动画片段和混合配置；这些文档只说明资源工具，不证明连击、取消窗口或碰撞控制已可用于本项目。[动画导入文档](https://moddocs.bannerlord.com/asset-management/asset-types/animations/)

最初测试不依赖原游戏角色外观：可以先复用宿主玩家角色，验证明确的来源动作规则。若需求包含来源角色外观或原招式动画，则资源与映射仍是必需验收项，不能由默认角色替代后宣布完成。

## 环境信息如何使用

工作台的宿主门控只处理游戏名称、目标版本，以及用户自报的平台、游戏与工具版本和安装状态元数据。它不扫描整台电脑、不读取安装目录、不执行游戏；即使全部填写完整，报告仍为 `blocked`、`realModBuild=not_run`、`game=not_run`、`readyToInstall=false`。

游戏文件、资源、存档和凭据留在本地。不需要把 DLL、安装包、账号或素材上传到 GitHub。真实检查工具、安装与运行流程需要在具体宿主适配器中另行实现并验收。

当前 Stardew Valley / SMAPI 的两种 Buff 是独立管线测试，不能作为 Bannerlord 或任何动作宿主的环境证明。生产工作台仍不安装或执行生成 DLL。
