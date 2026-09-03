# 科研阅读工作台

一个本地优先的科研论文阅读工作台。它把连续 PDF 阅读、标注、Markdown 笔记、论文卡片和带原文引用的 AI 对话放在同一个界面中，论文与工作数据默认保存在浏览器本地。

![桌面端 Markdown 笔记预览](docs/screenshots/notes-preview.png)

## 功能

- 连续 PDF 阅读：适宽、缩放、页码跳转、小手拖拽、阅读位置恢复。
- 低占用渲染：只保留视口附近页面，取消过期任务，离屏释放 PDF 与笔迹画布。
- 阅读标注：画笔、橡皮擦、文本高亮、撤销、原文定位和区域截图提问。
- Markdown 笔记：编辑/预览、标题、列表、任务项、引用、表格、代码块和安全链接。
- AI 辅助：流式回答、思考过程、原文引用锚点、论文全文理解和结构化卡片。
- 本地工作区：待读/阅读中/已完成状态，等级或自定义分类，拖拽排序。
- 离线 PDF 资源：PDF.js、CMap、字体、WASM、Markdown 解析与清洗依赖全部随项目提供。

| 实时模型反馈 | 窄屏笔记 |
| --- | --- |
| ![实时模型输出](docs/screenshots/streaming-live.png) | ![窄屏 Markdown 笔记](docs/screenshots/notes-mobile.png) |

## 快速开始

需要 Windows 10/11、现代 Chromium 内核浏览器，以及 Python 3.9 或更高版本。应用没有 npm 安装或编译步骤。

1. 下载或克隆仓库。
2. 双击 `启动工作台.bat`。
3. 浏览器打开 `http://localhost:8642/` 后导入 PDF。

也可在 PowerShell、CMD 或终端中运行：

```bash
python tools/serve.py
```

请始终通过上述 HTTP 地址访问。直接双击 `index.html` 无法启动新版 PDF worker。端口 8642 已被占用时，启动器会提示使用现有页面或先关闭占用端口的程序。

### 保留本地数据

IndexedDB 和 localStorage 按站点来源隔离。请保持使用 `http://localhost:8642/`；改成 `127.0.0.1`、更换端口或清除站点数据后，浏览器会显示另一份空数据。

模型 API Key 仅写入当前浏览器的 localStorage，并直接发送给你配置的模型网关。仓库不含 Key，也没有应用后端。请只配置可信的 HTTPS 网关，不要在共享浏览器配置中保存个人密钥。

## 使用提示

- 点击工具栏小手后按住左键，可横向和纵向拖动放大的 PDF。
- 笔记页顶部可切换“编辑 / 预览”；`[P12|原文片段]` 会渲染为可点击的 PDF 引用。
- AI 生成时会显示“读取论文 / 等待模型 / 思考中 / 正在输出”。停止后保留已收到的内容。
- 模型只有返回 `reasoning_content` 时才会显示思考过程；不支持 SSE 的兼容接口会在完整响应返回后一次显示。
- 为避免远程 Markdown 图片追踪浏览行为，图片语法会渲染成需要主动点击的链接。

## 项目结构

```text
.
├─ index.html              # 页面骨架与资源入口
├─ css/style.css           # 桌面、窄屏和打印外观
├─ js/
│  ├─ state.js             # 工作区、论文和串行导航
│  ├─ reader.js            # PDF 渲染、手势和标注
│  ├─ ai.js                # AI 对话、卡片和笔记
│  ├─ markdown.js          # Markdown 解析后的安全清洗
│  ├─ db.js                # IndexedDB 与模型配置
│  └─ recovery.js          # 页面关闭时的编辑恢复日志
├─ tools/serve.py          # loopback 静态服务器
└─ vendor/                 # 固定版本的本地运行依赖
```

这是无框架的浏览器应用。脚本按 `index.html` 中的顺序加载，通过 `App`、`Reader`、`AI`、`Notes`、`DB` 等全局对象协作。

## 发布前验证

```bash
python tools/check.py
```

该命令检查自有 JavaScript 语法、Python 工具、HTML 本地资源引用、固定版本依赖和禁止提交的个人绝对路径。

重要修改还应在隔离的浏览器 origin 中手动验证：PDF 缩放与拖动、跨文献保存、Markdown 安全过滤、SSE 流式输出、320–1920px 布局。历史审计和本地回归产物不进入发布仓库。

## 隐私与安全

- PDF、标注、笔记、卡片和聊天记录保存在浏览器 IndexedDB。
- 关闭前的未提交编辑使用同源 localStorage 恢复日志保护。
- PDF.js 禁用动态求值和 XFA，并对画布、截图、渲染并发及可见页数量设置预算。
- 模型 Markdown 先由 Marked 解析，再经 DOMPurify 白名单清洗；危险标签、事件属性和 URL 协议不会插入页面。
- 删除站点数据会永久删除应用内容。重要资料请保留原 PDF，并自行备份浏览器数据。

发现安全问题时，请参阅 [SECURITY.md](SECURITY.md)。

## 许可证

项目自有代码采用 [MIT License](LICENSE)，欢迎学习、使用与贡献。提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。PDF.js、DOMPurify 和 Marked 使用各自的开源许可证，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 及各 `vendor/*/LICENSE`。
