# 贡献指南

感谢你对点睛的兴趣。点睛目前处于 Alpha 阶段，贡献前请先阅读 [当前产品文档](docs/product/README.md) 和 [仓库工作流](docs/governance/repository-workflow.md)，确认修改的是正式入口，而不是历史原型或旧版插件。

## 当前开发入口

- 正式扩展：`apps/dock-extension`
- 共享协议与定位包：`packages/contracts`、`packages/selector-engine`
- 构建后回归：`scripts/validate-dock-*.mjs`
- 工程与权限边界：`docs/open-source/`
- Git/发布规则：[docs/governance](docs/governance/repository-workflow.md)
- 原型、旧版、第三方参考和内部过程：仅供本地对照，除非任务明确指向，否则不要修改或重新引入

## 开始工作

从最新 `origin/main` 创建干净分支和独立 worktree；不要在带有历史脏改动的工作区直接开发公开主线。进入仓库后依次读根 README、`package.json`、`docs/README.md` 和目标模块 README。修改前保存 `git status --short --branch`，保留无关改动。

## 本地检查

```powershell
pnpm install --frozen-lockfile
pnpm verify:public
```

`verify:public` 覆盖公开格式检查、lint、typecheck、unit、正式 Dock 构建、Dock E2E 和 Workspace E2E。涉及真实浏览器行为时，还应安装 Chromium 并单独确认：

```powershell
pnpm exec playwright install chromium
pnpm test:dock:e2e
pnpm test:dock:workspace
```

构建、静态检查或 CI 通过不能自动写成“已验收”；需要真实扩展重载、DOM/几何/导出证据或用户确认的，在 PR 中标明未完成项。

## 提交与 PR

每个分支保持单一目的。只选择性暂存明确文件，禁止 `git add .`、`git add -A`；不得提交 dist、测试过程中的临时截图、日志、内部过程目录、旧版/原型目录或真实业务数据。经过脱敏和内容审查、明确用于 README 或公开文档的正式配图可以提交。提交前运行：

```powershell
git diff --cached --check
```

Pull Request 使用 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)，说明：

1. 用户问题、影响范围和台账编号；
2. 修改的正式入口，以及为什么没有同步历史层；
3. 格式、lint、typecheck、unit、build、Dock/Workspace E2E 的逐项结果；
4. 真实浏览器验收、权限/隐私边界和导出证据；
5. 已知限制、未完成验收、文档和 CHANGELOG 是否同步。

## 行为准则与安全

请以清晰、尊重和可复现为原则参与讨论。安全问题请按照 SECURITY.md 报告，不要先公开发布利用细节。未经授权不要 push、打 tag、创建 Release 或修改 GitHub Settings。
