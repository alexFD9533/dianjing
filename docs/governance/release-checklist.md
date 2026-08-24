# 发布检查清单

## 进入发布候选

- [ ] 工作从最新 `origin/main` 的干净分支开始，提交范围已选择性检查。
- [ ] 当前产品入口仍为 `apps/dock-extension`；没有把旧版、原型、内部看板、Cairn 正文或第三方代码带回公开主线。
- [ ] `CHANGELOG.md`、版本号、公开产品范围和已知限制一致；当前状态没有被写成用户已验收。
- [ ] 许可证、图标、字体、示例页面和依赖许可证已复核，无客户数据、内部接口、Token 或未脱敏截图。

## 自动化门槛

- [ ] `pnpm install --frozen-lockfile` 在干净环境成功。
- [ ] `pnpm verify:public` 成功：格式、lint、typecheck、unit、正式构建、Dock E2E、Workspace E2E。
- [ ] zip 只包含 `apps/dock-extension/dist` 的加载所需产物，文件名为 `dianjing-<tag>.zip`。
- [ ] 失败/拒绝路径有证据：未授权页面、浏览器内部页、不稳定定位、导出资源失败和 AI 交接不执行 Agent。

## 真实验收与发布动作

- [ ] 在目标 Chromium 中重新加载构建产物，验证 Dock、完整工作台、权限请求/拒绝、撤销重做和导出。
- [ ] 记录真实 DOM 状态、几何/视口变化、文件导出结果或截图；CI 结果单独标注为自动化证据。
- [ ] 用户/发布负责人确认“已验收”，再把状态推进为“已发布”。
- [ ] 由授权者创建 `v*` tag；`release-artifact.yml` 才创建 GitHub Release、上传 artifact 并附加 zip。
- [ ] Release 完成后核对安装包、release notes、tag 指向的提交和 GitHub Actions 日志。

本轮治理只更新流程与工作流，不打 tag、不创建 Release、不修改 GitHub Settings 或分支保护。
