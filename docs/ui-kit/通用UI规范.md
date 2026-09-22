# 通用界面规范

本文从当前产品的界面实现中抽出一套可整包迁移的视觉与交互规则。令牌前缀为 `--ui-`，组件类名为短横线单词。数值与 `docs/ui-kit/index.html` 中的样式一致：文档里的每一个令牌、类名、状态，演示页都有对应标本。

演示页是单文件静态页，用浏览器直接打开即可，桌面与手机视口都能预览。页面里的 `.sg-*` 只负责规范页自己的排版，不是组件库的一部分。

产品内多端对接（门户、扩展、插件的类名映射）仍以 `docs/UI对接规范.md` 为准。本文不绑定具体产品名、路由或业务模块。

---

## 1. 规范总览

### 1.1 风格

冷灰表面、单一品牌色、弱描边、小幅度反馈。深色是默认主题，浅色是同一套结构的另一组表面色，不是简化版。品牌色只负责行动点、当前项和焦点环；成功、警告、危险、信息四色跨主题不变。

可以换的只有色相。表面灰阶、圆角阶梯、字号阶梯、按钮高度、动效时长在新项目里保持不动，这样不同产品仍是同一套节奏。

### 1.2 原则与使用场景

| 原则 | 规则 | 使用场景 |
|---|---|---|
| 色相换肤 | 品牌色拆成 `--ui-hue` 与 `--ui-sat`，派生色用 `color-mix()` | 用户换主题色、白标产品改品牌色 |
| 明暗正交 | `data-theme` 只改表面、文字、阴影；不改语义色 | 设置里的深色 / 浅色开关 |
| 一个主操作 | 一个视图区域只有一个实心主按钮 | 表单提交、空状态的下一步 |
| 表面分层 | 页面底、卡片、悬停槽、骨架槽四级表面，而不是加粗边框 | 卡片、菜单、表格行悬停 |
| 胶囊状态 | 状态用浅底 + 语义色字 + 圆点，不用大色块告警 | 列表状态、同步结果、在线与否 |
| 反馈克制 | 悬停上移 2px，按下缩放到 0.97，过渡 160ms | 按钮、可点击卡片、用户卡片 |
| 手机同一套导航 | 窄屏用抽屉侧栏，不增加常驻底栏 | 任何带主导航的应用壳 |
| 焦点可见 | 输入与搜索用主色边加浅色光环；按钮不取消浏览器焦点环 | 键盘操作、表单 |
| 危险可逆 | 删除、清空、覆盖先出确认层，确认钮用危险实底 | 不可恢复的操作 |
| 减少动效 | `data-motion="off"` 与系统「减少动态效果」同时生效 | 系统设置、前庭敏感用户 |

### 1.3 不要做的事

- 不要把品牌色写成固定十六进制。改 `--ui-hue`（以及自定义取色时的 `--ui-sat`）。
- 不要用主色表示健康度或负载。负载走成功 / 警告 / 危险。
- 不要为导航再加一套断点。壳只有 768、1024、1280 三档；更窄的断点只用于单个组件折行。
- 不要在手机上做常驻底部标签栏。`--ui-bottom-nav-h` 保持 `0px`。
- 不要用裸 `100vh` 当作手机全屏高度，用 `--ui-app-h`。
- 不要用过大的 `min-height` 把底部状态栏挤出视口。滚动放在中间区域，并给该区域 `min-height: 0`。

---

## 2. 设计变量

令牌挂在 `:root`。深色写在 `:root, [data-theme="dark"]`，浅色写在 `[data-theme="light"]`。紧凑密度用 `html[data-compact="on"]` 覆盖间距、顶栏高度和卡片圆角。

`--ui-bp-phone`（768px）与 `--ui-bp-tablet`（1024px）供脚本和文档读取。`@media` 不能引用自定义属性，断点必须写成字面量 `768px`、`1024px`、`1280px`。

### 2.1 品牌色

使用场景：主按钮、当前导航、焦点环、链接、选中描边。一个界面里品牌色出现在「可操作」和「当前位置」，不铺满大面积背景。

| 令牌 | 默认 | 说明 |
|---|---|---|
| `--ui-hue` | `243` | 色相。换肤只改这一个数 |
| `--ui-sat` | `72%` | 饱和度。自定义取色时一并写入 |
| `--ui-primary` | 深色 `hsl(243 72% 60%)`；浅色 `hsl(243 72% 54%)` | 品牌主色 |
| `--ui-primary-strong` | `hsl(var(--ui-hue) var(--ui-sat) 52%)` | 主按钮悬停、标志渐变终点 |
| `--ui-on-primary` | `#ffffff` | 主色上面的文字和图标 |
| `--ui-primary-soft` | 深色：主色 16% 混入表面；浅色：9% | 选中浅底 |
| `--ui-primary-ghost` | 深色：主色 14% 透明；浅色：11% | 悬停浅底、焦点环 |
| `--ui-primary-border` | 深色：主色 40% 混入边框；浅色：35% | 选中描边 |

内置色板（演示页 `.swatch`）：

| 名称 | hue | sat | 标本 |
|---|---|---|---|
| 靛蓝（默认） | 243 | 72% | `hsl(243 72% 58%)` |
| 青碧 | 190 | 72% | `hsl(190 72% 48%)` |
| 翡翠 | 160 | 70% | `hsl(160 70% 42%)` |
| 琥珀 | 35 | 90% | `hsl(35 90% 52%)` |
| 玫瑰 | 340 | 75% | `hsl(340 75% 55%)` |

自定义取色：把 HEX 转成 HSL，回写 `--ui-hue` 与 `--ui-sat`。

```js
document.documentElement.style.setProperty("--ui-hue", String(hue));
document.documentElement.style.setProperty("--ui-sat", sat + "%");
```

### 2.2 语义色

使用场景：结果、风险、系统状态。两套主题用同一组色值，避免浅色模式下「成功」变成另一种绿。

| 令牌 | 值 | 使用场景 |
|---|---|---|
| `--ui-success` | `#10b981` | 完成、在线、低负载 |
| `--ui-warning` | `#f59e0b` | 进行中、需注意、中负载 |
| `--ui-danger` | `#f43f5e` | 失败、删除、停止、高负载 |
| `--ui-info` | `#38bdf8` | 中性提示、次要指标 |
| `--ui-success-soft` | 该色 15% 混透明 | 成功浅底 |
| `--ui-warning-soft` | 同上 | 警告浅底 |
| `--ui-danger-soft` | 同上 | 危险浅底 |
| `--ui-info-soft` | 同上 | 信息浅底 |

负载着色（进度条 `.bar-fill`、环形仪 `.g-val`）：

| 条件 | 类 | 颜色 |
|---|---|---|
| `< 70%` | `.ok` | 成功 |
| `70%–89%` | `.warn` | 警告 |
| `≥ 90%` | `.bad` | 危险 |

未分级时进度条与环形仪使用主色，表示「这是品牌图形」而不是「健康」。一旦表达负载，必须挂上表中的类。

### 2.3 表面、文字与顶栏

使用场景：页面背景、卡片、菜单、输入框、表格。新的层级优先换表面，而不是新造边框颜色。

深色（默认）：

| 令牌 | 值 | 角色 |
|---|---|---|
| `--ui-bg` | `#0c0f15` | 页面底 |
| `--ui-surface` | `#141824` | 卡片、弹层、抽屉 |
| `--ui-surface-2` | `#1a2030` | 行悬停、分段槽、次级面板 |
| `--ui-surface-3` | `#232b3e` | 骨架、开关关态、进度槽 |
| `--ui-border` | `rgba(255,255,255,.07)` | 弱描边 |
| `--ui-border-strong` | `rgba(255,255,255,.15)` | 输入框、强调分割 |
| `--ui-text-1` | `#edf0f7` | 标题与正文 |
| `--ui-text-2` | `#9aa3b8` | 次要文字、未选导航 |
| `--ui-text-3` | `#5f6880` | 占位、说明、时间 |
| `--ui-topbar-bg` | 背景色 78% 混透明 | 毛玻璃顶栏 |

浅色：

| 令牌 | 值 |
|---|---|
| `--ui-bg` | `#f3f5fa` |
| `--ui-surface` | `#ffffff` |
| `--ui-surface-2` | `#f3f5fb` |
| `--ui-surface-3` | `#e9edf6` |
| `--ui-border` | `#e4e8f1` |
| `--ui-border-strong` | `#d0d7e6` |
| `--ui-text-1` | `#171c2b` |
| `--ui-text-2` | `#5c6579` |
| `--ui-text-3` | `#9aa2b5` |
| `--ui-primary` | `hsl(var(--ui-hue) var(--ui-sat) 54%)` |
| `--ui-primary-soft` | 主色 9% 混入表面 |
| `--ui-primary-ghost` | 主色 11% 透明 |
| `--ui-primary-border` | 主色 35% 混入边框 |
| `--ui-topbar-bg` | 背景色 72% 混透明 |

页面背景可以在底色之上加一道很淡的主色径向渐变，位置 `1200px 500px at 85% -10%`，颜色为 `--ui-primary-ghost`，60% 处透明。桌面（≥769px）`background-attachment: fixed`；手机用 `scroll`，避免地址栏伸缩时背景抖动。

文字工具类：`.text-muted` 使用 `--ui-text-2`，`.text-faint` 使用 `--ui-text-3`。`.num` 使用 `font-variant-numeric: tabular-nums`，用在会跳动的数字上。

### 2.4 阴影

使用场景：静止卡片用小阴影，悬停抬起用中阴影，浮层用大阴影。不要再手写一套黑阴影。

| 令牌 | 深色 | 浅色 | 使用场景 |
|---|---|---|---|
| `--ui-shadow-sm` | `0 1px 2px rgba(0,0,0,.35)` | `0 1px 2px rgba(16,24,40,.05)` | 卡片静止、分段选中 |
| `--ui-shadow-md` | `0 2px 6px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55)` | `0 2px 6px rgba(16,24,40,.05), 0 14px 34px -18px rgba(16,24,40,.16)` | 悬停上浮 |
| `--ui-shadow-lg` | `0 8px 24px rgba(0,0,0,.45), 0 24px 64px -24px rgba(0,0,0,.6)` | `0 8px 24px rgba(16,24,40,.08), 0 28px 64px -28px rgba(16,24,40,.22)` | 菜单、弹层、Toast |

主按钮另有品牌投影：`0 4px 14px -6px var(--ui-primary)`。标志块为 `0 4px 14px -4px var(--ui-primary)`。

### 2.5 圆角

使用场景：控件 10、卡片 18、状态与搜索 999。同一组件不要混用相邻两档以外的圆角。

| 令牌 | 默认 | 紧凑模式 | 使用场景 |
|---|---|---|---|
| `--ui-radius-xs` | 6px | 不变 | 列表行、键盘键、小图标钮的内圆角 |
| `--ui-radius-sm` | 10px | 不变 | 按钮、输入框、导航项 |
| `--ui-radius-md` | 14px | 不变 | 菜单、磁贴、横幅 |
| `--ui-radius-lg` | 18px | 14px | 卡片、弹窗 |
| `--ui-radius-pill` | 999px | 不变 | 搜索、Toast、状态胶囊、开关 |

口诀：控件 10，卡片 18，胶囊全圆。

### 2.6 间距

使用场景：组件内部用 1–3 档，卡片内边距用 4–5 档，页面区块用 5–8 档。只使用这一组，不要出现 5px、7px、15px 这类游离值；下面组件表里写明的固定值（按钮高度、焦点环）除外。

| 令牌 | 默认 | 紧凑 `html[data-compact="on"]` |
|---|---|---|
| `--ui-space-1` | 4px | 3px |
| `--ui-space-2` | 8px | 6px |
| `--ui-space-3` | 12px | 8px |
| `--ui-space-4` | 16px | 10px |
| `--ui-space-5` | 20px | 12px |
| `--ui-space-6` | 24px | 16px |
| `--ui-space-8` | 32px | 20px |

紧凑模式同时把 `--ui-topbar-h` 改为 56px，`--ui-radius-lg` 改为 14px。设置表单、确认框正文不要跟着挤扁，保持 16px 上下的行距。

### 2.7 字体、字号、行高

使用场景：界面字体用系统栈，保证中文与西文都不额外下载。等宽字体只用于代码、密码、快捷键、音标。

```css
--ui-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
           "Segoe UI", Roboto, "Noto Sans SC", "Helvetica Neue", sans-serif;
--ui-font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
```

正文字号 `--ui-fs-md`（14px），行高 `1.55`。手机上的输入框、下拉框、多行输入强制 16px，避免 iOS 聚焦时放大页面。

| 令牌 | 尺寸 | 字重 | 行高 | 使用场景 |
|---|---|---|---|---|
| `--ui-fs-xs` | 12px | 400 / 600 | 1.55 | 辅助说明、日期、卡片副标题 |
| `--ui-fs-sm` | 13px | 600 | 1.5 | 按钮、菜单、次级正文 |
| `--ui-fs-md` | 14px | 400 / 600 | 1.55 | 正文、导航、卡片标题 |
| `--ui-fs-lg` | 16px | 700 | 1.4 | 顶栏标题、弹窗标题 |
| `--ui-fs-xl` | 20px | 800 | 1.3 | 锁屏、空流程的主标题 |
| `--ui-fs-2xl` | 26px | 800 | 1.25 | 页面大标题。字距 `-0.3px`。手机改为 22px |

未单独做成令牌、但需要一起迁移的字号：

| 尺寸 | 字重 | 使用场景 |
|---|---|---|
| 10px | 600 | 眉题、角标。字距约 0.8px |
| 11px | 600 | 分组标题（字距 1.2px、全大写）、状态胶囊、表头（字距 0.5px）、键盘键 |
| 12.5px | 500 | 紧凑列表行 |
| 15px | 700 | 标志名称。字距 0.3px |
| 22px | 700 | 指标数字，行高 1.2；同时是手机页标题 |

字重阶梯：400 正文，500 次级标签，600 按钮与当前项，700 卡片标题与标志，800 页面标题。

其它行高：设置项标题 1.45，长说明 1.65，列表条目 1.7，多行输入与引用 1.8。按钮不设行高，由固定高度垂直居中。

### 2.8 动效

| 令牌 | 值 | 使用场景 |
|---|---|---|
| `--ui-ease` | `cubic-bezier(.4, 0, .2, 1)` | 全部过渡 |
| `--ui-t-fast` | `.16s var(--ui-ease)` | 悬停、边框、按钮 |
| `--ui-t-base` | `.28s var(--ui-ease)` | 主题、侧栏、弹层 |

固定时长（不做成令牌）：

| 时长 | 使用场景 |
|---|---|
| 320ms，上移 8px 后淡入 | 视图切入 |
| 600ms | 进度条宽度 |
| 800ms | 环形仪数值 |
| 1600ms | 骨架微光 |

`html[data-motion="off"]` 以及 `@media (prefers-reduced-motion: reduce)` 把动画和过渡压到 `0.01ms`，并取消悬停的 `translate` 与 `scale`。

### 2.9 尺寸与安全区

| 令牌 | 值 | 使用场景 |
|---|---|---|
| `--ui-sidebar-w` | 250px | 桌面展开侧栏 |
| `--ui-sidebar-w-rail` | 76px | 图标栏 |
| `--ui-topbar-h` | 64px（紧凑 56px） | 顶栏内容区高度，不含安全区 |
| `--ui-bottom-nav-h` | `0px` | 保留变量，不启用底栏 |
| `--ui-safe-top` | `env(safe-area-inset-top, 0px)` | 刘海 |
| `--ui-safe-bottom` | `env(safe-area-inset-bottom, 0px)` | 底部手势条 |
| `--ui-app-h` | `100dvh`，不支持时 `100vh` | 应用壳高度 |
| `--ui-content-max` | 1400px | 主内容最大宽度 |
| `--ui-bp-phone` | 768px | 文档 / 脚本 |
| `--ui-bp-tablet` | 1024px | 文档 / 脚本 |

### 2.10 层级

使用场景：新浮层先对表入座，不要随手写一个更大的整数。确认层必须高于普通弹窗。

| 令牌 | 值 | 使用场景 |
|---|---|---|
| `--ui-z-topbar` | 30 | 顶栏 |
| `--ui-z-overlay` | 35 | 顶栏内展开的搜索 |
| `--ui-z-sidebar` | 40 | 桌面侧栏 |
| `--ui-z-dropdown` | 50 | 搜索建议 |
| `--ui-z-menu` | 60 | 菜单 |
| `--ui-z-popover` | 70 | 气泡、图表提示 |
| `--ui-z-sheet` | 75 | 手机底部面板 |
| `--ui-z-scrim` | 80 | 抽屉遮罩、底部批量条 |
| `--ui-z-drawer` | 90 | 手机侧栏抽屉 |
| `--ui-z-modal` | 100 | 普通弹窗 |
| `--ui-z-auth` | 150 | 全屏登录门 |
| `--ui-z-toast` | 200 | Toast、灯箱 |
| `--ui-z-confirm` | 260 | 确认框。必须压过其它弹窗 |
| `--ui-z-boot` | 300 | 启动遮罩 |

卡片内部的拖拽柄、角标使用 2–8，不进入上表。

### 2.11 根节点状态

| 属性 | 值 | 使用场景 |
|---|---|---|
| `data-theme` | `dark`（默认）或 `light` | 明暗。跟随系统时由脚本写入，不另写一套色 |
| `data-compact` | `on` 或省略 | 紧凑密度 |
| `data-motion` | `off` 或省略 | 关闭动效 |

主题脚本要在首屏绘制前同步执行，避免先闪默认色再切换。

### 2.12 可复制令牌

把下面整段放进新项目的全局样式最前。与演示页 `<style>` 中的令牌段相同。

```css
:root{
  --ui-hue: 243;
  --ui-sat: 72%;
  --ui-primary: hsl(var(--ui-hue) var(--ui-sat) 60%);
  --ui-primary-strong: hsl(var(--ui-hue) var(--ui-sat) 52%);
  --ui-on-primary: #ffffff;
  --ui-success: #10b981;
  --ui-warning: #f59e0b;
  --ui-danger: #f43f5e;
  --ui-info: #38bdf8;
  --ui-success-soft: color-mix(in oklab, var(--ui-success) 15%, transparent);
  --ui-warning-soft: color-mix(in oklab, var(--ui-warning) 15%, transparent);
  --ui-danger-soft: color-mix(in oklab, var(--ui-danger) 15%, transparent);
  --ui-info-soft: color-mix(in oklab, var(--ui-info) 15%, transparent);
  --ui-radius-xs: 6px;
  --ui-radius-sm: 10px;
  --ui-radius-md: 14px;
  --ui-radius-lg: 18px;
  --ui-radius-pill: 999px;
  --ui-space-1: 4px;
  --ui-space-2: 8px;
  --ui-space-3: 12px;
  --ui-space-4: 16px;
  --ui-space-5: 20px;
  --ui-space-6: 24px;
  --ui-space-8: 32px;
  --ui-sidebar-w: 250px;
  --ui-sidebar-w-rail: 76px;
  --ui-topbar-h: 64px;
  --ui-bottom-nav-h: 0px;
  --ui-safe-bottom: env(safe-area-inset-bottom, 0px);
  --ui-safe-top: env(safe-area-inset-top, 0px);
  --ui-app-h: 100vh;
  --ui-bp-phone: 768px;
  --ui-bp-tablet: 1024px;
  --ui-content-max: 1400px;
  --ui-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
             "Segoe UI", Roboto, "Noto Sans SC", "Helvetica Neue", sans-serif;
  --ui-font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
  --ui-fs-xs: 12px;
  --ui-fs-sm: 13px;
  --ui-fs-md: 14px;
  --ui-fs-lg: 16px;
  --ui-fs-xl: 20px;
  --ui-fs-2xl: 26px;
  --ui-ease: cubic-bezier(.4, 0, .2, 1);
  --ui-t-fast: .16s var(--ui-ease);
  --ui-t-base: .28s var(--ui-ease);
  --ui-z-topbar: 30;
  --ui-z-overlay: 35;
  --ui-z-sidebar: 40;
  --ui-z-dropdown: 50;
  --ui-z-menu: 60;
  --ui-z-popover: 70;
  --ui-z-sheet: 75;
  --ui-z-scrim: 80;
  --ui-z-drawer: 90;
  --ui-z-modal: 100;
  --ui-z-auth: 150;
  --ui-z-toast: 200;
  --ui-z-confirm: 260;
  --ui-z-boot: 300;
}
@supports (height: 100dvh){
  :root{ --ui-app-h: 100dvh; }
}
:root,
[data-theme="dark"]{
  color-scheme: dark;
  --ui-bg: #0c0f15;
  --ui-surface: #141824;
  --ui-surface-2: #1a2030;
  --ui-surface-3: #232b3e;
  --ui-border: rgba(255,255,255,.07);
  --ui-border-strong: rgba(255,255,255,.15);
  --ui-text-1: #edf0f7;
  --ui-text-2: #9aa3b8;
  --ui-text-3: #5f6880;
  --ui-primary-soft: color-mix(in oklab, var(--ui-primary) 16%, var(--ui-surface));
  --ui-primary-ghost: color-mix(in oklab, var(--ui-primary) 14%, transparent);
  --ui-primary-border: color-mix(in oklab, var(--ui-primary) 40%, var(--ui-border));
  --ui-shadow-sm: 0 1px 2px rgba(0,0,0,.35);
  --ui-shadow-md: 0 2px 6px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
  --ui-shadow-lg: 0 8px 24px rgba(0,0,0,.45), 0 24px 64px -24px rgba(0,0,0,.6);
  --ui-topbar-bg: color-mix(in oklab, var(--ui-bg) 78%, transparent);
}
[data-theme="light"]{
  color-scheme: light;
  --ui-primary: hsl(var(--ui-hue) var(--ui-sat) 54%);
  --ui-bg: #f3f5fa;
  --ui-surface: #ffffff;
  --ui-surface-2: #f3f5fb;
  --ui-surface-3: #e9edf6;
  --ui-border: #e4e8f1;
  --ui-border-strong: #d0d7e6;
  --ui-text-1: #171c2b;
  --ui-text-2: #5c6579;
  --ui-text-3: #9aa2b5;
  --ui-primary-soft: color-mix(in oklab, var(--ui-primary) 9%, var(--ui-surface));
  --ui-primary-ghost: color-mix(in oklab, var(--ui-primary) 11%, transparent);
  --ui-primary-border: color-mix(in oklab, var(--ui-primary) 35%, var(--ui-border));
  --ui-shadow-sm: 0 1px 2px rgba(16,24,40,.05);
  --ui-shadow-md: 0 2px 6px rgba(16,24,40,.05), 0 14px 34px -18px rgba(16,24,40,.16);
  --ui-shadow-lg: 0 8px 24px rgba(16,24,40,.08), 0 28px 64px -28px rgba(16,24,40,.22);
  --ui-topbar-bg: color-mix(in oklab, var(--ui-bg) 72%, transparent);
}
html[data-compact="on"]{
  --ui-space-1: 3px;
  --ui-space-2: 6px;
  --ui-space-3: 8px;
  --ui-space-4: 10px;
  --ui-space-5: 12px;
  --ui-space-6: 16px;
  --ui-space-8: 20px;
  --ui-topbar-h: 56px;
  --ui-radius-lg: 14px;
}
```

不支持 `color-mix()` 时，深色 ghost 可降级为 `#2a2d4a`，浅色 ghost 降级为 `#e8eaf7`。目标环境默认可用 `color-mix` 与 `oklab`。

---

## 3. 布局与栅格

### 3.1 应用壳

使用场景：有主导航的多页面应用。营销页、单卡片弹窗、窄插件不必使用这套壳。

```
桌面 ≥1025                         769–1024                         ≤768
┌────────┬──────────────────┐    ┌────┬──────────────────┐    ┌────────────────────┐
│ 250 侧栏│ 顶栏 64           │    │ 76 │ 顶栏              │    │ 顶栏：汉堡 + 标题   │
│ 分组导航├──────────────────┤    │图标├──────────────────┤    ├────────────────────┤
│        │ 内容 ≤1400        │    │栏  │ 内容              │    │ 单列内容            │
│ 用户卡  │ 12 列网格         │    │    │                  │    │ 抽屉侧栏，默认关闭   │
└────────┴──────────────────┘    └────┴──────────────────┘    └────────────────────┘
```

| 区域 | 类 | 规则 |
|---|---|---|
| 壳 | `.app` | 两列：`var(--ui-sidebar-w) 1fr`。最小高度 `--ui-app-h` |
| 侧栏 | `.sidebar` | 粘性、撑满壳高、纵向滚动。内边距上 20px、左右 12px |
| 主区 | `.main` | 纵向 flex，`min-width: 0` |
| 顶栏 | `.topbar` | 高 `--ui-topbar-h`，左右 24px，底边 1px，背景 `--ui-topbar-bg`，`backdrop-filter: blur(14px)`，层级 30 |
| 内容 | `.content` | 最大宽度 `--ui-content-max`，居中。桌面内边距 24 / 24 / 32 |
| 页头 | `.view-head` | 左 `.vh-title` + `.vh-sub`，右 `.vh-actions`。大标题用 `--ui-fs-2xl` / 800 |

侧栏结构：

- `.sb-top`：标志。`.logo-mark` 为 34×34、圆角 11px、135° 主色渐变到 `--ui-primary-strong`。`.logo-name` 15px / 700。`.logo-sub` 10px / `--ui-text-3`。
- `.sb-nav`：`.nav-group` 内先 `.nav-title`（11px、字距 1.2px、全大写），再若干 `.nav-item`。
- `.sb-foot`：顶部分割线后放 `.user-chip`。

图标栏（`.sidebar-collapsed`，或视口 ≤1024px）：列宽改为 `--ui-sidebar-w-rail`。隐藏文字、分组标题、徽章和用户名，导航项水平居中。

### 3.2 十二列网格

使用场景：仪表盘、设置里的卡片墙。表单和文章用单列，不要硬套 12 列。

```css
.grid12{
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--ui-space-5);
}
.col-2{ grid-column: span 2; }
.col-3{ grid-column: span 3; }
.col-4{ grid-column: span 4; }
.col-5{ grid-column: span 5; }
.col-6{ grid-column: span 6; }
.col-8{ grid-column: span 8; }
.col-12{ grid-column: span 12; }
```

推荐跨列：主内容 8 列配侧卡片 4 列；并排两块用 6+6；统计条用 3 或 4。断点见下一章。网格间距用 `--ui-space-5`，不单独写 gap。

### 3.3 主从布局

使用场景：列表加详情、目录加编辑器。

- 桌面：固定侧列（约 216–250px）加 `minmax(0, 1fr)`。侧列 `position: sticky`。
- ≤1024px：若两列已经放不下，改为单列上下堆叠。
- ≤768px：改为两级。列表级只显示目录，详情级只显示内容，用返回按钮回到列表。不要三列同时挤在一屏。
- 详情里的滚动区 `min-height: 0`，底栏 `flex-shrink: 0`。

### 3.4 设置布局

使用场景：分组很多的设置页。

`.set-layout` 为 `216px + minmax(0, 1fr)`，间距 20px。左列 `.set-menu` 粘性。右列 `.set-row` 为左文案（`.set-row-label` 13px / 600，`.set-row-sub` 12px / `--ui-text-3`）加右控件。行上下内边距 16px，行间 1px 弱边框。

≤900px 时改为单列，分区菜单横向滚动，不换行。

---

## 4. 响应式

断点看视口，不看内容列宽。

| 视口 | 行为 | 使用场景 |
|---|---|---|
| ≥1281px | 侧栏 250px；网格按设计跨列 | 桌面全宽 |
| ≤1280px | `.col-8` 改为 12，`.col-4` 与 `.col-3` 改为 6，`.col-2` 改为 4。`.col-5`、`.col-6` 不变 | 笔记本上避免 8+4 挤成一条 |
| ≤1024px | 侧栏变为 76px 图标栏；顶栏日期 `.crumb-date` 隐藏 | 窄桌面。仍然是常驻侧栏，不是抽屉 |
| ≤900px | 仅设置布局：单列 + 横向分区 | 组件级，不改变应用壳 |
| ≤800px | 并排的双文本面板改为上下 | 翻译、对照编辑一类组件 |
| ≤768px | 手机壳，见下节 | 手机 |
| ≥769px | 禁止抽屉、禁止底栏 | 防止宽屏误用手机导航 |

### 4.1 手机壳（≤768px）

使用场景：手机浏览器与窄 WebView。

- `html`、`body`、`.app` 隐藏横向溢出。
- `.app` 改为单列，高度 `--ui-app-h`。主区 `min-height: 0`，由 `.content` 滚动。
- 顶栏高度为 `calc(var(--ui-topbar-h) + var(--ui-safe-top))`，上内边距为安全区，左右 12px。
- 内容内边距 16px，底部再加 `--ui-safe-bottom`。
- 所有 `.col-*` 跨满 12 列。
- 页面大标题 22px。页头操作区占满一行，其中按钮最小高度 40px。
- 侧栏改为固定定位抽屉：宽 `min(86vw, 320px)`，默认 `translateX(-100%)`，背景表面色，大阴影，层级 90。`body.nav-open` 时滑入。抽屉内文字全部恢复，导航项最小高度 44px、内边距 12px。
- 遮罩 `.nav-scrim`：全屏，`rgba(5, 8, 15, .46)`，层级 80。打开时才接收点击。打开抽屉时 `body` 禁止滚动。
- 入口是顶栏汉堡按钮。设置与退出放在抽屉底部用户卡或顶栏菜单里。
- 搜索：顶栏放一个图标按钮，展开后 `.searchbar` 贴住顶栏（层级 35），输入 16px，并提供「取消」。桌面端的键盘提示 `.kbd` 在手机隐藏。
- 图标按钮 44×44。输入框字号 16px。
- 工作台式大弹层（设置、阅读器）改为全屏、圆角 0、高度 `--ui-app-h`。普通确认框仍用 `min(420px, 92vw)`，最大高度 `calc(var(--ui-app-h) - 24px)`。
- Toast 距底部 `calc(var(--ui-safe-bottom) + 16px)`。
- 标签条不换行，横向滚动。
- `@media (hover: none), (pointer: coarse)`：平时靠悬停才出现的行内操作改为常显。

### 4.2 验收视口

每次改布局至少看两种宽度：

- 手机：375×667 或 390×844
- 桌面：1280×800 或更宽

检查侧栏开合、网格是否跨列、底栏是否还在视口内、弹层是否被裁切、输入框聚焦后页面是否被放大。

---

## 5. 组件

类名全小写短横线，不用 BEM 双下划线。变体是附加类，状态用 `.active`、`.on`、`.open`、`.show`、`.is-error`。

演示页用 `.is-hover`、`.is-focus` 把悬停和聚焦画出来。正式项目只写伪类，不要把这两个类留在业务代码里。

图标 `.ic`：18×18，`stroke: currentColor`，线宽 1.8，圆头圆角，不填充。按钮内 15px，卡片标题 16px，导航 19px，胶囊 11px。

### 5.1 按钮 `.btn`

使用场景：主按钮是该区域唯一的提交或创建；描边是与主按钮并列的次操作；幽灵是工具条、取消；危险用于删除确认之后。

默认：高 36px，左右 16px，圆角 `--ui-radius-sm`，字号 13px，字重 600，图标与文字间距 7px。`:active` 为 `scale(.97)`。`:disabled` 为透明度 0.5、`cursor: not-allowed`，且不再缩放。

| 类 | 默认 | 悬停 | 使用场景 |
|---|---|---|---|
| `.btn-primary` | 主色底、`--ui-on-primary` 字、品牌投影 | 背景改为 `--ui-primary-strong` | 主操作 |
| `.btn-outline` | 透明底、强边框、`--ui-text-1` | 边框与文字变主色，背景 ghost | 次操作 |
| `.btn-ghost` | 透明，文字 `--ui-text-2` | 背景 `--ui-surface-2`，文字 `--ui-text-1` | 取消、工具条 |
| `.btn-danger-ghost` | 危险色字 | 背景 `--ui-danger-soft` | 列表里的删除 |
| `.btn-outline-danger` | 危险色边和字 | 危险色实底、白字 | 需要被看见、但还不是唯一主按钮的危险操作 |
| `.btn-danger` | 危险色实底、白字 | `brightness(1.08)` | 确认框里的删除 |
| `.btn-warning` | 警告色实底、白字 | `brightness(1.08)` | 重启、覆盖等可恢复但需注意的确认 |
| `.btn-sm` | 高 30px，左右 12px，字号 12px | 同变体 | 卡片内、表格旁 |
| `.btn-lg` | 高 42px，左右 22px | 同变体 | 登录、空状态 |
| `:disabled` | 透明度 0.5 | 无 | 表单未完成、请求中 |

按下对所有变体相同。手机上页面级按钮 `min-height: 40px`。键盘焦点保持浏览器默认轮廓，不要写成 `outline: none`。

```html
<button class="btn btn-primary" type="button">保存</button>
<button class="btn btn-outline" type="button">导出</button>
<button class="btn btn-ghost" type="button">取消</button>
<button class="btn btn-danger" type="button">删除</button>
<button class="btn btn-primary" type="button" disabled>保存</button>
```

### 5.2 图标按钮

使用场景：顶栏工具、没有文字的次操作。能用文字就不用纯图标；纯图标必须有 `aria-label`。

| 类 | 尺寸 | 默认 | 悬停 | 使用场景 |
|---|---|---|---|---|
| `.icon-btn` | 36×36，手机 44×44，圆角 sm | 透明，文字 `--ui-text-2` | 背景 `--ui-surface-2`，文字 `--ui-text-1` | 顶栏 |
| `.icon-btn.has-dot` | 同上 | 右上 7px 危险色圆点，2px 底色边 | 同悬停 | 未读 |
| `.icon-btn-xs` | 28×28，圆角 8px | 文字 `--ui-text-3` | 背景 `--ui-surface-3` | 行内复制、翻页 |
| `:disabled` | — | 透明度 0.5 | 无 | 不可用 |

### 5.3 文本输入

使用场景：单行用 `.input`，带前置图标用 `.input-wrap`，多行用 `textarea.input`，短选项用 `.lang-select`。

| 状态 | 样式 |
|---|---|
| 默认 | 高 38px，左右 14px，圆角 sm，1px `--ui-border-strong`，背景表面色 |
| 占位 | `--ui-text-3` |
| 悬停 | 不变，以免和焦点混淆 |
| 聚焦 | 边框主色，`box-shadow: 0 0 0 3px var(--ui-primary-ghost)` |
| 错误 `.is-error` | 边框危险色，光环改为 `--ui-danger-soft`。说明文字改危险色 |
| 禁用 | 透明度 0.5，背景 `--ui-surface-2`，`cursor: not-allowed` |
| 前置图标 | 图标绝对定位在左侧 12px；输入左内边距 36px |
| 多行 | 与单行同一套边框和焦点环。最小高度 100px，内边距 10px 14px，行高 1.8，`resize: vertical` |
| 下拉 `.lang-select` | 高 34px，左右 12px。手机最小高度 40px、字号 16px |

字段组 `.field`：纵向排列，标签与控件间距 6px。`.field-label` 为 13px / 600 / 行高 1.45。`.field-hint` 为 12px / `--ui-text-3` / 行高 1.55，上边距 5px。字段与字段之间 8px。这是弹窗表单与设置行的归纳，演示页与本文使用同一结构。

```html
<div class="field">
  <label class="field-label" for="name">名称</label>
  <input id="name" class="input" placeholder="请输入">
  <p class="field-hint">保存后可在列表里修改</p>
</div>
```

搜索 `.searchbar` / `.search-field`：使用场景是全局查找。胶囊高 40px，左右 14px，弱边框，最大宽度 520px。容器 `:focus-within` 时边框主色，光环为 `0 0 0 4px var(--ui-primary-ghost)`（比普通输入多 1px）。右侧可放 `.kbd`。建议面板 `.search-pop` 在聚焦时出现：圆角 md、大阴影、层级 50，距字段 8px。

`.kbd`：等宽 11px，内边距 2px 7px，圆角 6px，表面 2 底，强边框，文字 `--ui-text-3`。

### 5.4 选择控件

**开关 `.switch`。** 使用场景：立即生效的二元设置。40×23，全圆角。关态背景 `--ui-surface-3`。白色圆钮 17×17，距边 3px。开态 `.on`：背景主色，圆钮 `translateX(17px)`。禁用透明度 0.45（与按钮的 0.5 不同）。手机上用 `.switch-hit` 把热区补到至少 44px，不拉大滑块。请同时设置 `role="switch"` 与 `aria-checked`。

**复选 `.checkbox`。** 使用场景：表单里的可选项、列表多选。隐藏原生框，用 `.box`：17×17，圆角 5px，1.5px 强边框。选中后主色底、白色勾。文字 13px / `--ui-text-2`，与框间距 8px。

**滑杆 `input[type="range"].range`。** 使用场景：长度、音量等连续值。轨道高 5px、圆角 3px；已选部分主色，未选 `--ui-surface-3`。滑块 17×17，白底，2px 主色边，小阴影。悬停放大到 1.15。

**分段 `.seg` / `.seg-btn`。** 使用场景：2–4 个互斥视图，例如明暗、编辑 / 预览。浅槽 `--ui-surface-2`，内边距 3px，间距 2px，圆角 sm。按钮左右 14px、上下 6px，字号 12px / 600。悬停文字变为 `--ui-text-1`。`.active`：表面色底、小阴影。

**标签 `.tabs` / `.tab`。** 使用场景：同一数据的分类，比分段更适合可增删的项。结构与分段相同，字号 14px / 500。`.active` 字重 600。新建用 `.tab-add`：虚线强边框，悬停变主色 ghost。手机上标签条横向滚动、不换行，项最小高度 44px。

### 5.5 状态胶囊、标签、头像

**`.chip`。** 使用场景：表格和列表里的短状态。高 22px，左右 10px，全圆角，11px / 600。默认带 6px 圆点；`.no-dot` 去掉。默认表面 2 底、次要文字色。

| 类 | 背景 | 文字 |
|---|---|---|
| `.success` | `--ui-success-soft` | `--ui-success` |
| `.warning` | `--ui-warning-soft` | `--ui-warning` |
| `.danger` | `--ui-danger-soft` | `--ui-danger` |
| `.info` | `--ui-info-soft` | `--ui-info` |
| `.primary` | `--ui-primary-ghost` | `--ui-primary` |

**`.tag`。** 使用场景：没有状态含义的关键词。全圆角，左右 9px、上下 2px，表面 2 底，11px，无圆点。

**`.avatar`。** 使用场景：用户。默认 34px 圆形，主色渐变，白字 13px / 700。`.sm` 28px / 11px，`.lg` 44px / 16px。`.online` 右下 10px 成功色点，2px 表面色边。同一列表里第二、第三人用 `.alt`（琥珀到危险的渐变）和 `.alt2`（成功到信息的渐变），避免所有头像同色。

**导航徽章 `.nav-badge`。** 使用场景：侧栏未读数。全圆角，左右 8px，危险浅底、危险色字，11px / 600。

### 5.6 卡片 `.card`

使用场景：一块可独立阅读的信息。仪表盘、设置分组、列表容器都用它。

静止：表面色、1px 弱边框、小阴影、圆角 `--ui-radius-lg`。`.lift` 在悬停时上移 2px，阴影改为中阴影，边框改为强边框。减少动效时取消位移。

```html
<article class="card lift">
  <header class="card-head">
    <h3 class="card-title">标题</h3>
    <button class="card-link" type="button">全部</button>
  </header>
  <div class="card-pad">内容</div>
</article>
```

`.card-head` 横向居中，间距 12px，内边距 16px 20px。`.card-title` 14px / 700。`.card-sub` 12px / `--ui-text-3`。`.card-link` 靠右，12px / 600，悬停变主色并铺 ghost。`.card-pad` 左右和底 20px。

危险分组 `.set-card-danger`：边框为主题危险色 35% 混入弱边框，标题图标用危险色。使用场景：清空、注销一类设置块。

### 5.7 列表行 `.list-item`

使用场景：文件、会话、任务等可选择的行。

桌面：横向，间距 8px，内边距 5px 10px，圆角 6px，字号 12.5px，透明边框。悬停背景 `--ui-surface-2`。`.active` 背景 ghost、边框 `--ui-primary-border`。手机最小高度 44px，内边距 10px 12px。

行内次要操作默认可以只在悬停时出现；粗指针设备改为常显。

### 5.8 导航项与用户卡

**`.nav-item`。** 使用场景：侧栏主导航，一项对应一个区域。

| 状态 | 样式 |
|---|---|
| 默认 | 透明，文字 `--ui-text-2`，14px，内边距 9px 12px，图标 19px，间距 11px |
| 悬停 | 背景 `--ui-surface-2`，文字 `--ui-text-1` |
| 当前 `.active` | 背景 ghost，文字主色，字重 600。左侧 3×18 主色条，圆角 3px |
| 手机 | 最小高度 44px，内边距 12px |

**`.user-chip`。** 使用场景：侧栏底部的账号入口，点击打开账户或设置菜单。横向，间距 10px，内边距 8px 10px，圆角 sm。悬停：背景表面 2、边框主色混合边、上移 2px、小阴影；头像放大到 1.08 并加 3px ghost 环；箭头旋转 180° 并变主色。按下回到原位并缩放到 0.98。`.user-name` 13px / 600，`.user-plan` 11px / `--ui-text-3`。

### 5.9 菜单 `.menu`

使用场景：头像、更多操作。不要用它做主导航。

相对触发器绝对定位，上距 8px，最小宽度 216px，内边距 6px，圆角 md，弱边框，大阴影，层级 60。关闭时透明并上移 6px、缩放到 0.98；`.open` 后完全可见。

`.menu-item`：左右 10px、上下 9px，13px，文字 `--ui-text-2`。悬停背景表面 2、文字 `--ui-text-1`。`.danger` 悬停为危险浅底和危险色字。`.menu-div` 为 1px 弱边框，上下 6px。

手机上菜单最大宽度为 `calc(100vw - 16px)`。

### 5.10 弹层

| 部件 | 类 | 规则 | 使用场景 |
|---|---|---|---|
| 遮罩 | `.modal-mask` | 固定全屏，`rgba(5,8,15,.55)`，模糊 4px，层级 100。`.open` 后可见 | 任何模态 |
| 对话框 | `.modal` | 宽 `min(420px, 92vw)`，圆角 lg，表面色，弱边框，大阴影。打开前缩放 0.96 并下移 8px | 确认、短表单 |
| 头 | `.m-head` | 内边距 20px 20px 12px。标题 16px / 700，说明 12px / `--ui-text-3` | |
| 体 | `.m-body` | 左右与底 20px，纵向间距 8px | |
| 脚 | `.m-foot` | 顶部分割，内边距 16px 20px，按钮靠右，间距 8px | 左取消（幽灵）、右确认（主按钮或危险按钮） |
| 确认层 | `.modal-mask.confirm` | 层级 `--ui-z-confirm`（260） | 必须盖住已经打开的弹窗 |
| 登录门 | `.auth-card` | 宽 `min(400px, 92vw)`，内边距 30px 30px 22px，圆角 lg，大阴影 | 未登录时的全屏门，层级 150 |
| 灯箱 | 全屏层 | 背景 `rgba(0,0,0,.78)`，层级 200 | 图片预览 |

关闭方式：关闭按钮、取消、点击遮罩、Esc。点击对话框内部不关闭。

手机上普通对话框最大高度 `calc(var(--ui-app-h) - 24px)`。占据整个工作区的层改为全屏、圆角 0。

登录卡里的主按钮在手机上占满宽度，输入字号 16px。

### 5.11 反馈

**Toast `.toast`。** 使用场景：操作已经发生之后的一句结果，不承担需要选择的确认。固定在底部水平居中，距底 32px（手机为安全区 + 16px）。胶囊，内边距 11px 18px，字号 13px / 600，大阴影，层级 200。配色反转：背景用 `--ui-text-1`，文字用 `--ui-bg`。`.show` 时可见。`.err` 的文字和图标改为危险色。

**空状态 `.empty`。** 使用场景：列表没有数据，且用户可以做下一步。纵向居中，内边距 32px 20px。`.empty-ic` 为 56px 虚线圆。`.empty-title` 字重 700。`.empty-sub` 12px / `--ui-text-3`，最宽 260px。下面放一个主按钮。

**骨架 `.sk`。** 使用场景：列表和卡片的首次加载。底色 `--ui-surface-3`，圆角 8px，1600ms 微光。`.sk-line` 高 12px；宽度修饰 `.w40`、`.w60`、`.w80`。`.sk-circle` 44px 圆。`.sk-block` 高 90px。

**横幅 `.sec-banner`。** 使用场景：一块区域顶部的持续状态，比 Toast 停留更久。圆角 md，内边距 10px 16px，12px / 600，图标 15px。默认成功浅底。`.warn`、`.danger`、`.info` 只替换为对应的 soft 背景和语义色字。

**引用 `.ex`。** 使用场景：摘录、示例句。左 3px 主色边，其余三角为圆角 sm，背景表面 2，内边距 12px 16px，字号 13px，行高 1.8。

### 5.12 数据展示

**表格 `.tbl`。** 使用场景：同质记录。外包 `.tbl-wrap` 以便手机横向滚动。表头 11px / 600、字距 0.5px、全大写、文字 `--ui-text-3`，下边框弱边，内边距 10px 16px。单元格 13px，内边距 12px 16px，下边框弱边，最后一行无边。行悬停背景表面 2。

**指标 `.stat`。** 使用场景：仪表盘上的一个数。横向，间距 14px，内边距 16px 20px。`.stat-ic` 44×44、圆角 md。色调用 `.tint-primary`、`.tint-success`、`.tint-warning`、`.tint-info`（浅底 + 语义色）。`.stat-val` 22px / 700 / 行高 1.2。`.stat-label` 12px / `--ui-text-3`。涨跌：`.up` 成功色，`.down` 危险色。

**进度 `.bar`。** 使用场景：占比、用量。高 6px，圆角 4px，槽为 `--ui-surface-3`。`.bar-fill` 默认主色，宽度过渡 600ms。`.ok`、`.warn`、`.bad` 见 2.2 节。

**环形仪 `.gauge`。** 使用场景：一个 0–100 的占比。92×92。轨道 `--ui-surface-3`，线宽 7，圆头。数值类与进度条相同。中心数字 18px / 700。

**色板 `.swatch`。** 使用场景：选择品牌色。34×34 圆形。悬停放大到 1.1。`.on` 为双环（3px 表面色间隔 + 2px 当前色）并显示 ✓。

### 5.13 磁贴

使用场景：一组入口，而不是一条记录。

`.tile`：圆角 md，1px 弱边框，表面色，内边距 16px。悬停上移 2px，边框改为主色混合边，中阴影。图标槽 38×38，圆角 sm，ghost 底，主色图标。标题 13px / 600，说明 11px / `--ui-text-3` / 行高 1.4。

`.tile.add`：虚线强边框、透明底，悬停变主色 ghost。使用场景：这组入口的「新建」。

`.tile.is-disabled`：透明度 0.55，悬停不位移。使用场景：尚未开放的功能，旁边放 `.tag` 说明原因。

---

## 6. 交互状态对照

| 组件 | 默认 | 悬停 | 按下 / 当前 | 聚焦 | 禁用 |
|---|---|---|---|---|---|
| 主按钮 | 主色实底 | `--ui-primary-strong` | `scale(.97)` | 浏览器轮廓 | 透明度 0.5，不缩放 |
| 描边按钮 | 强边框 | 主色字 + ghost 底 | `scale(.97)` | 浏览器轮廓 | 透明度 0.5 |
| 幽灵按钮 | 透明，次要文字 | 表面 2 | `scale(.97)` | 浏览器轮廓 | 透明度 0.5 |
| 图标按钮 | 透明 | 表面 2 | 无额外缩放 | 浏览器轮廓 | 透明度 0.5 |
| 输入框 | 强边框 | 不变 | — | 主色边 + 3px ghost | 透明度 0.5，表面 2 |
| 搜索 | 弱边框胶囊 | 不变 | — | 主色边 + 4px ghost | 同输入框 |
| 开关 | 表面 3 | 无 | `.on` 主色，钮右移 17px | 浏览器轮廓 | 透明度 0.45 |
| 复选 | 强边框方框 | 无 | 主色底 + 白勾 | 由标签承接 | 透明度 0.5 |
| 分段 / 标签 | 浅槽内透明 | 文字 `--ui-text-1` | `.active` 表面底 + 小阴影 | 浏览器轮廓 | 透明度 0.5 |
| 导航项 | 次要文字 | 表面 2 | `.active` ghost + 左色条 | 浏览器轮廓 | — |
| 卡片 `.lift` | 小阴影 | 上移 2px + 中阴影 | — | — | — |
| 菜单项 | 次要文字 | 表面 2 | — | 浏览器轮廓 | — |
| 表格行 | 透明 | 表面 2 | — | — | — |
| 列表行 | 透明 | 表面 2 | `.active` ghost + 主色边 | 浏览器轮廓 | — |

错误不是禁用：输入错误保持可编辑，用危险色边和危险色说明。失败结果用 `.toast.err` 或 `.sec-banner.danger`。

---

## 7. 命名约定

| 类别 | 规则 | 例子 |
|---|---|---|
| 变量 | `--ui-` + 语义 | `--ui-text-2`、`--ui-space-4` |
| 布局 | 短词 | `.app`、`.sidebar`、`.topbar`、`.content` |
| 控件 | 短词，变体连写 | `.btn-primary`、`.icon-btn-xs` |
| 状态 | 形容词 | `.active`、`.open`、`.on`、`.show`、`.is-error` |
| 演示专用 | `.is-hover`、`.is-focus`、`.sg-*` | 不进入业务代码 |
| 图标 | `.ic`，图形本身用 24 视口的描边路径 | |
| 行为钩子 | `data-*` | `data-theme`、`data-open` |
| 本地存储 | 产品自己的短前缀，不使用 `ui_` | 主题键由产品决定 |
| 文件 | 小写短横线 | `index.html` |

新项目如果会和宿主页面的 `.btn`、`.modal` 冲突，给类名加产品前缀，令牌仍用 `--ui-`。前缀只加选择器，不改数值。嵌入第三方页面时用 Shadow DOM，令牌定义在宿主内部的 `:host` 上。

样式顺序：令牌、重置、组件、布局、最后才是断点。不要在组件文件里把 `--ui-primary` 写成固定颜色。

`[hidden] { display: none !important; }` 必须保留，避免作者写的 `display: flex` 把原生隐藏盖掉。

---

## 8. 无障碍与触控

- 手机上可点目标至少 44px。开关用外层热区补足，不改变 40×23 的图形。
- 输入在手机上 16px。
- 不只靠颜色区分状态：胶囊保留圆点，开关有位移，当前导航有色条。
- 图标按钮提供文本替代。
- 拖拽之外保留点击或菜单，以便无法拖拽的用户完成同一件事。
- 对比：正文用 `--ui-text-1`，说明可以降到 `--ui-text-2`。`--ui-text-3` 只用于占位和装饰性元数据。
- 尊重 `prefers-reduced-motion`。

---

## 9. 迁移步骤

1. 复制第 2.12 节令牌，确认深色与浅色都能切换。
2. 从 `index.html` 的 `<style>` 复制重置、组件、布局和响应式。删掉 `.sg-*` 与 `.is-hover` / `.is-focus` 的演示选择器（伪类规则保留）。
3. 应用壳只在有主导航时使用。插件和窄弹窗只取按钮、输入、胶囊、卡片、Toast。
4. 品牌不同时，只改 `--ui-hue` 与 `--ui-sat`。
5. 用 375 与 1280 两种宽度走通主路径：导航、表单、弹层、空状态。

---

## 10. 与现有实现的对照

演示页和本文使用 `--ui-`。现有产品样式使用 `--om-`，两者数值一一对应，只是前缀不同。迁移时可以整表替换。

| 本文 | 现有实现 | 说明 |
|---|---|---|
| `--ui-*` | `--om-*` | 同名后缀，同数值 |
| `--ui-content-max` | `.content` 的 `max-width: 1400px` | 提升为令牌 |
| `--ui-z-*` | 各组件上的字面量 `z-index` | 提升为令牌，数值不变 |
| `.btn-danger` / `.btn-warning` | `.btn.danger` / `.btn.warning` | 类名改为单一变体，颜色与悬停不变 |
| `.list-item` | `.note-item` | 通用列表行，尺寸来自原列表行 |
| `.tile` | `.tool-tile` / `.bm-tile` | 合并为一种入口磁贴 |
| `.field` | 弹窗 `.m-body` 与设置 `.set-row` 的组合 | 归纳出的字段结构，字号与行高不变 |
| `.sec-banner.warn` / `.danger` / `.info` | `.sec-banner` 仅成功色 | 按胶囊的语义扩展方式补齐 |
| `.bar-fill.bad` | 样式已存在 | ≥90% 使用危险色 |

其余组件（按钮高度、输入焦点环、开关尺寸、断点、侧栏宽度、圆角、间距、明暗表面）与现有样式相同。
