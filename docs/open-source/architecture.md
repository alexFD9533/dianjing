# 架构与信任边界

## 产品概览与关键假设

点睛是一个 Manifest V3 浏览器扩展。用户在当前网页或本地 HTML 上选择稳定 DOM 对象，扩展在页面内执行可撤销的文字、样式、间距和布局调整；完整工作台提供多对象操作、历史、离线 HTML 和整页 PNG 导出。AI 交接只生成提示词并复制到剪贴板，不在扩展内运行 Agent。

关键假设是：用户主动发起编辑，浏览器负责站点/标签页权限，页面 DOM 和外部资源均不可信，交付语义是当前渲染页面副本而不是源码回写。代码中的入口策略见 `apps/dock-extension/src/background/entry-policy.ts`，会话和消息边界见 `apps/dock-extension/src/background/index.ts` 与 `src/shared/workspace-protocol.ts`。

## 技术栈与主要组件

| 组件                          | 技术/责任                                                       |
| ----------------------------- | --------------------------------------------------------------- |
| 扩展运行时                    | Chrome/Chromium Manifest V3、TypeScript、Vite                   |
| UI                            | 页面内内容脚本 Dock；`src/workspace` 的完整工作台；原生 DOM/CSS |
| `src/background`              | MV3 service worker、标签页/权限流程、会话消息、PNG 分段截图拼接 |
| `src/content`                 | 页面对象识别、修改、历史、Dock 交互和 HTML 资源读取             |
| `src/shared`                  | 会话协议、本地 HTML、选择、AI 提示词和对象模型                  |
| `packages/contracts`          | 修改协议和输入校验                                              |
| `packages/selector-engine`    | 稳定 DOM 目标定位                                               |
| `scripts/validate-dock-*.mjs` | 构建后 Dock、MV3 入口、样式和工作台回归                         |

## 认证、会话与声明流

点睛没有账号、登录、服务端 token、数据库或角色声明。权限声明来自浏览器 manifest：`activeTab`、`scripting`、`storage`、`permissions`，普通 HTTP(S) 站点使用用户主动授予的可选 host permission（见 `apps/dock-extension/public/manifest.json`）。

用户点击扩展或在工作台提交 URL 后，前端请求浏览器权限；service worker 检查权限和 URL/入口策略，通过后创建或复用 source tab 与 workspace tab，并用随机/会话级 `sessionId` 在 `chrome.storage.session` 保存当前会话。后续消息必须带已存在的会话标识和已知命令，无法取到会话、权限被拒或页面不支持时拒绝并返回原因。所有会话数据留在浏览器，不发送到项目服务器。

## 数据流与信任边界

1. 用户 UI → 扩展 API：用户动作触发 `permissions.request`、脚本注入、标签页操作或截图；浏览器拒绝即停止，不能以静默权限替代。
2. 页面 DOM → 内容脚本：目标页面、HTML、样式、图片和字体是外部输入；选择器、修改协议和资源 URL 必须校验，定位不稳定时拒绝写入。
3. 内容脚本 ↔ service worker：消息携带页面会话和操作结果；只接受已知命令、当前 session 和预期 tab，不能把任意消息当作授权。
4. 工作台/本地预览 → 浏览器本地存储：只保存会话、修改记录和视口设置，不调用服务器数据库。
5. 页面资源 → 本地导出：HTML 导出按用户动作读取浏览器可访问资源；失败项必须反馈，扩展不把资源上传到项目服务器。
6. 页面 → 浏览器截图 API → 本地内存/下载：整页 PNG 临时隐藏 Dock/选框/参考线，分段截图后拼接并恢复滚动位置；由用户选择保存位置。
7. 修改记录 → 剪贴板：AI 交接提示词由扩展本地生成，用户主动点击复制；剪贴板内容由用户决定是否交给外部工具，扩展不执行外部 Agent。

## 已知风险与假设

- **动态 DOM 失配**：页面动态更新会使稳定定位失效；`selector-engine` 和内容脚本必须拒绝不确定目标，否则可能误改相邻对象。
- **权限语义误读**：`optional_host_permissions` 覆盖普通 HTTP(S) 页面，但代码必须先由用户请求并说明“网页副本”；入口策略和 `entry-policy.test.ts` 是当前证据，不能宣传为后台全站扫描。
- **资源与跨容器边界**：跨域 iframe、Shadow DOM、复杂 Canvas 和无法读取的资源无法保证完整编辑/导出；`offline-html-export.ts` 的失败路径必须保持可见。
- **本地数据暴露**：会话和提示词可能包含用户页面内容，当前假设浏览器本地 profile 和用户剪贴板由用户管理；没有云端清除/审计能力。
- **浏览器 API 差异**：不同 Chromium 版本对 `storage.session`、权限提示和截图行为可能不同；真实扩展重载验证不能被静态构建代替。

## 不适用的条件能力

- 无邮件发送：没有 `emails.md`。
- 无定时任务或后台 job：没有 `cron.md`。
- 无公开 SEO/服务端渲染路由：没有 `seo.md`。
- 无内嵌 Agent、LLM tool-calling 或自动化 webhook：没有 `automation.md`。AI 交接只是用户触发的本地提示词复制。

## Related Documents

- [关键流程](flows.md)
- [权限矩阵](permissions.md)
- [配置、变量与数据](variables.md)
- [测试覆盖与发布门槛](tests.md)
- [公开范围清单](public-scope.md)
- [当前产品定义](../product/product-definition.md)
- [Alpha 发布范围](../product/alpha-release.md)
- [仓库工作流](../governance/repository-workflow.md)
- [发布检查清单](../governance/release-checklist.md)
