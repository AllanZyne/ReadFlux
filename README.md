# ReadFlux

ReadFlux 是一个纯前端、local-first 的 Miniflux 客户端。它把 Miniflux
作为订阅与文章数据源，在浏览器中记录真实阅读行为，并将全部未读文章按本地
兴趣画像排序成「今天」。

## 功能

- NetNewsWire 风格的三栏阅读界面
- 「今天」包含全部未读文章，并按本地推荐结果排序
- 已收藏、订阅分组、Feed 图标和未读数
- IndexedDB 文章缓存、缓存优先启动和定时增量同步
- 首次同步优先加载未读，其次加载全量收藏，最后加载已读，并显示分页进度
- 默认加载最近 30 天的普通文章，可在首次连接或设置中调整；收藏不受时间范围限制
- 稳定的未读列表快照：阅读时文章不会从当前列表中突然消失
- 白天 / 夜晚主题
- 键盘连续阅读、可调整栏宽、移动端单面板导航
- 阅读事件、订阅源偏好和关键词偏好的检查、编辑与删除
- 可选的 AES-256-GCM 加密 WebDAV 同步

## 隐私与安全

ReadFlux 没有应用服务器：

- Miniflux 地址和 API Key 只保存在当前浏览器的 `localStorage` 或
  `sessionStorage`。
- 阅读事件与推荐设置保存在 IndexedDB。
- 浏览器直接请求你的 Miniflux 与可选的 WebDAV 服务。
- 仓库和构建产物不包含任何凭据。

在共享电脑上建议不要勾选「记住在此设备」。请为 ReadFlux 创建独立的
Miniflux API Key，以便随时单独吊销。

## 运行要求

- Node.js 20 或更高版本
- 可通过 HTTPS 访问的 Miniflux
- Miniflux 或其反向代理允许 ReadFlux 所在 origin 进行跨域 API 请求
- 跨域规则需要允许 `X-Auth-Token`、`Content-Type`，以及 ReadFlux 使用的
  `GET`、`PUT`、`OPTIONS` 方法

Miniflux 推荐使用每个应用独立的 API Key；ReadFlux 通过
`X-Auth-Token` 请求 API。

## 本地开发

```bash
npm install
npm run dev
```

打开终端显示的本地地址，然后输入 Miniflux 地址和专用 API Key。

提交代码前运行：

```bash
npm run lint
npm test
npm run build
```

## 部署到 GitHub Pages

仓库已包含 `.github/workflows/deploy-pages.yml`。推送到 `main` 后，工作流会：

1. 安装依赖；
2. 执行 lint、测试和生产构建；
3. 将 `dist/` 部署到 GitHub Pages。

首次使用时，在仓库的 **Settings → Pages → Build and deployment** 中将
Source 设为 **GitHub Actions**。默认地址为：

```text
https://allanzayne.github.io/readflux/
```

如果 fork 后修改了仓库名，请同步修改 `vite.config.ts` 中 GitHub Pages 的
base path。

## 推荐数据

ReadFlux 会记录文章、订阅源、标题、关键词、打开时间、前台停留时间、滚动
深度、进入路径，以及用户明确给出的「有帮助 / 不感兴趣」反馈。收藏状态由
Miniflux 管理。

推荐画像对较新的行为给予更高权重，并综合：

- 订阅源亲和度
- 标题与正文摘要中的兴趣关键词
- 发布时间
- 收藏
- 负向关键词

推荐分数只用于「今天」的排序，不在文章列表中展示。设置对话框的「推荐数据」
Tab 可查看派生权重与原始事件，并支持新增、编辑和删除。

## 技术栈

- React
- TypeScript
- Vite
- Miniflux REST API
- IndexedDB、Web Crypto API

## License

[MIT](LICENSE)
