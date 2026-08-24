# 点睛仓库协作规则

本文件是公开仓库与本地历史工作区的共同入口。它描述当前可交付的产品主线、文档真相源和安全的协作边界；具体实现仍以代码、测试和 Git 历史为准。

## 1. 开发边界

- 当前正式产品和默认开发目标是 `apps/dock-extension`：新版 MV3 Dock、完整工作台、离线 HTML/整页 PNG 导出和用户触发的 AI 交接提示词复制。
- `packages/contracts` 与 `packages/selector-engine` 是当前公开主线的共享包；与正式扩展构建和回归直接相关的 `scripts/validate-dock-*.mjs` 才属于公开验证入口。
- `apps/extension` 是旧版插件，`apps/demo-pages` 是历史原型/演示工程，`third_party/clickdeck` 是外部参考实现；除非任务明确点名，不读取其实现作为当前产品结论，也不修改或重新引入它们。
- `apps/product-board`、`cairn/`、`.cairn/`、`.local/`、`.spec/`、`.ui-design/` 和设计过程资料属于本地内部治理或审查层，不进入公开主线。公开仓库只保留 `.cairn/config.yaml` 这一份可移植项目配置；Cairn 知识正文继续本地忽略。
- 历史目录不因进入新阶段而物理删除。公开主线与本地归档分离：公开分支只承载当前正式代码和审查所需文档；旧版、原型和过程资料留在本地归档分支/归档路径，除非用户另行确认迁移或删除。

## 2. 进入仓库的读取顺序

1. 先读本文件（`CLAUDE.md` 只引用本文件）。
2. 读根 `README.md`、`package.json`、`pnpm-workspace.yaml`，确认公开入口和可运行命令。
3. 读 `docs/README.md`，再按任务读取 `docs/product/`、`docs/governance/` 和 `docs/open-source/`；不要把历史中文文档当作当前规格。
4. 进入实现前读 `apps/dock-extension/README.md`、目标模块和对应测试/回归脚本。
5. 在本地归档工作区处理治理时，再读 `.cairn/config.yaml`、`cairn/ROADMAP.md`、`cairn/LOG.md` 和 `apps/product-board/src/data/changes.ts`；这些文件不是公开产品实现的真相源。
6. 修改前先执行 `git status --short --branch`，识别既有脏改动；不得还原、覆盖或顺手整理无关文件。

## 3. 文档真相源

| 主题                      | 真相源                                                   | 说明                                          |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| 当前产品定位与 Alpha 范围 | `docs/product/product-definition.md`、`alpha-release.md` | 点睛、正式 Dock/完整工作台和 AI 交接边界      |
| 品牌                      | `docs/product/brand.md`                                  | “点睛”是当前品牌；旧品牌只作历史引用          |
| 工程/安全/数据边界        | `docs/open-source/*.md`                                  | 架构、流程、权限、变量、测试和公开范围        |
| Git、PR、发布             | `docs/governance/*.md`、`CONTRIBUTING.md`、`.github/`    | 本文件只给协作硬约束                          |
| 实际实现与命令            | `apps/dock-extension`、`packages/*`、`package.json`      | 代码优先于旧文案                              |
| 优化台账（仅本地）        | `apps/product-board/src/data/changes.ts`                 | 只追加实质性变化；不代替公开 CHANGELOG        |
| 项目过程知识（仅本地）    | `cairn/`                                                 | 稳定结论写专题，原始过程不自动毕业到 Obsidian |

## 4. 需求状态与验收

所有产品优化按以下顺序记录，不能跳级或混用：

`已规划 → 已实现 → 已验证 → 已验收 → 已发布`

- “已实现”只说明代码已改；“已验证”必须给出对应的类型、单元、构建或回归证据。
- “已验收”必须有用户确认或明确的真实浏览器/扩展重载证据；构建、静态检查和 CI 通过不能代替用户验收。
- “已发布”只在版本 tag、GitHub Release 和对应 zip 产物都完成后使用。当前 Alpha 仍未发布。
- 点睛台账的实质变化追加到本地 `changes.ts`；除非用户明确要求“整理台账到看板”，不要改功能统计、版本快照或 `KB-*`。

## 5. Git 与 GitHub

- 正式公开改动只能从最新 `origin/main` 创建干净分支/worktree 开始；不要在包含历史脏改动的工作区直接开发公开主线。
- 一个分支保持单一目的；提交前只选择性暂存明确文件，禁止 `git add .`、`git add -A` 和把生成物/本地过程目录带入提交。
- 提交前至少运行 `git diff --cached --check`，并记录实际运行的格式、lint、typecheck、unit、build 与 Dock/Workspace E2E 结果。未完成的真实浏览器验收要明确写出，不能用“测试通过”代称。
- PR 合并到 `main` 前要求 CI 通过；优先 squash merge。未经用户明确授权，不 push、不打 tag、不创建 Release、不修改仓库 Settings 或分支保护设置。
- tag `v*` 是发布动作：只由通过发布门槛的提交触发 GitHub Release 和 `dianjing-<tag>.zip`。发布边界和清单见 `docs/governance/release-checklist.md`。

## 6. Cairn 与完成检查点

- `.cairn/config.yaml` 只保存可移植项目配置，不保存凭证；`cairn/` 正文保持本地忽略。
- 实质性进展完成后，在本地 `cairn/LOG.md` 顶部记录一条简短证据，必要时更新 `cairn/ROADMAP.md` 和专题文档；只读审计任务不写 Cairn。
- 结束前回读被更新的 Cairn 文件、检查其与实际状态一致，再在回复中说明是否写入。跨项目结论先征得用户确认，不自动毕业到 Obsidian。

## 7. 公开/内部发布边界

- 公开文档必须如实区分当前、建议、缺口和未验收项；不要把历史“成章”或“原型优先”叙述写成现行结论。
- AI 交接是用户触发的提示词生成与剪贴板复制，不是扩展内嵌 Agent；没有邮件、定时任务、SEO 服务或云端后台时，不创建虚假的空文档或能力声明。
- 任何新增权限、外部网络请求、客户端配置、源码回写或云端服务，都必须同步更新公开工程文档、测试映射和发布清单后才能合并。
