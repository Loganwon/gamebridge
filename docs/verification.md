# v0.1 验证记录

日期：2026-10-27（Asia/Shanghai）。环境：Node.js 24.21.0，macOS，Codex 内置浏览器。

## 已完成

- `npm test`：43 项全部通过。包含 13 项核心格式/变换测试、22 项 Sponge/NBT/压缩解析测试、3 项 CLI 集成测试、5 项 GitHub 发布流程隔离测试。
- `npm run build`：静态工作台构建成功，无第三方运行依赖。
- 浏览器载入原创 Cloud Gate：1,054 体素、20 × 14 × 20，等距预览正常。
- 旋转 90 度并放大 2 倍：8,432 体素、40 × 28 × 40。放大 4 倍超过限制后显示错误并禁用下载；重置后恢复。
- 浏览器真实下载 `cloud-gate.tscn`；检查文件头、资源与节点结构。
- 浏览器实际选择 gzip/NBT `samples/tiny-building.schem`：成功读取 18 体素、4 × 3 × 3；切换 Roblox、镜像后实际下载 `tiny-building.lua`。
- JS 语法、HTML ID/标签/锚点静态检查通过。UI 源码无 `innerHTML` 插入用户输入。
- GitHub 发布测试在临时目录中使用假 CLI：验证错误或多个 push URL、脏工作区及远程 HEAD 不一致会阻止成功报告；未代替真实 GitHub 认证。

## 尚未完成

- Minecraft Java 1.21、Roblox Studio、Godot 4 的实机导入、保存并重开验收。
- 移动设备实机测试、真实游戏作者提供的大型地图验证。
- GitHub 账号连接、公开 gamebridge 仓库创建、推送与远程 Actions/Pages 首次部署。它们需认证成功后检查实际结果，不能由本地测试推断。

测试样本由本项目程序创建，不包含其他用户或商业游戏资产。来源支持范围与材质损失详见 README 和 feasibility 文档。
