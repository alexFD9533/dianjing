# 贡献指南

感谢你对点睛的兴趣。点睛目前处于 Alpha 阶段，贡献前请先确认你修改的是当前正式入口，而不是历史原型或旧版插件。

## 当前开发入口

- 正式扩展：apps/dock-extension
- 共享协议与定位包：packages/contracts、packages/selector-engine
- 构建后回归：scripts/validate-dock-*.mjs
- 原型和旧版实现：仅供对照，除非 Issue 明确指向，否则不要修改

## 本地检查

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:dock
```

涉及真实浏览器行为时，还应安装 Chromium 并运行：

```powershell
pnpm exec playwright install chromium
pnpm test:dock:e2e
pnpm test:dock:workspace
```

## 提交要求

请让每个变更保持单一目的，并在 Pull Request 中说明：

1. 用户问题和影响范围；
2. 修改了哪个正式入口；
3. 如何验证了真实 DOM 状态、几何变化或导出结果；
4. 是否改变权限、隐私边界或公开文档；
5. 已知限制和未完成的浏览器验收。

不要提交 dist、本地截图、日志、.cairn、cairn、.local、.spec、.ui-design 或真实业务数据。

## 行为准则

请以清晰、尊重和可复现为原则参与讨论。安全问题请按照 SECURITY.md 报告，不要先公开发布利用细节。
