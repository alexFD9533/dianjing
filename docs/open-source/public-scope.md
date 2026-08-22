# 公开范围清单

## 首版公开

- apps/dock-extension
- packages/contracts
- packages/selector-engine
- 与正式扩展构建和回归直接相关的 scripts/validate-dock-*.mjs
- 脱敏的示例页面和必要测试 fixtures
- docs/open-source、根 README、许可证和社区文件

## 首版不作为正式运行入口

- apps/extension：旧版插件
- apps/demo-pages：历史原型和演示工程
- apps/product-board：内部产品治理看板
- .cairn、cairn、.local、.spec、.ui-design：项目过程、审查和本地产物
- docs/design：设计过程图和未审查截图
- debug.log 和其他日志

third_party/clickdeck 不属于首版公开基线；它只保留在开发工作区作为独立上游参考。若未来重新引入，必须同时保留其 MIT License 和版权声明。

## 提交前必须确认

- 公开代码和素材的版权归属已确认；
- 没有客户数据、内部接口、真实业务截图或未授权字体/图标；
- 当前工作区中的旧实现和过程目录没有被无意暂存；
- 公开基线通过构建、测试、权限和依赖许可证检查。
