# 仓库工作流

## 分层原则

公开主线只包含点睛正式扩展、必要共享包、公开验证脚本和审查文档。旧版插件、原型、第三方参考、内部看板和 Cairn 正文保留在本地历史/内部治理层，不为“保持一致”而同步。

## 开始工作

1. `git fetch origin`，确认 `origin/main` 是基线。
2. 从 `origin/main` 创建单一目的分支和独立 worktree；正式公开改动不要在有历史脏改动的工作区完成。
3. 读取根 `AGENTS.md`、README、package scripts，再读取目标模块和对应文档/测试。
4. `git status --short --branch` 记录初始状态；发现不属于本任务的改动时保留并隔离。

## 实现与验证

需求状态依次为：`已规划 → 已实现 → 已验证 → 已验收 → 已发布`。代码实现后，按影响范围运行格式、lint、typecheck、unit、build 和对应的 Dock/Workspace E2E；涉及页面行为必须说明真实浏览器重载、DOM/几何/导出证据。CI 通过和静态构建通过不能直接写成用户验收。

## 提交与 PR

- 一个分支保持一个目的；提交前选择性暂存明确文件，禁止 `git add .` 或 `git add -A`。
- 运行 `git diff --cached --check`，检查敏感内容、大文件、生成物和路径边界。
- PR 必须写清用户问题、正式入口、权限/隐私影响、验证证据、未完成验收和台账编号。
- 合并前 CI 必须通过；优先 squash merge 到 `main`。未经另行确认，不 push、不修改 GitHub Settings/分支保护。

## 文档和台账

现行产品内容写入 `docs/product/`，工程审查内容写入 `docs/open-source/`，Git/发布流程写入 `docs/governance/`。`CHANGELOG.md` 只记录公开用户可见变化。内部 `apps/product-board/src/data/changes.ts` 只追加实质性优化；未明确要求整理台账时，不修改 `features.ts`、`versions.ts`、统计或 `KB-*`。

## 本地归档

本地旧版、原型和过程资料可以用独立归档分支/annotated tag 保存，以便追溯和恢复；归档提交不是公开发布代码。确认依赖和备份后再讨论物理删除，默认不删除历史资产。
