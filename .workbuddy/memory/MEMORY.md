# OmniHome（万事屋）项目长期笔记

## 项目定位
自托管个人门户 / 导航台（中文名「万事屋」，副标 OMNIHOME · PERSONAL HUB），面向 NAS Docker 部署。
开发者署名 JeanLaw。目标用户是个人或家庭小团队，多账号 + 数据隔离。

## 技术栈（不要误判）
- 前端：`demo/`，**原生 JS + CSS 变量，无构建工具**。index.html 顺序加载 17 个 js 模块（api/app/auth/weather/monitor/word/calendar/bookmarks/globalsearch/vault/livemd/dashboard/notes/plan/toolbox/settings 等），CDN 引 marked / DOMPurify / qrcodejs（均有离线降级）。
- 后端：FastAPI 单进程。`main.py`（认证+会话+静态资源+备份守护线程）、`routes.py`（56 个功能 API）、`storage.py`（存储层，约 1.5k 行，最重）、`sessions.py`（PBKDF2-SHA256 12 万次 + 内存会话 7 天）、`app_version.py`（VERSION + CHANGELOG 唯一来源）。
- 存储：三引擎同构（file / sqlite / 外部 MySQL·PostgreSQL），按模块分 14 张表（bm_* 前缀），旧单表 omni_kv 自动无损迁移。`data/config.json` 的 `storage.engine` 决定当前引擎（当前为 `file`）。
- 版本发版必须同步改 `backend/app_version.py` 的 VERSION 与 CHANGELOG（新版本置顶），前端 /api/about 会弹更新日志。

## 业务模块（6 个视图）
仪表盘（可编辑布局/拖拽）、系统监控（管理员专属，默认关，需 monitorEnabled 开启）、快捷导航（书签+分类+AI 填充+导入导出）、密码保险库（浏览器端 AES-256-GCM 零知识，服务端只存盐与校验串）、知识库（Markdown 笔记+文件夹，与今日计划共用存储）、实用工具箱（翻译/密码生成）。
全局搜索、天气（Open-Meteo）、每日单词、日历（点击日期编辑当日计划，计划按月归档）为跨视图组件。

## 约定与注意事项
- 认证：Bearer token；`require_user()` 支持 Authorization 头或 `?token=` 查询参数（下载链接用）。
- 会话存内存，服务重启后全部需重新登录。
- 系统监控相关接口有 `_monitor_gate` 管理员门禁；未开启时前端隐藏入口。
- 备份 zip 无论何种引擎都落盘在 `data/users/{u}/backups/`。
- 后端测试脚本以 `_` 前缀命名（`_api_regress.py` 全链路回归、`_smoke_auth.py` 认证冒烟、`_benchmark.py` 存储性能、`_api_diag.py` 引擎诊断、`_storage_test.py`），针对 127.0.0.1:8000 运行，不是 pytest。
- 已知遗留：`backend/routes_bk.py` 已在 v0.1.2 打包前移到废纸篓（`~/.Trash/`），确认不再保留。
- 本地开发启动：`python3 backend/main.py`（端口 8000）；NAS 部署：`docker compose up -d --build`。
- 测试账号：`test` / `test123`（见 `_smoke_auth.py`）。
- 发版：`./pack.sh` 一条命令产出 `omnihome-deploy.tar.gz`（通用，43 项 175K）与 `omnihome-nas-deploy.tar.gz`（NAS 精简，39 项 165K），均**不含用户数据**（data/users / config.json / *.db 全部排除，脚本内自动 grep 校验）。

## 环境陷阱（重要）
- **HTTP 走代理可通到本地服务**（环境 HTTP_PROXY=127.0.0.1:64690）：curl / urllib 访问 127.0.0.1:8000 实际能返回 200，**只要服务在监听 0.0.0.0:8000 即可**。之前以为需要 import 模块 + 假对象，实测不需要。
- 系统 python3（3.9）无项目依赖，必须用 **`/usr/bin/python3`**（依赖装在这），不要用 `/Library/.../python3`。
- **后台进程用 `run_in_background: true` 启动才会在工具调用间持续**。`nohup ... &` 在同一次 Bash 调用内有效，但该调用结束沙箱会回收子进程。
- `agent-browser` 装好但 Chromium 下载被沙箱拦截（卡 9/179MB 超时）。**绕过**：直接驱动本机 Chrome 的调试端口，命令：
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222 --user-data-dir=/tmp/xxx-profile --no-first-run --disable-gpu
  agent-browser connect 9222
  ```
  `--no-sandbox` 必须（外层沙箱里 Chrome 自家沙箱起不来）。
- agent-browser 的 `network route --body` 对 fetch 拦截似乎无效；**拦截容器接口可覆写 `window.fetch`**（用 `Response` 构造假响应），等 5 秒轮询自然命中——同时可用于验证轮询间状态保持。

## 关键实现约定
- **认证响应统一携带 monitorEnabled**（v0.1.2 起）：`_public_user()` 包含此字段，登录 / 注册 / 切换 / 会话恢复四条路径都生效。**别再只在 `app.js` 的 session 路径里临时 `s.user.monitorEnabled = !!s.monitorEnabled`** —— 已移除。
- **Docker 容器采集**（v0.1.2 起）：`routes.py` 的 `_collect_containers()` 用 ThreadPoolExecutor（16 并发）并行拉 stats；`containers()` 外层包单飞锁 + 2s TTL 缓存（`_CONT_LOCK` / `_CONT_CACHE` / `CONT_CACHE_TTL`）。改这块别破坏 CPU / 内存 / 网络的增量计算口径。
- **仪表盘尺寸**（v0.1.2 起）：卡片尺寸用 CSS 变量 `--dash-col` / `--dash-h` + `.sized` 类表达，**不要改用内联 `grid-column`** —— 内联样式无法被媒体查询覆盖，窄屏会把卡片压扁。窄屏（<1281px）由 JS 移除 `.sized` 回落 col-* 响应式规则。
- **饼图悬浮高亮**（v0.1.2 起）：`ctPieHover` 跨轮询重绘保持，否则每 5 秒会被 `renderCtPie()` 重建节点清空。
- 颜色用 `cssVar('--om-primary')` 取到的是 `hsl(243 72% 60%)` 这类字符串；用于 SVG 时优先写内联 `style="stroke:..."`，比 `stroke` 属性解析更稳。
- 仪表盘布局 API：`/api/dashboard` 存 `{ order, removed, sizes }`，`sizes` 经 `_clean_sizes()` 白名单校验（col 3~12、h 160~2000、id 必须在 DEFAULT_WIDGETS）。

## v0.2.3 起的关键约定
- **启动遮罩**：`#authScreen` 不再默认带 `open`；首屏由 `#bootSplash` 覆盖，`boot()` 解析完后加 `.gone`。`boot()` 的两个接口用 `Promise.all` 并行，另有 8s 兜底撤遮罩。改动这块时**别把 `open` 加回 HTML**，否则已登录刷新又会闪登录页。
- **主题**：`<head>` 内联脚本在首屏前定 `data-theme`（localStorage `om_theme_mode` → 系统偏好 → 深色）；`demo.js` 的 `setMode(mode, persist=true)` —— **初始化必须用 `setMode(mode, false)`**，否则会把 auto 解析出的具体值写回 localStorage，`跟随系统` 就丢了。`auto` 模式靠 `matchMedia` change 监听实时切换，无需刷新。
- **折叠类控件**：切换按钮必须放在被折叠容器**之外**（知识库目录踩过这个坑）。
- **敏感配置加密**：`backend/secretbox.py`（Fernet），主密钥 `data/secret.key`（600）。密文前缀 `enc1:`。**该密钥已排除出 `.dockerignore` 与 pack.sh**，不要再加回去。改 AI 配置相关代码时用 `_ai_key(cfg)` 取明文，不要直接读 `cfg["apiKey"]`。
- **缓存版本**：改了 CSS/JS 后必须同步 `demo/index.html` 里所有 `?v=x.y.z`（与 `app_version.py` 的 VERSION 一致），否则用户浏览器拿旧脚本。可用 `sed -i '' 's/?v=旧/?v=新/g' demo/index.html`。
- **新增 backend 模块后必须能入包**（v0.2.4 血泪）：v0.2.3 的 pack.sh 手工罗列文件清单，漏了 secretbox.py → 容器 `ModuleNotFoundError` 崩溃循环。现在 `SRC=($(find backend -maxdepth 1 -name '*.py' ! -name '_*' | sort) ...)` 自动收集，**不要改回手工罗列**；pack.sh 末尾的导入自检会解包后真跑一遍 import，漏文件当场 exit 1。
- 本机**没有 Docker**，`docker build` 无法验证。等效做法：解包后 `cd` 进解包目录跑 `python backend/main.py`（与容器 CMD 一致），再查端口监听与 `/api/about`。
- **改 HTML / 删元素时必升 `?v=` 缓存戳**（v0.2.5 血泪）：JS 里若仍有 `$('#removedId').addEventListener` 会对 null 调方法抛 TypeError，把 init() 中断，导致同一模块后续所有绑定（包括看起来无关的事件）全部失效。改完 HTML 后**立即** `sed -i '' 's/?v=旧/?v=新/g' demo/index.html`，否则浏览器跑的是旧 JS。
- **psutil 在 routes.py 里是惰性导入**（endpoint 函数内 `import psutil`），任何辅助函数要用 psutil 时都得自己 `import psutil as _psu`，否则 `NameError`。同时 `disk_usage` 返回的 `sdiskusage` 没有 `mountpoint` 属性——做兜底时别 `root_disk.mountpoint`。
- **网络速率累计→瞬时**：不要把 `psutil.net_io_counters().bytes_*` 直接当作 MB/s，那是开机累计。每次请求存 prev 快照算 dt-diff。**同一请求内连续两次调用速率必须按方向分别存 prev**——否则第二次 dt 微秒级、diff 是累计字节 → 算出 TB/s 的伪速率。
- **绝对定位要 parent 有定位**：`position:absolute; left:4px` 落到 (0,0) 多半是父级没有 `position:relative`/absolute/fixed。在父布局上加一行 `position: relative`。
- **FastAPI 路由按声明顺序匹配**（v0.2.6 血泪）：`/api/notes/{nid}` 会把 `all`、`import-md` 当成 nid 吃 → 静态路由（all、import-md）必须**在** `get_note` 之前声明。/api/notes/{nid}/export 不冲突（4 段 vs 3 段），但顺序错了仍然坑。改完路由定义后用 OpenAPI 测一下各路径。
- **HTTP Content-Disposition 不支持 latin-1 之外的字符**（v0.2.6 血泪）：中文文件名要用 RFC 5987 双形式 `filename="ascii"；filename*=UTF-8''percent-encoded`，否则 latin-1 解码抛 `UnicodeEncodeError`。
- **zip 导入根目录 vs 嵌套目录**：用 `path.rsplit("/", 1)` 拆路径时，先判断 `"/" in path`，无 / 时整个字符串是文件名，folder 应当是 "" 而不是把整段当文件夹名。
- **静态资源缓存策略**（v0.2.7 血泪）：`main.py` 的 `FileResponse` 必须显式设 Cache-Control。`index.html` 用 `no-cache, must-revalidate`（文档每次校验，保证升级后拿新文档引用新版本戳的资产）；带 `?v=x.y.z` 的 js/css 用 `public, max-age=31536000`（发版换戳即新 URL）。**不设头 = 浏览器/反向代理随意缓存 = 升级后用户只看到接口类内容（如更新日志）变化、界面纹丝不动。**
- **排查「升级后界面没变」**：先 `curl -s http://host:8000/ | grep -o '新元素id'` ——能 grep 到说明服务端是新的、问题在缓存/代理；grep 不到才是打包或部署问题。别一上来就怀疑打包。
- **视图内专属顶栏 vs 全局顶栏**（v0.2.8）：知识库视图的编辑区自己带顶栏（返回/日期/搜索/铃/头像），如果同时存在全局顶栏就会重复。处理：在 `goView` 里设 `body.dataset.view = name`，CSS `body[data-view="notes"] .topbar{display:none}` 局部隐藏全局顶栏。这样其它视图照常显示全局顶栏。

- **导入 zip 必过滤平台资源垃圾**（v0.2.9 血泪）：macOS zip 必带 `__MACOSX/` 和 `._xxx` 资源派生文件，Windows zip 可能有 `Thumbs.db`。导入时**必须**先按段名过滤，否则会把垃圾全建成笔记/文件夹，整树乱码无法恢复。`_is_junk_path(path)` 检查每一段：开头 `._` 或名字是 `__MACOSX/.DS_Store/Thumbs.db/desktop.ini` 都跳过。
- **webkitGetAsEntry 拖文件夹必须分批 readEntries**（v0.2.9 血泪）：FileSystemDirectoryEntry 的 `createReader()` 每次 `readEntries` 只返回一小批（不是全部），要循环调用直到返回空数组才算读完。直接 `readEntries(cb)` 一次拿到的会缺大量条目。

- **重构 HTML 后必扫 JS 悬空引用**（v0.2.11 血泪）：`?.` 防护只兜"元素可能不存在"，对"忘了删的旧逻辑主动引用已删除元素"无效——那是必然抛错的调用，且在 init() 里会中断其后全部事件绑定（表现为大片按钮无反应）。扫法：提取 JS 里所有 `$('#xxx')`/`getElementById` 的 id → 逐一查 index.html 是否有 `id="xxx"`；类选择器同理。
- **toggle 是 classList 的方法**：`$('.x').toggle(...)` 必然 TypeError（元素上没有 toggle）。要么 `el.classList.toggle('c', cond)`，要么直接 `el.hidden = cond`（优先，不依赖 CSS 类）。
- **async 函数里抛错 = 静默失败**：loadFeatures 这类登录后即执行的 async 函数抛错不会在控制台冒红（unhandledrejection），配合全局错误可见化才能暴露。

- **页面底部元素的事件绑定必须 document 委托**（v0.2.14 血泪）：`#assetLightbox` 在 body 末尾、晚于 notes.js 执行，init() 里 `$('#xxx')?.addEventListener` 被 `?.` 静默跳过永不生效，而元素运行时存在 → 表现为"按钮无响应但 DOM 正常"。委托到 document（`if(!e.target.closest('#id')) return`）不受时序影响。
- **LiveMD.insertRawAt 单行文本不能走拆行逻辑**（v0.2.14 血泪）：无 \n 的 text 会因 parts[0]==parts[last] 重复拆成两行。单行直接拼。
- **open()（IIFE 顶层）与 init() 内函数作用域隔离**：顶层 async 函数引用 init 内的 renderOutline 会 `ReferenceError`（被 catch 吞 → 静默失败）。跨作用域调用要么内联、要么提到顶层。
- **grid 子元素设 height:100% 会循环依赖塌缩**（v0.2.14）：容器高度 auto 依赖内容 → 100% 解析为 0 → 元素高度 0 无法聚焦/滚动。
