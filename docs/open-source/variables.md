# 配置、变量与数据

## 当前配置与秘密面

当前正式扩展没有服务端环境变量、账号密钥、数据库连接、项目自有 API 或第三方 provider。构建配置位于根 `package.json`、各 workspace `package.json` 和 `apps/dock-extension/vite.config.ts`；公开仓库不包含本地过程配置或凭证。

| 名称/数据                  | 使用方                       | 范围                        | 来源                                       | 轮换/清理                         | 风险                                |
| -------------------------- | ---------------------------- | --------------------------- | ------------------------------------------ | --------------------------------- | ----------------------------------- |
| `NODE_ENV`/Vite mode       | 构建脚本、Vite               | 构建端                      | 命令行/脚本                                | 每次构建确认，不注入秘密          | mode 误用可能打包错误入口           |
| `packageManager`、依赖版本 | pnpm/CI                      | 构建端                      | 根 `package.json`/lockfile                 | 依赖升级时评审 lockfile           | supply-chain、许可证和可重复性      |
| MV3 manifest 权限          | Chrome 扩展                  | 客户端声明                  | `apps/dock-extension/public/manifest.json` | 权限变化随版本审查                | 过宽权限可能暴露页面                |
| optional host origin       | background/workspace         | 当前用户授权的浏览器 origin | 用户输入 URL + `permissions.request`       | 用户可在浏览器设置撤销            | 误解为默认全站访问                  |
| `sessionId` 与修改记录     | background/content/workspace | 当前浏览器会话              | 本地运行时                                 | tab/session 结束或清理时移除      | 页面内容留在本地 profile            |
| `localStorage` 画布设置    | workspace                    | 当前扩展页面                | 浏览器本地存储                             | 用户清理浏览器数据                | 视口偏好不是敏感授权                |
| AI 提示词                  | workspace/content            | 用户剪贴板                  | 本地生成 + 用户点击                        | 用户自行清空/覆盖                 | 可能包含页面文本，不能误称上传      |
| HTML/PNG 导出数据          | content/background/workspace | 浏览器内存 + 用户选择的文件 | 用户主动导出                               | 导出后由用户管理                  | 资源失败、文件误保存或覆盖          |
| GitHub `GITHUB_TOKEN`      | release workflow             | CI job，仅 tag 运行         | GitHub Actions 自动注入                    | GitHub 平台短期 token，不写入代码 | 仅给 release 所需 `contents: write` |

## 客户端秘密确认

没有任何客户端秘密。构建产物不得包含 token、私钥、账号密码、真实业务数据或需要保密的服务器地址；浏览器权限和用户输入的 URL 不是秘密，但仍属于需要明确说明的高风险输入。AI 交接不调用 LLM，因此没有模型 key 或 tool credential。

## 轮换与发布前检查

- 不提交 `.env`、私钥、Token、真实业务数据或未脱敏截图；发现泄漏时立即撤销/轮换受影响凭证并审查历史。
- `GITHUB_TOKEN` 只由 GitHub Actions 使用，不复制到构建产物；发布工作流只授予 `contents: write`，其他 job 保持只读。
- 不把浏览器权限扩展成默认全站权限；新增 host、外部请求或下载能力必须先更新 `permissions.md`、`flows.md` 和测试。
- 构建前检查 `git diff`、zip 内容和日志，确认没有把本地过程、旧版目录或秘密带入公开产物。
