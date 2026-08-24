# 公开范围清单

## 当前公开主线

- `apps/dock-extension`：正式 MV3 Dock、完整工作台、local preview 和公开运行入口；
- `packages/contracts`、`packages/selector-engine`：正式扩展使用的共享协议/定位包；
- 与正式扩展构建和回归直接相关的 `scripts/validate-dock-*.mjs`；
- `docs/product/`、`docs/governance/`、`docs/open-source/`、根 README、许可证和社区文件；
- 不含真实业务数据的测试 fixture、图标和必要构建资源。

## 公开仓库明确不承载的层

- `apps/extension`：旧版插件；
- `apps/demo-pages`：历史原型和演示工程；
- `apps/product-board`：内部产品治理看板；
- `cairn/`、`.local/`、`.spec/`、`.ui-design/`：项目过程、审查和本地产物；
- `docs/archive/`、`docs/design/`：历史文档、设计过程图和未审查截图；
- `third_party/clickdeck`：外部/历史参考实现；
- `debug.log` 和其他日志。

`.cairn/config.yaml` 是唯一纳入公开主线的项目治理配置，只包含名称、语言、Cairn 目录和毕业策略，不含知识正文或凭证。旧版、原型和内部资料如仍在开发者机器上，应通过本地归档分支/annotated tag 保留，不能被误当作发布代码。

## 提交和发布前确认

- 公开代码、图标、字体、示例和依赖的版权/许可证归属已确认；
- 没有客户数据、内部接口、Token、真实业务截图或未脱敏素材；
- 当前工作区中的旧实现、过程目录和生成物没有被暂存；
- `pnpm verify:public`、权限/隐私审查、真实 Chromium 验收和发布 artifact 边界均有准确证据；
- “CI 通过”与“用户已验收”分开记录，当前 Alpha 未发布。
