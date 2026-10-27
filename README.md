# GameBridge

把静态建筑带到另一个游戏的编辑环境。首版是可运行的体素场景转换器，包含浏览器工作台、命令行、格式验证和自动部署配置。

[在线使用](https://loganwon.github.io/gamebridge/) · [GitHub 仓库](https://github.com/Loganwon/gamebridge) · [自动测试与部署](https://github.com/Loganwon/gamebridge/actions/workflows/check-and-deploy.yml)

**v0.1 Alpha：文件转换原型，目标游戏实机验收待完成。** “通用”指可扩展的输入/输出适配器；目前不支持任意游戏存档、运行中的游戏互联或完整玩法迁移。不承诺所有游戏零反作弊触发。

## 转换链路

```text
Minecraft 建筑 .schem ─┐
单模型 MagicaVoxel .vox ├→ GameBridge Scene v1 → 旋转 / 镜像 / 缩放 → Minecraft Java .mcfunction
GameBridge .json ──────┘                                       → Roblox Studio .lua
                                                             → Godot 4 .tscn
                                                             → GameBridge .json
```

文件由浏览器本地读取和处理，应用代码不会上传用户的地图。网页托管服务仍会接收正常页面请求。示例建筑由本项目程序生成，没有打包商业游戏素材。

## 本地运行

需要 Node.js 24 或更高版本，无第三方运行依赖。

```sh
npm test
npm run dev
```

打开 `http://127.0.0.1:4173`。上传建筑，选择目标、变换，检查体素预览和转换报告后下载。`npm run build` 将静态网页生成到 `dist/`，支持放在 GitHub Pages 项目子路径下。

```sh
# 把内置建筑转换为 Roblox Studio 脚本
npm run convert -- --demo --target roblox --out cloud-gate.lua

# Minecraft 建筑转 Godot 场景
npm run convert -- my-building.schem --target godot --rotation 90 --out building.tscn

# 生成可手动调用的 Minecraft Java 1.21 数据包目录
npm run convert -- --demo --target minecraft --datapack gamebridge-pack
```

命令行不会覆盖已有文件或数据包目录。`--scale` 支持 1–4 整数倍并实际复制体素；放大前检查输出数量上限。

## 支持范围

| 格式 | 支持内容 | 主要边界 |
| --- | --- | --- |
| Sponge `.schem` | Minecraft 静态体素建筑，v2 / v3，gzip 或原始 NBT | 方块转近似颜色；不保留实体、方块实体、红石、物品或脚本；不支持 `.mca` / `.mcworld` |
| MagicaVoxel `.vox` | 单模型，版本 150 / 200，RGBA 或默认调色板 | 不支持场景图和多模型；不支持复杂渲染材质 |
| GameBridge `.json` | Scene v1 完整体素结构 | 不是任意 JSON 地图格式 |
| Minecraft 输出 | Java 1.21 方块放置函数，固定方块调色板 | 色彩近似；其他版本须另行验证 |
| Roblox 输出 | Studio 中独立 Model 内的 Anchored Parts | 只导入可编辑项目，不注入在线体验 |
| Godot 输出 | Godot 4 Node3D、BoxMesh 与颜色材质 | 不附带碰撞、导航或玩法 |

输入最大 8 MiB，转换前后最多 32,768 体素，每轴最大 128 格。超限明确报错，不静默裁剪。`.schem` 解压与 NBT 解析另有资源限制。

## 在目标软件中导入

### Minecraft Java 1.21

先在新的测试世界中验证。网页导出的 `.mcfunction` 需要放进数据包；它不能直接粘贴到聊天框执行。命令行 `--datapack` 会生成完整结构：

```text
gamebridge-pack/
  pack.mcmeta
  data/gamebridge/function/build.mcfunction
```

`pack.mcmeta` 内容：

```json
{"pack":{"pack_format":48,"description":"GameBridge building"}}
```

将目录放入该世界的 `datapacks/`，在有命令权限的世界执行 `/reload`，站在建筑起点执行 `/function gamebridge:build`。正 X / Y / Z 方向是建筑占地范围；函数会替换被占用格子的现有方块。不会自动调用函数，不会清除空格中的原方块。导出结果只代表静态颜色近似。[Minecraft 1.21 官方格式说明](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21)

### Roblox Studio

在自己的空白 Studio 项目中打开 Command Bar，将 `.lua` 文件文本粘贴并执行。脚本创建一个新的 Model，不会删除已有模型。所有体素为 Anchored Part，1 格 = 1 stud。大量独立 Part 可能降低编辑器性能；先使用小建筑。[Studio Command Bar](https://create.roblox.com/docs/studio/overview#command-bar)

### Godot 4

把 `.tscn` 放入自己的 Godot 4 项目资源目录，在文件系统面板打开。1 格 = 1 世界单位；几何没有碰撞体。保存后重新打开检查朝向、尺寸和颜色。[TSCN 格式文档](https://docs.godotengine.org/en/4.6/engine_details/file_formats/tscn.html)

## GitHub 与在线更新

本项目已连接公开仓库 [Loganwon/gamebridge](https://github.com/Loganwon/gamebridge)。GitHub Pages 已启用，地址为 [loganwon.github.io/gamebridge](https://loganwon.github.io/gamebridge/)。每次推送 `main`，通过测试和构建后自动更新网页；首次远程部署已验收通过。

认证完成后可运行 `npm run github:publish`。该脚本需要官方 [GitHub CLI](https://cli.github.com/) 及 `gh auth login`；它只推送已经提交且工作区干净的 `main`，遇到同名既有仓库或其他 `origin` 不会覆盖。

以下步骤供重新配置或部署自己的副本使用；本仓库已完成：

1. 仓库 Settings → Pages → Source 选择 GitHub Actions。
2. Settings → Secrets and variables → Actions → Variables，设置 `PAGES_ENABLED` 为 `true`。
3. 在 Actions 中手动运行 “Check and deploy GameBridge”，或推送新的 `main` 提交。

此后每次推送 `main`，先运行格式/安全边界/CLI 测试，再构建和部署网页。PR 只运行验证，不发布。网页部署不需要额外的个人访问令牌。未开启 Pages 时仍运行 CI。[GitHub Pages 官方工作流说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

本地修改经过提交、推送才会在线更新。后续在此项目继续开发时，应在测试通过后同步 GitHub；用户上传的地图、账号凭据和个人文件不得加入公开仓库。

## 扩展方式

输入适配器把已支持的文件转换为 `Scene v1`；输出适配器只读取经过验证的统一结构，返回文件文本和转换报告。新增游戏时，先核实公开格式和官方编辑路径，再添加适配器、格式样本及目标软件验收记录。

见 [场景协议](docs/scene-format.md)、[技术依据与路线](docs/feasibility.md)。优先补充三端实机验收，再扩展真实游戏来源、网格输入、材质和碰撞。所有接入使用允许的离线编辑/导入流程；不使用进程注入、内存修改或反作弊规避。
