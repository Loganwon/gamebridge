# GameBridge

把游戏 A 的角色、内容和玩法带进游戏 B，通过游戏适配器与本地桥接形成可玩的互动体验。

**当前为设计阶段。尚未实现游戏运行时、适配插件或任何实机互联。** 原先偏离目标的静态建筑转换器已从当前版本删除，线上页面改为设计方案展示；旧实现仅留在 Git 历史中。

[在线方案](https://loganwon.github.io/gamebridge/) · [GitHub](https://github.com/Loganwon/gamebridge) · [自动测试与发布](https://github.com/Loganwon/gamebridge/actions/workflows/check-and-deploy.yml)

## 完整设计

| 文档 | 内容 |
| --- | --- |
| [总体设计方案](docs/gameplay-bridge.md) | 产品定义、技术路线、模块职责、技术选型、范围、里程碑、风险和待决事项 |
| [产品流程与实机验收](docs/product-and-validation.md) | 用户操作、界面状态、功能分期、组合兼容性、可玩与性能验收 |
| [运行时与适配器协议](docs/runtime-protocol.md) | 能力协商、消息、状态归属、空间与时间、恢复、存档及扩展合约 |

核心验收示例：A 的武器命中 B 的真实敌人，B 正确结算伤害并反击，A 收到受伤结果；切换控制、死亡恢复和重新载入后状态一致。网页模拟和配置文件导出不算完成。

主路线是两款游戏同时运行的桥接，原生玩法包是后续独立路线。每个具体游戏、版本、方向与玩法组合均需要适配及验证；Minecraft × 艾尔登法环仅作研究参照，不代表首发组合或已支持游戏。

## 本地阅读与预览

需要 Node.js 24+，当前设计站无第三方依赖：

```sh
npm test
npm run build
npm run dev
```

打开 `http://127.0.0.1:4173`。`site/` 是方案展示页，`docs/` 是详细文档；构建复制到 `dist/`，不会打包任何游戏文件。`npm test` 目前验证 GitHub 发布保护流程，不是游戏互联测试。旧 `convert` 命令、场景解析器、导入/导出界面、体素样例及对应测试均已移除。

## GitHub 与持续更新

公开仓库为 [Loganwon/gamebridge](https://github.com/Loganwon/gamebridge)。`main` 每次推送后由 GitHub Actions 运行测试与构建，再更新 GitHub Pages；仓库已启用 Pages，并配置 `PAGES_ENABLED=true`。PR 只验证，不发布。

`npm run github:publish` 使用已授权的官方 GitHub CLI，只从干净的 `main` 普通推送到经过校验的公开仓库，并比较远程提交。CLI 需在 `PATH` 中；本机已配置的副本在被 Git 忽略的 `.tools/bin/gh`。认证信息不会写入源码。GitHub CLI 授权不代表 Codex GitHub 插件已连接。

网站更新只更新方案与未来的兼容资料。未来游戏适配器使用独立版本和验收记录，不能随网站推送自动替换运行中的游戏插件。

## 项目边界

通过官方或获允许的 Mod、插件、导入或编辑接口接入，不实现进程注入、内存修改或反作弊规避，不承诺零封禁。用户游戏资产、存档和凭据保留本地；只发布项目自身代码、设计及有权分发的示例。未知能力和未经验证的组合明确显示不支持或待验证。
