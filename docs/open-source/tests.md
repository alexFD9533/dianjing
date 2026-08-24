# 测试覆盖与发布门槛

本文件区分已有证据、建议补充和完全缺口。每一行都对应架构/流程/权限/变量文档中的一条规则；CI 必须运行标记为“CI gate”的检查，但 CI 通过仍不等于用户已验收。

## Existing coverage：仓库当前已有

| 用例               | 规则与负向行为                                                           | 证据（文档 + 代码）                                                                                    | 状态/CI gate                                     |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 修改协议与目标定位 | 合法协议可解析；缺少稳定目标或非法输入拒绝写入                           | `permissions.md`；`packages/contracts/src/index.test.ts`、`packages/selector-engine/src/index.test.ts` | existing；unit、typecheck                        |
| 入口权限分类       | 浏览器内部页/扩展商店不进入编辑；普通 HTTP(S) 不使用静默 host permission | `flows.md`；`src/background/entry-policy.test.ts`、`scripts/validate-dock-mv3-entry.mjs`               | existing；unit、Dock E2E                         |
| Dock 编辑闭环      | 文字/样式/撤销重做/历史/退出重新打开保持 before/after 语义               | `flows.md`；`scripts/validate-dock-e2e.mjs`                                                            | existing；Dock E2E                               |
| 工作台对象与布局   | 对象树、选择、布局和结构操作同步真实页面；非法/不适用目标不伪造成功      | `flows.md`；`src/workspace/*.{test.ts,ts}`、`scripts/validate-dock-workspace-e2e.mjs`                  | existing；Workspace E2E                          |
| AI 交接            | 有修改记录才生成提示词；剪贴板失败不声称成功；不执行 Agent               | `architecture.md`；`src/shared/ai-prompt.test.ts`、`scripts/validate-dock-e2e.mjs`                     | existing；unit、Dock/Workspace E2E               |
| 导出与资源边界     | HTML/PNG 用户主动触发；资源失败显示失败；PNG 后恢复 Dock、选框和滚动位置 | `flows.md`；`src/content/offline-html-export.ts`、`src/background/index.ts`、workspace E2E             | existing（自动化覆盖有限）；build、Workspace E2E |
| 可重复公开构建     | 冻结依赖、正式 Dock 产物可构建                                           | `release-checklist.md`；`package.json`、CI workflow                                                    | existing；format、lint、typecheck、unit、build   |

## Proposed tests：建议补充但尚未作为现有证据

| 用例                  | 规则与预期（含拒绝）                                                         | 证据来源                                  | 测试类型/状态                           |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| 真实扩展重载          | 在目标 Chromium 加载 `dist`，验证 Dock/工作台/权限拒绝；拒绝不得产生 session | `flows.md`、`permissions.md`              | guarded live；proposed                  |
| file URL 授权撤销     | 用户拒绝或撤销 file URL 后显示引导且不读文件                                 | `flows.md`、`permissions.md`              | guarded live；proposed                  |
| HTTP origin 复用/清理 | 用户拒绝 optional host 或注入失败时不留孤立 tab；成功复用同 URL tab          | `flows.md`；`background/index.ts`         | integration + guarded live；proposed    |
| PNG 失败恢复          | captureVisibleTab/拼接失败也恢复滚动、Dock、选框和参考线                     | `flows.md`、`architecture.md`             | automated integration；proposed         |
| 外部资源泄漏审计      | 导出只读取可访问资源，不向非用户请求的服务器上传；缺资源不伪成功             | `variables.md`、`offline-html-export.ts`  | manual review + network guard；proposed |
| 发布包边界            | release zip 不包含旧版、原型、Cairn、日志或秘密                              | `public-scope.md`、`release-checklist.md` | automated artifact check；proposed      |

## Gaps：目前没有足够验证

| 缺口                                      | 暴露的边界                                             | 当前状态与优先级                   |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| 真实用户浏览器验收证据                    | 可能存在 Chromium 版本差异、权限提示差异或扩展重载问题 | none；Alpha 发布前高               |
| 文件/站点权限拒绝后的所有清理路径         | 可能留下孤立 tab 或误以为修改成功                      | none；Alpha 发布前高               |
| 跨域资源、iframe、Shadow DOM、复杂 Canvas | 可能生成缺资源导出或误编辑                             | none；明确作为不承诺能力，发布前中 |
| 依赖/素材许可证自动审计                   | 可能带入未授权字体、图标或依赖                         | none；Alpha 发布前高               |
| 剪贴板与页面文本的本地暴露                | 可能把敏感页面内容留在用户剪贴板                       | none；发布说明和手工审查，中       |

## CI 与发布门槛

公开聚合命令 `pnpm verify:public` 依次执行 `format:check:public`、`lint`、`typecheck`、`test`、`build:dock`、`test:dock:e2e`、`test:dock:workspace`。`.github/workflows/ci.yml` 保持每个步骤可读并在 PR/main 上执行；任何必需步骤失败都阻止合并。发布前必须在干净依赖环境运行同一门槛，并补齐上表中的真实浏览器、许可证和 artifact 检查。构建或 CI 通过不得单独升级为“已验收”。
