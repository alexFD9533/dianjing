# 点睛

> **AI 创作的最后一笔。**

点睛（Dianjing）是一款面向 AI 原型和本地 HTML 页面创作的浏览器端最后一公里编辑器。它让产品经理、设计师和前端协作者直接在真实页面上选择对象，完成文字、外观、间距和布局调整，并保留撤销、导出和交付记录。

点睛不是源码生成器，也不是任意网页的服务器端编辑器。它先处理可以安全落地的视觉微调，再把无法直接修改的部分整理成稳定的交接提示词，让用户交给自己的开发工具或 AI Agent。

## 当前产品

当前公开开发目标是新版 MV3 扩展：

- **Dock**：在当前页面中快速选择和修改对象；
- **完整工作台**：处理多对象布局、结构调整、历史、离线 HTML 和整页 PNG 导出；
- **AI 交接**：生成提示词并复制到剪贴板，不在扩展内执行外部 Agent。

正式运行入口是 apps/dock-extension。apps/extension 是旧版实现，apps/demo-pages 是历史原型/演示工程，不是当前插件入口。

## 快速开始

要求：Node.js 20+、pnpm 10.33.0、Chrome 或 Chromium。

```powershell
pnpm install --frozen-lockfile
pnpm build:dock
```

打开 chrome://extensions，启用“开发者模式”，选择“加载已解压的扩展”，加载 apps/dock-extension/dist。

基础检查：

```powershell
pnpm typecheck
pnpm test
pnpm build:dock
```

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
docs/open-source/          面向审查者和贡献者的工程说明
```

## 参与贡献

请先阅读 CONTRIBUTING.md。安全问题请不要公开提交到 Issue，见 SECURITY.md。当前仍处于 Alpha 阶段，产品边界和数据模型可能继续调整。

本项目使用 Apache-2.0 许可证。项目名称、图标和品牌素材不因代码许可证自动获得商标授权。

## 历史文档

现行公开工程文档集中在 docs/open-source。docs/archive 和部分中文产品文档保留历史上下文，可能使用旧品牌名“成章”，不代表当前运行入口。
