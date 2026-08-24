# Alpha 发布范围

## 当前判断

点睛 Alpha 尚未发布。公开仓库已具备正式入口、许可证、社区文件、工程边界和 CI/release 草案，但文档与自动化检查不能代替真实用户验收、版权/素材复核或发布动作。

## Alpha 必须包含

- `apps/dock-extension` 的 MV3 构建产物，以及 `packages/contracts`、`packages/selector-engine` 的稳定协议/定位能力。
- 当前页面 Dock 与完整工作台的选中、修改、撤销重做、历史和静态导出主路径。
- 用户主动打开 HTTP(S) 页面时的站点权限请求与拒绝路径；普通网页按网页副本语义处理。
- AI 交接提示词的生成和剪贴板复制，不执行外部 Agent。
- 依赖、图标、字体和示例素材的版权/许可证确认。

## 发布门槛

在干净依赖环境运行公开聚合验证：格式、lint、typecheck、unit、正式构建、Dock E2E 和 Workspace E2E。真实 Chromium 扩展重载/用户路径还必须有可追溯证据；CI 通过只能证明自动化门槛，不代表用户已经验收。

发布前还需完成：

1. 复核权限、隐私边界和所有外部请求；
2. 复核依赖及图片、字体、图标许可证；
3. 检查 zip 只包含 `apps/dock-extension/dist` 的正式产物；
4. 更新 `CHANGELOG.md`，确认版本号和 release notes；
5. 由明确授权者创建 `v*` tag。tag 触发 GitHub Release 和 `dianjing-<tag>.zip`，本分支不代打 tag。

## 当前未完成项

真实扩展重载验收、完整依赖/素材审计和用户确认仍需在 Alpha 发布前单独记录。不能把历史公开 commit 的 CI 记录写成当前用户已验收，也不能把仓库治理完成写成 Alpha 已发布。
