# 跨游戏场景转换：范围与技术依据

> 本文仅记录现有 v0.1 场景辅助模块，旧分期路线不再代表 GameBridge 的整体产品方向。用户已明确核心目标是把 A 游戏的内容与玩法带入 B 游戏；主线见 [跨游戏玩法桥接设计](gameplay-bridge.md)。

资料核验日期：2026-10-27。本文描述可行性与版本边界；功能实现、自动化测试、目标游戏实机验收是三个独立状态，不能互相替代。

首版把用户提供的体素模型转换成可导入的建筑文件。转换链路是 **输入适配器 → 统一体素场景 → 材质映射 → 目标导出器**。增加一个输入或输出适配器即可扩展覆盖面，避免为每两个游戏单独写一套转换器。

## 首版范围

| 输入或输出 | 首版定位 | 能保留的内容 | 不代表已经实现的能力 |
| --- | --- | --- | --- |
| 自定义场景 JSON | 输入与中间表示 | 格点位置、体素颜色、场景名称 | 任意游戏存档解析 |
| MagicaVoxel `.vox` | 单模型输入 | 体素尺寸、位置、调色板 | 多模型场景图、实例旋转、动画和完整渲染材质 |
| Minecraft Sponge `.schem` v2/v3 | 建筑输入，gzip 或未压缩 NBT | 静态方块占位与近似颜色，过滤空气 | 完整 `.mca` 世界、MCEdit `.schematic`、原方块身份/状态、实体、红石逻辑、方块实体、原粘贴偏移 |
| Minecraft Java 1.21 数据包 | 输出 `.mcfunction` 与 `pack.mcmeta` | 方块建筑与有限方块调色板 | 导入已有 Minecraft 世界、方块实体 NBT、红石逻辑、实体、Bedrock 兼容 |
| Roblox Studio Luau | 输出创建建筑的脚本 | 锚定方块的位置、尺寸、颜色 | 向任意 Roblox 游戏注入地图、读取他人体验、自动发布 |
| Godot 4 `.tscn` | 输出可编辑场景 | 体素几何与颜色 | 任意 Godot 成品游戏存档、原游戏玩法、自动碰撞/导航/角色系统 |

“输出文件已支持”仅表示程序可以生成该格式；“实机验收通过”还需在指定版本的目标软件中导入、检查外观和保存重开。网页中的模型预览只能验证中间场景，不能代替目标游戏验收。Sponge `.schem` 输入建立了 Minecraft 导出建筑到其他编辑器的文件路径，仍不等于支持直接读取各款游戏的完整地图，也不应把 Godot 编辑器输出称为任意 Godot 游戏接入。

## 已核验的一手依据与实现约束

### MagicaVoxel

作者的 `.vox` 基础规范定义 `VOX ` 文件头、版本号、`MAIN` 分块，以及 `SIZE`、`XYZI`、可选的 `RGBA`。坐标是整数格点，颜色索引和坐标分量使用字节；规范将 Z 标为重力方向。输入适配器必须显式转换坐标轴，并正确处理从 1 开始的调色板索引。缺少 `RGBA` 时应采用规范中的默认调色板，或者明确报错，不可静默生成灰色模型。[作者的基础格式规范](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt)

扩展规范另外定义 `nTRN`、`nGRP`、`nSHP` 场景图和变换。仅支持单模型的解析器应拒绝不支持的多模型/场景图文件并解释原因，或明确提供“仅提取指定模型”模式，不能静默丢失位移、旋转、隐藏状态后声称完成场景转换。[作者的扩展规范](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox-extension.txt)

### Minecraft Java

已实现的输入适配器读取 Sponge `.schem` v2 的 `Palette`/`BlockData`，以及 v3 的 `Schematic.Blocks.Palette`/`Data`；按 `x + z × Width + y × Width × Length` 解析 varint。它要求显式调色板，不支持 v2 无调色板的全局注册表索引。官方文件采用 gzip；未压缩 NBT 作为额外输入方式接受。[Sponge v2 规范](https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-2.md)、[Sponge v3 规范](https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md)

实现限制：输入不超过 8 MiB、逐块解压后不超过 16 MiB、每轴最多 128 格、非空气方块最多 32,768 个；NBT 深度最多 32 层、标签总数最多 131,072、列表最多 65,536 项。严格校验 NBT 字符串 UTF-8，包含 Java modified UTF-8 特殊编码的文件可能被拒绝。方块转为有限、不透明 RGB 颜色，未知方块为灰色；半砖、楼梯等同样变为完整体素。实体、方块实体、方块状态、红石行为、生物群系和原 `Offset` 不进入中间场景；输出以局部零点定位。测试使用按规范手工编码的 NBT 样本和 gzip，覆盖 v2/v3、轴序、空气过滤、非法数据与资源上限，尚不能替代用户实际建筑和目标软件的验收。

首版建议固定目标 **Java Edition 1.21**，使用 `pack_format: 48`。该版本已经把 `functions` 和 `tags/functions` 目录更名为 `function` 和 `tags/function`，因此导出位置应为 `data/<namespace>/function/<name>.mcfunction`。版本值属于目标配置，不能为消除兼容提示而随意改成最新版。[Mojang 1.21 发布说明](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21)

导出器可用相对坐标 `setblock` 描述体素。初期采用有限、固定、可校验的方块列表；颜色映射是视觉近似，不承诺保留源材质。建筑只在用户手动执行函数后放置，不应附带自动加载执行标签。必须在导入说明中标明占地范围、原点以及现有方块可能被替换；先在备份或新测试世界导入。大建筑需要数量限制与分批策略，不能假定一次函数调用能容纳无限命令。

### Roblox Studio

Roblox 的 `Part` 是可脚本创建的建筑单元，`BasePart` 提供尺寸、位置、颜色与 `Anchored` 等属性，因此可以把体素输出为锚定的 Part 并放进独立 Model。Studio Command Bar 支持执行 Luau；这里的执行场景是用户可编辑的 Studio 项目。[Part API](https://create.roblox.com/docs/reference/engine/classes/Part)、[BasePart API](https://create.roblox.com/docs/reference/engine/classes/BasePart)、[Studio Command Bar](https://create.roblox.com/docs/studio/overview#command-bar)

导出脚本宜先在内存中构建独立 Model，完成后加入 Workspace；不要删除同名旧模型。脚本不需要联网或开启 `loadstring`。大量独立 Part 会带来性能成本，后续可做同材质长方体合并。官方 CLI 也提供 `RunScript` 和本地 `.lua`/`.luau` 路径选项，可供后续自动化验收使用；是否可用仍需检查安装版本。[Roblox Studio CLI](https://create.roblox.com/docs/studio/cli)

### Godot

Godot `.tscn` 表示场景树，Godot 4 使用 `format=3`；该格式支持内嵌资源和节点。`MeshInstance3D` 配合 `BoxMesh`、`StandardMaterial3D` 可表达体素建筑。首版应声明明确的 Godot 4 目标版本，而不是保证所有 Godot 版本兼容。[Godot 4.6 TSCN 规范](https://docs.godotengine.org/en/4.6/engine_details/file_formats/tscn.html)、[BoxMesh API](https://docs.godotengine.org/en/stable/classes/class_boxmesh.html)

可见几何不自动等于可行走场景：如果导出器没有额外生成碰撞体，用户只能看到模型；碰撞、导航网格和可玩角色应作为后续独立功能标明。只导入用户拥有或获准编辑的 Godot 项目。

## 统一场景表示建议

以下是协议设计要求，不另立与实际实现冲突的 JSON 字段规范；最终字段以项目的 schema 和示例为准。

- 使用固定版本号、场景名称、整数体素坐标和颜色/材质表；体素记录引用材质索引。
- 统一采用 Y 向上、明确定义的右手坐标系。记录输入坐标到统一坐标的变换；不能只交换 Y/Z 却忽略镜像。可用带方向标记的非对称模型测试左右与朝向。
- 体素坐标代表格子的最小角；输出到以中心定位的 Part/BoxMesh 时，在每轴增加半格，避免跨格式出现半格偏移。
- Minecraft 的一格单位、Roblox 的 studs、Godot 的世界单位分别定义导出比例，不能把三个引擎的单位当成同一种物理长度。
- 空格和透明体素分开处理；声明透明度、玻璃、金属等材质在每个目标中的降级行为。
- 每次导出附带转换报告：目标版本、原始/导出体素数、尺寸、轴变换、材质替换、不支持特征和性能警告。
- 对文件大小、体素数、坐标范围、重复坐标、非法调色板索引设置明确限制；导出名称经过格式安全转义，不把源文件内容作为可执行代码拼接。

“通用”应是可扩展的中间表示与适配器协议。不同游戏的建筑、地形、网格、碰撞、实体脚本存在语义差异，不能保证任意场景无损转换。

## 与反作弊的关系

本工具的产品边界是离线文件转换与目标软件支持的编辑/导入流程，不连接运行中的受保护游戏，不读取进程内存，不注入代码，也不隐藏修改。用户的目标是避免因导入玩法触发反作弊，这应通过受允许的工作流实现；不能提供“所有游戏零封禁”保证。Steam 官方也明确指出第三方修改可能与 VAC 冲突，是否允许仍由具体游戏、服务器和平台规则决定。[Steam VAC 官方说明](https://help.steampowered.com/en/faqs/view/571A-97DA-70E9-FF74)、[Steam 关于第三方软件干扰的说明](https://help.steampowered.com/en/faqs/view/22C0-03D0-AE4B-04E8)

## 分期验收路线

1. **文件转换原型**：JSON/单模型 VOX/Sponge `.schem` 导入、体素预览、三种输出。测试覆盖真实二进制格式、字节序、调色板索引、损坏分块、轴向、输出格式和文件下载；示例模型明确标注来源。
2. **三端实机验收**：同一个带方向标记的小建筑分别在 Minecraft 1.21 测试世界、Roblox Studio 空白项目、固定 Godot 4 项目导入。记录版本、对象数、尺寸、朝向、颜色近似与错误日志；保存后重新打开检查。通过前保留“待实机验收”标记。
3. **扩展真实游戏格式**：在 Sponge 建筑静态几何子集基础上，以用户实际导出的样本完成端到端验收，再增加其他来源游戏格式、多模型、层级、旋转、材质和碰撞。每条游戏到游戏路径分别登记兼容版本和验收状态。
4. **扩展与持续更新**：增加版本化适配器清单、回归样本、转换报告和 GitHub CI。更新适配器后重新跑格式及目标软件验收，不把上游最新版本自动标为已兼容。

GitHub 保存的是本项目代码、文档和可再分发示例。用户的游戏存档、商业地图与贴图不应作为默认示例公开上传。
