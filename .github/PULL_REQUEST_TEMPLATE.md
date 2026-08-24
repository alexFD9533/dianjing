## 变更目的

请说明用户问题、影响范围、台账编号和为什么现在处理。

## 状态与范围

- 状态：`已规划 / 已实现 / 已验证 / 已验收 / 已发布`
- 正式入口：`apps/dock-extension` / `packages/*` / 文档或治理（请说明）
- [ ] 从最新 `origin/main` 的干净分支开始
- [ ] 只选择性暂存本次变更，未使用 `git add .` 或 `git add -A`
- [ ] 未主动同步旧版插件、原型、第三方参考或内部过程目录
- [ ] 已更新受影响的产品/工程公开文档和 CHANGELOG
- [ ] 未扩大权限、隐私边界、外部网络或源码回写语义

## 验证证据

逐项填写命令和结果；不要把未运行写成通过。

- [ ] `pnpm format:check:public`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build:dock`
- [ ] `pnpm test:dock:e2e`
- [ ] `pnpm test:dock:workspace`
- [ ] 真实 Chromium 扩展重载/用户验收，或说明未完成原因
- [ ] `git diff --cached --check`（提交前）

请附上关键 DOM 状态、几何/视口变化、权限拒绝、导出结果或截图证据。构建/CI 通过不等于用户已验收。

## 风险与发布

- 权限/隐私/变量变化：无 / 有（链接文档）
- 已知限制和未完成验收：
- 是否满足发布清单：是 / 否（说明）
