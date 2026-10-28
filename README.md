# GameBridge — AI Mod 制作工作台

用户描述“在宿主游戏里体验另一款游戏的角色、武器、招式和动作交互”，GameBridge 调用配置的模型，拆解需求、检查适配能力，生成并验证 Mod 工程。

**当前版本 0.3 Alpha：已实现本地模型请求接口、需求计划校验、受限 SMAPI 源码草稿生成与 ZIP 下载。尚未进行真实云端调用、Mod 编译或游戏实机验收。** 当前模型负责规划，固定生成器负责源码；任意游戏、角色、资源与复杂招式的自动研发仍待实现。被拒绝的建筑转换器和 Glitch/Repixture 原型不在本版本中。

[公开页面](https://loganwon.github.io/gamebridge/) · [完整工具设计与使用说明](docs/ai-mod-workbench.md) · [GitHub](https://github.com/Loganwon/gamebridge)

## 本地启动

需要 Node.js 24+，无第三方 npm 运行依赖。

```sh
npm test
npm run dev
```

打开 `http://127.0.0.1:4173`。填写宿主、玩法来源及完整需求，然后配置模型并点击“分析需求”。只在点击后才发送需求文本。API Key 仅用于该次本地请求，不写入浏览器存储、下载包或项目文件。

也可复制 `.env.example` 为本地 `.env`，填写 `DEEPSEEK_API_KEY`。默认端点为 `https://api.deepseek.com`、模型 `deepseek-flash`；模型 ID 可修改。目前传输层支持同样在根路径提供 `/chat/completions` 的 HTTPS 云端接口，其他 API 形状需新增供应商适配。

没有 API Key 时，可点击“查看示例工程”。它使用固定示例，不调用模型，结果会明确标为 `example`。GitHub Pages 只展示界面和本地启动说明，模型配置和制作操作在本地服务中进行。

## 当前产物与限制

需求计划会保留原始请求，并将各项需求标为源码草稿可生成、需素材、需新适配或不支持。模型不能自行把“已编译”“已实机验证”写成通过。

当前生成适配器仅输出 Stardew Valley / SMAPI 的源工程草稿，覆盖短时速度 Buff 和短时近战倍率 Buff。它们**不等同于来源游戏的完整冲刺控制器、武器模型或招式系统**。完整角色、动画、武器资源及 GTA 等宿主仍列为缺口；不会静默删掉这些要求或生成假的插件。

ZIP 包包含 C# 工程、清单、配置、完整计划、来源状态、验证报告与构建说明，不包含 DLL、游戏程序集或商业游戏素材。目标为 Stardew Valley 1.6.14+ / SMAPI 4.5.2+ / .NET 6，构建依赖固定为 ModBuildConfig 4.4.0；这些目标尚未在本机编译和实机验证。

源码生成、静态检查、编译和真实游戏验收是独立阶段。目前停在源码静态检查；本机未检测到星露谷及所需引用。下一阶段需补充实际游戏环境和更完整的动作适配器。

## 结构与持续更新

`src/ai/` 是可替换的模型传输与计划校验，`src/generator/` 是宿主工程生成器，`src/workbench-server.mjs` 是仅监听本机的服务，`site/` 是工作台界面。`npm run build` 将静态页面与文档放入 `dist/`。公开网页不托管 API Key 或本地制作服务。

每次项目改动按约定测试、构建、提交并普通推送；GitHub Actions 验证后更新 [GitHub Pages](https://loganwon.github.io/gamebridge/)。发布工具继续核对仓库身份、推送目标和远程提交，不上传用户游戏文件或凭据。网页部署成功不等于生成的 Mod 已通过游戏验证。
