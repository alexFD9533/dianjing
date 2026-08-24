# 点睛

> **AI 创作的最后一笔。**

AI 已经把网页做出来了，最后几个字、颜色、间距和布局却常常还要回到提示词或源码里反复沟通。

点睛（Dianjing）让你直接在真实页面上选中对象，像调整演示稿一样完成最后一轮视觉修改。能安全落地的改动当场完成，不能直接写回源码的部分会整理成清楚的交接提示词，再交给开发工具或 AI Agent。

**一句话理解：页面已经有了，用点睛完成交付前的最后一轮精修。**

[看看它怎么工作](#先看它怎么工作) · [完成 5 分钟体验](#5-分钟体验) · [查看试用指南](docs/product/user-guide.md) · [反馈问题](https://github.com/alexFD9533/dianjing/issues)

## 为什么需要点睛

| 原来的做法                                         | 使用点睛之后                                   |
| -------------------------------------------------- | ---------------------------------------------- |
| 为了改几个字或间距，重新描述需求、等待 AI 再生成   | 在真实页面上点选对象，直接修改并即时看到结果   |
| 不确定 AI 又改动了哪些无关部分                     | 每次改动都有记录，可以撤销、重做或取消单项修改 |
| 产品、设计和开发在截图、口头描述、源码之间来回确认 | 把对象、修改前后值和限制整理成明确的交接提示词 |
| 页面改完后还要另外想办法截图、保存或交付           | 导出离线 HTML 或整页 PNG，保留当前视觉结果     |

## 三个典型场景

1. **AI 原型精修**：AI 已经生成页面，产品经理或设计师直接调整文案、颜色、字号、边距和模块位置。
2. **评审现场修改**：评审过程中看到问题，当场修改、撤销和比较，不必把所有小问题重新排给开发。
3. **开发交接**：先把能确认的视觉结果调整好，再把无法直接写回源码的改动生成精确提示词交给开发或 AI Agent。

## 先看它怎么工作

### 1. 在当前页面直接调整

选中页面里的文字或模块后，Dock 会判断对象是否适合直接编辑，并提供文字、外观、间距、层级、撤销和修改记录等操作。修改只作用于当前页面会话或导出的副本，不会悄悄改写网站服务器。

![在当前页面中使用点睛 Dock 调整对象外观](docs/assets/screenshots/dock-appearance.png)

### 2. 进入完整工作台处理复杂调整

完整工作台把页面结构、真实画布和属性面板放在同一个界面中，适合打开本地 HTML、选择多个对象、调整布局与尺寸，并导出离线 HTML 或整页 PNG。

![在点睛完整工作台中编辑本地 HTML](docs/assets/screenshots/workspace-local-html.png)

> 截图来自当前版本的脱敏测试页面，仅用于展示产品界面与操作方式，不包含真实业务数据。

## 谁最适合

- 用 AI 生成了网页或 HTML 原型，想像调整演示稿一样完成最后一轮细节修改；
- 产品、设计、运营等不想为了改几个字、颜色或间距反复进入源码；
- 需要把修改结果导出为静态 HTML、整页 PNG，或整理成可交给开发工具/AI Agent 的提示词。

点睛目前更适合“最后一公里”的视觉调整和静态交付，不适合替代完整的前端开发环境，也不承诺直接写回 React、TSX、Vue 等源码。

## 5 分钟体验

第一次使用不需要把所有功能都看完，只做下面五件事：

1. 打开一个不含隐私信息的本地 HTML 或测试页面；
2. 用点睛选中一个标题，修改文字或颜色；
3. 调整一次间距或对象位置；
4. 撤销刚才的修改，再重新应用；
5. 导出一张整页 PNG，或把修改结果导出为离线 HTML。

完成这条路径后，你就能判断点睛是否适合自己的 AI 页面修改和交付流程。普通试用者的安装步骤、第一次操作和反馈模板见 [点睛试用指南](docs/product/user-guide.md)。

## 文档导航

| 层级        | 入口                                                                                                   | 职责                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| current     | [docs/product](docs/product/README.md)、[apps/dock-extension/README.md](apps/dock-extension/README.md) | 当前产品定义、品牌、Alpha 范围和正式扩展行为           |
| governance  | [docs/governance](docs/governance/repository-workflow.md)                                              | 分支、选择性提交、PR、台账和发布流程                   |
| engineering | [docs/open-source](docs/open-source/README.md)                                                         | 架构、信任边界、流程、权限、变量和测试证据             |
| archive     | 本地归档分支/历史目录                                                                                  | 旧版插件、原型和历史文档，仅用于追溯，不是公开运行入口 |
| internal    | 本地内部记录与历史资料                                                                                | 项目过程、路线图、优化台账和历史资产，不进入公开主线   |

当前公开开发目标是新版 MV3 扩展：

- **Dock**：在当前页面中快速选择和修改对象；
- **完整工作台**：处理多对象布局、结构调整、历史、离线 HTML 和整页 PNG 导出；
- **AI 交接**：生成提示词并复制到剪贴板，不在扩展内执行外部 Agent。

正式运行入口是 `apps/dock-extension`。`apps/extension` 是旧版实现，`apps/demo-pages` 是历史原型/演示工程，`third_party/clickdeck` 是外部参考实现；它们不属于当前公开运行路径。

## 现在就试用

**当前要先说明一个限制：GitHub 仓库链接不是安装包。** 源代码已经公开，但首个 Alpha Release 尚未发布，也还没有上架 Chrome 扩展商店。不会构建源码的同事目前应等待首个 Release，或由项目维护者提供经过验证的扩展包。

首个 Release 发布后，普通试用者可以从 [Releases 页面](https://github.com/alexFD9533/dianjing/releases) 下载 ZIP，解压后在 Chrome 扩展管理页选择“加载已解压的扩展”。完整步骤见 [点睛试用指南](docs/product/user-guide.md)。

### 开发者从源码构建

需要准备 Node.js 20+、pnpm 10.33.0，以及 Chrome 或 Chromium。

安装和构建：

```powershell
pnpm install --frozen-lockfile
pnpm build:dock
```

打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展”，加载 `apps/dock-extension/dist`。

基础检查：

```powershell
pnpm typecheck
pnpm test
pnpm build:dock
```

公开合并前的聚合门槛：

```powershell
pnpm verify:public
```

它依次运行公开格式检查、lint、typecheck、unit、正式构建、Dock E2E 和 Workspace E2E。自动化通过不等于用户已验收；涉及页面行为仍需在目标 Chromium 中重新加载扩展并记录证据。

完整浏览器回归需要先安装 Playwright Chromium：

```powershell
pnpm exec playwright install chromium
pnpm test:dock:e2e
pnpm test:dock:workspace
```

## 支持范围

首个公开版本优先支持本地 HTML、localhost 和用户主动授权的普通网页副本。修改保存在当前会话或导出的静态副本中，不直接写回 React、TSX、Vue 等源码，也不上传用户正在编辑的页面内容。

暂不承诺任意动态网站的完整编辑、跨域 iframe、Shadow DOM、复杂 Canvas 内部编辑或服务器源码回写。详细的权限、数据流和已知限制见 docs/open-source。

## 仓库结构

```text
apps/dock-extension/       当前正式浏览器扩展
packages/contracts/        页面修改协议与数据校验
packages/selector-engine/  稳定 DOM 目标定位
scripts/                   构建后的插件回归验证
docs/product/              当前产品、品牌和 Alpha 范围
docs/governance/           Git、PR 和发布流程
docs/open-source/          面向审查者和贡献者的工程说明
```

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[仓库工作流](docs/governance/repository-workflow.md) 和 [发布清单](docs/governance/release-checklist.md)。正式公开改动必须从最新 `origin/main` 的干净分支开始，选择性暂存，禁止 `git add .`。安全问题请不要公开提交到 Issue，见 SECURITY.md。当前仍处于 Alpha 阶段，产品边界和数据模型可能继续调整。

如果你只是试用产品，不需要先学会提交代码：可以直接通过 [GitHub Issues](https://github.com/alexFD9533/dianjing/issues) 报告问题或提出建议。请说明使用场景、复现步骤和浏览器版本；截图或示例 HTML 请先移除账号、客户数据、内部地址和其他私人信息。

本项目使用 Apache-2.0 许可证。项目名称、图标和品牌素材不因代码许可证自动获得商标授权。

## 历史与内部资料

公开 `main` 不重新引入 `apps/extension`、`apps/demo-pages`、`third_party`、`docs/archive`、`apps/product-board` 或本地过程资料。它们若存在于开发者机器，只能作为本地历史/内部记录保留；删除前应先完成可恢复归档。当前源代码已公开，Alpha 版本可自行构建试用，但尚未发布到浏览器扩展商店。
