# 变更记录

## Unreleased

- 建立当前产品、治理流程和工程审查文档分层，明确 `apps/dock-extension` 是公开正式入口。
- 明确公开主线、历史归档和本地内部记录的边界；旧版插件、原型、第三方参考和内部过程资料不进入公开运行路径。
- 增加 `pnpm verify:public` 聚合验证命令，并让 CI 覆盖格式、lint、typecheck、unit、正式构建、Dock E2E 和 Workspace E2E。
- 收紧 tag 发布流程：`v*` 只在发布门槛完成后生成 `dianjing-<tag>.zip` 和 GitHub Release。

## 0.1.0-alpha.1

尚未发布。正式版本发布前，必须完成干净公开基线、依赖/素材许可证审计、真实 Chromium 回归和用户验收。CI 通过不等于 Alpha 已发布。
