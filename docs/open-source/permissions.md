# 权限矩阵

## 角色、声明与范围来源

点睛没有账号角色、JWT claim、服务端数据库或 RLS。唯一角色是用户本人（浏览器扩展操作者）；范围由浏览器 manifest 权限、当前 tab、用户主动授予的 host origin 和当前 `sessionId` 共同决定。service worker 从 `chrome.permissions`/标签页状态和 session storage 取范围，不从客户端可编辑文本中接受授权声明。

## 资源 × 操作 × 角色

| 资源/操作                          | 用户主动操作                                 | 后台 service worker            | 未授权/其他网页消息                |
| ---------------------------------- | -------------------------------------------- | ------------------------------ | ---------------------------------- |
| 当前 tab 读取/注入 Dock            | 允许，需 `activeTab`/`scripting`，仅当前 tab | 可按 action 触发检查/注入      | 拒绝，不后台扫描                   |
| 普通 HTTP(S) source tab            | 允许，先由用户授予对应 optional host origin  | 可创建/复用 tab 并转发已知命令 | 拒绝，不使用默认全站授权           |
| 浏览器内部页/扩展商店              | 不允许                                       | 识别后拒绝                     | 拒绝并说明原因                     |
| file URL 本地 HTML                 | 用户选择文件并按浏览器设置授权               | 可打开扩展本地预览             | 未授权时显示设置引导               |
| 当前 session 的修改/历史           | 允许，必须选择稳定对象                       | 仅转发当前 `sessionId` 命令    | session 缺失、过期或命令未知时拒绝 |
| HTML/PNG 导出                      | 用户点击后允许读取可访问资源、截图并保存     | 调用截图/标签页 API            | 非用户触发时不执行导出             |
| AI 提示词剪贴板                    | 用户点击后允许写入剪贴板                     | 不执行 Agent/LLM               | 无记录或剪贴板拒绝时不声称成功     |
| 原网站源码、云端数据库、服务器 API | 不提供                                       | 不提供                         | 不是产品能力                       |

## Manifest 权限

| 权限                                    | 代码位置                                   | 用途和限制                                     |
| --------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `activeTab`                             | `public/manifest.json`、background/content | 用户点击后访问当前标签页，不作为后台全站扫描   |
| `scripting`                             | `background/index.ts`                      | 用户启动编辑时注入 content.js                  |
| `storage`                               | `background/index.ts`、workspace           | 保存浏览器本地 session/视口设置，不上传        |
| `permissions`                           | background/workspace                       | 请求用户选择的站点或 file URL 授权             |
| `http://*/*`, `https://*/*`（optional） | `public/manifest.json`                     | 仅在用户输入 URL 后请求对应 origin，拒绝即停止 |

## 拒绝规则与变更要求

浏览器内部页面、扩展商店、未获授权的本地文件、不稳定定位、无效 session 和未知消息都必须不可编辑并给出可理解的原因。任何新增权限、源码回写、云端同步或 Agent 工具调用，都必须先更新本文件、`flows.md`、`variables.md` 和测试映射并经过安全审查。
