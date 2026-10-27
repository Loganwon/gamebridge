# GameBridge 示例场景

`cloud-gate.json` 和 `cloud-gate.vox` 是同一个原创的「Cloud Gate」浮岛门楼，包含 1,054 个体素。可将任一文件拖入转换器，选择目标格式后导出。

- JSON 使用 `version: 1` 的 GameBridge 中间格式，坐标为 Y 轴向上，画布为 20 × 14 × 20。
- VOX 使用 MagicaVoxel 150 单模型格式及显式 RGBA 调色板。VOX 为 Z 轴向上；导入时进行保持左右手性的轴旋转，转换后与 JSON 中的体素位置一致。
- 示例内容由本项目生成，不包含从商业游戏中提取的资源、脚本或地图。

目标格式只保留静态体素和颜色。使用 Minecraft 导出时，颜色会近似映射为预设方块；Roblox 导出是供 Studio 执行的脚本，Godot 导出是可放入 Godot 4 项目的场景文件。
