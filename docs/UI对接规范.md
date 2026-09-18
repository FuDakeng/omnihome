# 万事屋 OmniHome · 跨项目 UI 对接规范

> **本文档是多端视觉与交互的单一事实源（Source of Truth）。**
> 门户前端 `demo/` 为设计系统原件；浏览器扩展 `extension/`、Obsidian 插件 `obsidian-plugin/omnihome-sync/` 以及任何后续独立产品（如账鹅 GooseCount）均按本文对齐。
>
> 对照实现：`demo/css/theme.css`、`demo/css/layout.css`、`demo/css/components/*.css`、`demo/css/mobile.css`、`.cursor/rules/omnihome-ui-responsive.mdc`。
> 历史草稿 `demo/DESIGN.md` 仅保留早期设计意图，**以本文与当前 CSS 为准**。
>
> 版本锚点：门户 v0.3.11（2026-09-18）。令牌或组件有破坏性变更时，同步改本文件「变更记录」并更新对照表。

---

## 0. 文档怎么用

| 角色 | 用法 |
|---|---|
| 门户开发 | 新增控件必须走已有令牌与类名；禁止再写一套色值。 |
| 扩展 / 插件开发 | 对照第 7 章映射表改本地 CSS；能复用令牌名就复用，宿主限制下用别名映射。 |
| 新项目接入 | 按第 5、6 章拷贝令牌文件 + 命名约定 + 隔离方案，再按第 7.3 节填空表落地。 |
| 设计评审 | 用第 1 章原则和第 4 章断点验收，不靠截图像素对齐。 |

**统一目标**：用户从门户切到扩展弹窗、Obsidian 设置页或其它自托管产品时，能认出同一套品牌——靛蓝主色、冷灰表面、10/18 圆角、胶囊状态、160ms 反馈——而不是同一套 DOM。

**不要统一的部分**：宿主原生控件（Obsidian Setting、Chrome 扩展 popup 宽度上限、系统菜单）保持宿主交互；只替换颜色、圆角、字体、按钮层级与反馈节奏。

---

## 1. 设计原则与风格定义

### 1.1 品牌定位

| 项 | 定义 |
|---|---|
| 中文名 | 万事屋 |
| 英文名 | OmniHome |
| 副标 | `OMNIHOME · PERSONAL HUB`（禁止再出现 YOROZUYA / OmniDesk 字样） |
| 气质 | 自托管个人工作台：克制、清晰、可长期盯着看，不炫技 |
| 默认主题 | 深色优先；浅色为正交维度，不是「降级」 |
| 默认主色 | 靛蓝 Indigo，`--om-hue: 243`，`--om-sat: 72%` |

Logo 为八角星形（`#i-logo`）：34×34 圆角 11px 的渐变方标，白描图标。扩展弹窗可用字母 **O** 作为缩小版，但渐变必须是 `linear-gradient(135deg, var(--om-primary), var(--om-primary-strong))`，禁止紫粉双色（`#a855f7 → #6366f1`）那套旧扩展配色。

### 1.2 风格关键词

1. **冷灰靛蓝，而不是霓虹赛博。** 页面底接近墨蓝黑 `#0c0f15`，卡片略抬一层 `#141824`，主色只出现在行动点、当前项、焦点环。
2. **表面分层，而不是描边堆砌。** 层级靠 `--om-bg` / `--om-surface` / `--om-surface-2` / `--om-surface-3` 与三级阴影，边框保持半透明弱描边。
3. **胶囊语义，而不是色块警告。** 状态用 `.chip`（圆点 + 浅底 + 语义色字），成功用克制的绿，危险才用玫红。
4. **即时反馈，幅度克制。** 悬停上浮 2px、按钮按下 `scale(.97)`、焦点环 3–4px 主色光晕；不做弹跳、长路径位移。
5. **明暗与主色正交。** `data-theme` 只换表面与文字；`--om-hue` 只换品牌色。两套旋钮互不绑定。
6. **同一套导航，两端都认得。** PC 常驻侧栏，手机汉堡抽屉；禁止再做一套底部 Tab。

### 1.3 交互原则

| 原则 | 落地 |
|---|---|
| 焦点可见 | `.input:focus`、`.search-field:focus-within` 必须有主色边 + ghost 光环 |
| 危险二次确认 | 删除、覆盖、清空走 `#confirmMask` / `.modal`，确认钮用危险样式 |
| 即时预览、保存才持久 | 主题 / 密度 / 动效先写 `localStorage` 与 CSS 变量，点「保存更改」再 `PUT /api/settings` |
| 加载可感知 | 列表用 `.sk` 骨架，按钮内用 `.spin`，禁止空白闪一下 |
| 空态可行动 | `.empty` = 虚线圆图标 + 标题 + 说明 + 主按钮 |
| 尊重减少动效 | `html[data-motion="off"]` 与 `@media (prefers-reduced-motion: reduce)` 同时生效 |
| 触控可点 | 手机可点目标 ≥44px；输入框手机 16px，避免 iOS 聚焦缩放 |
| `[hidden]` 兜底 | 全站 ` [hidden]{ display: none !important; }`，防止作者 `display:flex` 盖掉 UA 隐藏 |

### 1.4 禁止事项

- 禁止硬编码品牌色（`#6366f1`、`#a855f7`、`#7c6ced`）作为门户或扩展主色。
- 禁止第三套断点（例如 680 / 720 / 900 可作为组件内部微调，但导航壳只能是 768 / 1024 / 1280）。
- 禁止手机常驻底栏（`.phone-nav`、底部 Tab）。
- 禁止用过大 `min-height` 把编辑器底栏（`.ed-foot`）裁出视口。
- 禁止在 Obsidian 全局选择器上写未加前缀的 `.btn` / `.modal` / `body` 重置。
- 禁止把门户 `.app` 双栏栅格原样塞进 384px 的扩展 popup。

---

## 2. 设计变量与令牌说明

所有跨项目共享令牌以 `--om-` 为前缀。门户定义在 `demo/css/theme.css`。其它项目允许做 **别名一层**（见 6.3），但语义名必须能一一对应。

### 2.1 品牌色（用户可调）

| 令牌 | 默认 | 说明 |
|---|---|---|
| `--om-hue` | `243` | 色相，换肤只改这一个数 |
| `--om-sat` | `72%` | 饱和度；自定义取色时一并写入 |
| `--om-primary` | 深 `hsl(243 72% 60%)` / 浅 `hsl(243 72% 54%)` | 品牌主色 |
| `--om-primary-strong` | `hsl(var(--om-hue) var(--om-sat) 52%)` | 主按钮悬停、Logo 渐变终点 |
| `--om-on-primary` | `#ffffff` | 主色上的文字 / 图标 |
| `--om-primary-soft` | 深 `color-mix(… 16%, surface)` / 浅 `9%` | 浅底高亮（导航当前项、chip.primary） |
| `--om-primary-ghost` | 深 `14%` 透明 / 浅 `11%` | 更淡的悬浮底、焦点环 |
| `--om-primary-border` | 深 `40%` mix border / 浅 `35%` | 选中描边 |

JS 换肤只需：

```js
document.documentElement.style.setProperty('--om-hue', String(hue));
document.documentElement.style.setProperty('--om-sat', sat + '%');
```

内置色板（设置中心 `.swatch[data-hue]`）：

| 名称 | hue | 示意 |
|---|---|---|
| 靛蓝（默认） | 243 | `hsl(243 72% 58%)` |
| 青碧 | 190 | `hsl(190 72% 48%)` |
| 翡翠 | 160 | `hsl(160 70% 42%)` |
| 琥珀 | 35 | `hsl(35 90% 52%)` |
| 玫瑰 | 340 | `hsl(340 75% 55%)` |

另提供 `.swatch.custom` 取色器：HEX → HSL 后回写 `--om-hue` / `--om-sat`。

### 2.2 语义色（跨主题恒定）

| 令牌 | 色值 | 用途 |
|---|---|---|
| `--om-success` | `#10b981` | 运行中、已同步、在线点、强度满档 |
| `--om-warning` | `#f59e0b` | 重启中、天气图标、待处理 |
| `--om-danger` | `#f43f5e` | 错误、删除、停止、危险区 |
| `--om-info` | `#38bdf8` | 信息、风速/湿度次要指标 |
| `--om-*-soft` | `color-mix(in oklab, 色 15%, transparent)` | 对应浅底 |

监控阈值着色（环形仪 / 进度条）：`<50` 用 success，`<80` 用 warning，`≥80` 用 danger。不要用主色表示健康度。

### 2.3 表面与文字（明暗两套）

深色（默认，`:root` 与 `[data-theme="dark"]`）：

| 令牌 | 值 | 角色 |
|---|---|---|
| `--om-bg` | `#0c0f15` | 页面底、知识库树底 |
| `--om-surface` | `#141824` | 卡片 / 弹层 / 侧栏抽屉 |
| `--om-surface-2` | `#1a2030` | 行悬停、分段槽、次级面板 |
| `--om-surface-3` | `#232b3e` | 骨架、开关关、进度槽 |
| `--om-border` | `rgba(255,255,255,.07)` | 弱描边 |
| `--om-border-strong` | `rgba(255,255,255,.15)` | 输入框、强调分割 |
| `--om-text-1` | `#edf0f7` | 标题 / 正文 |
| `--om-text-2` | `#9aa3b8` | 次要文字、未选导航 |
| `--om-text-3` | `#5f6880` | 占位、弱化、日期 |
| `--om-topbar-bg` | `color-mix(bg 78%, transparent)` | 毛玻璃顶栏 |

浅色（`[data-theme="light"]`）：

| 令牌 | 值 |
|---|---|
| `--om-bg` | `#f3f5fa` |
| `--om-surface` | `#ffffff` |
| `--om-surface-2` | `#f3f5fb` |
| `--om-surface-3` | `#e9edf6` |
| `--om-border` | `#e4e8f1` |
| `--om-border-strong` | `#d0d7e6` |
| `--om-text-1` | `#171c2b` |
| `--om-text-2` | `#5c6579` |
| `--om-text-3` | `#9aa2b5` |
| `--om-topbar-bg` | `color-mix(bg 72%, transparent)` |

阴影：

| 令牌 | 深色 | 浅色 | 使用 |
|---|---|---|---|
| `--om-shadow-sm` | `0 1px 2px rgba(0,0,0,.35)` | 冷灰 5% | 卡片静态、分段选中 |
| `--om-shadow-md` | 两层，含大范围暗 | 冷灰 5% + 16% | 悬停上浮 |
| `--om-shadow-lg` | 更重 | 冷灰 8% + 22% | 菜单 / 弹层 / Toast |

页面背景纹理（仅门户 `body`）：

```css
background:
  radial-gradient(1200px 500px at 85% -10%, var(--om-primary-ghost), transparent 60%),
  var(--om-bg);
```

桌面 `background-attachment: fixed`；手机改为 `scroll`，避免 iOS 抖动。

### 2.4 几何、间距、尺寸

| 令牌 | 默认 | 紧凑 `html[data-compact="on"]` |
|---|---|---|
| `--om-radius-xs` | 6px | 不变 |
| `--om-radius-sm` | 10px | 不变（控件） |
| `--om-radius-md` | 14px | 不变 |
| `--om-radius-lg` | 18px | 14px（卡片） |
| `--om-radius-pill` | 999px | 不变 |
| `--om-space-1` … `--om-space-8` | 4 / 8 / 12 / 16 / 20 / 24 / 32 | 3 / 6 / 8 / 10 / 12 / 16 / 20 |
| `--om-sidebar-w` | 250px | 不变 |
| `--om-sidebar-w-rail` | 76px | 不变 |
| `--om-topbar-h` | 64px | 56px |
| `--om-bottom-nav-h` | `0px` | 保留以免旧 calc 失效，**不要再启用底栏** |
| `--om-safe-top` | `env(safe-area-inset-top, 0px)` | |
| `--om-safe-bottom` | `env(safe-area-inset-bottom, 0px)` | |
| `--om-app-h` | `100dvh`（不支持则 `100vh`） | |
| `--om-bp-phone` | 768px | 文档用，实际断点写在 media 里 |
| `--om-bp-tablet` | 1024px | |

圆角口诀：**控件 10 · 卡片 18 · 胶囊 999**。

### 2.5 字体

```css
--om-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
           "Segoe UI", Roboto, "Noto Sans SC", "Helvetica Neue", sans-serif;
--om-font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
```

| 令牌 | 尺寸 | 用途 |
|---|---|---|
| `--om-fs-xs` | 12px | 辅助、chip、日期 |
| `--om-fs-sm` | 13px | 按钮、书签名、次级正文 |
| `--om-fs-md` | 14px | 默认正文、导航、卡片标题 |
| `--om-fs-lg` | 16px | 顶栏标题、弹窗标题 |
| `--om-fs-xl` | 20px | 保险库锁定标题 |
| `--om-fs-2xl` | 26px | 视图大标题 `.vh-title` |

特例（不算进令牌，但要复现气质）：

- 天气温度 `.wx-temp`：52px / weight 250
- 每日单词 `.word`：30px / weight 800
- 监控大数字 `.stat-val`：22px / weight 700
- 行高：正文 `1.55`；数字 `.num` 用 `font-variant-numeric: tabular-nums`
- 代码、密码、音标、快捷键：`--om-font-mono`
- `body` 默认 14px；手机输入框强制 16px

### 2.6 动效

| 令牌 | 值 |
|---|---|
| `--om-ease` | `cubic-bezier(.4, 0, .2, 1)` |
| `--om-t-fast` | `.16s var(--om-ease)` 悬停、按钮、边框 |
| `--om-t-base` | `.28s var(--om-ease)` 主题切换、侧栏、弹层 |

其它固定时长（不做成令牌，但要对齐）：

- 视图切入 `.viewIn`：320ms，上移 8px 淡入
- 环形仪数值：800ms
- 进度条宽度：600ms
- 骨架微光：1600ms
- 启动条滑动：1050ms
- 扩展页内卡片入场：180ms

降低动效时：动画/过渡压到 `0.01ms`，并去掉 `translateY` / `scale` 悬停位移。

### 2.7 HTML 根状态

| 属性 | 值 | 来源 |
|---|---|---|
| `data-theme` | `light` \| `dark` | `om_theme_mode`：`light` / `dark` / `auto`（跟随系统，默认 auto→深色兜底） |
| `data-compact` | `on` \| `off` | `om_layout_compact === '1'` |
| `data-motion` | `off` \| `on` | `om_layout_motion === '1'` 表示降低动效 |

首屏由 `demo/js/theme-boot.js` 在 CSS 之后、正文之前写入，避免闪白。其它项目若有独立 HTML，必须有同等的同步脚本（不能等异步设置接口回来再涂主题）。

### 2.8 推荐拷贝块（新项目最小可运行令牌）

把下面整段放到目标项目的全局 CSS 最前，即可先统一颜色与圆角，再逐步迁组件类名：

```css
:root{
  --om-hue: 243; --om-sat: 72%;
  --om-primary: hsl(var(--om-hue) var(--om-sat) 60%);
  --om-primary-strong: hsl(var(--om-hue) var(--om-sat) 52%);
  --om-on-primary: #ffffff;
  --om-success: #10b981; --om-warning: #f59e0b;
  --om-danger: #f43f5e; --om-info: #38bdf8;
  --om-success-soft: color-mix(in oklab, var(--om-success) 15%, transparent);
  --om-warning-soft: color-mix(in oklab, var(--om-warning) 15%, transparent);
  --om-danger-soft:  color-mix(in oklab, var(--om-danger) 15%, transparent);
  --om-info-soft:    color-mix(in oklab, var(--om-info) 15%, transparent);
  --om-radius-xs: 6px; --om-radius-sm: 10px;
  --om-radius-md: 14px; --om-radius-lg: 18px; --om-radius-pill: 999px;
  --om-space-1: 4px; --om-space-2: 8px; --om-space-3: 12px;
  --om-space-4: 16px; --om-space-5: 20px; --om-space-6: 24px; --om-space-8: 32px;
  --om-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
             "Segoe UI", Roboto, "Noto Sans SC", "Helvetica Neue", sans-serif;
  --om-font-mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
  --om-fs-xs: 12px; --om-fs-sm: 13px; --om-fs-md: 14px;
  --om-fs-lg: 16px; --om-fs-xl: 20px; --om-fs-2xl: 26px;
  --om-ease: cubic-bezier(.4, 0, .2, 1);
  --om-t-fast: .16s var(--om-ease); --om-t-base: .28s var(--om-ease);
  --om-app-h: 100vh; --om-safe-top: env(safe-area-inset-top, 0px);
  --om-safe-bottom: env(safe-area-inset-bottom, 0px);
}
@supports (height: 100dvh){ :root{ --om-app-h: 100dvh; } }
:root, [data-theme="dark"]{
  color-scheme: dark;
  --om-bg: #0c0f15; --om-surface: #141824;
  --om-surface-2: #1a2030; --om-surface-3: #232b3e;
  --om-border: rgba(255,255,255,.07); --om-border-strong: rgba(255,255,255,.15);
  --om-text-1: #edf0f7; --om-text-2: #9aa3b8; --om-text-3: #5f6880;
  --om-primary-soft: color-mix(in oklab, var(--om-primary) 16%, var(--om-surface));
  --om-primary-ghost: color-mix(in oklab, var(--om-primary) 14%, transparent);
  --om-primary-border: color-mix(in oklab, var(--om-primary) 40%, var(--om-border));
  --om-shadow-sm: 0 1px 2px rgba(0,0,0,.35);
  --om-shadow-md: 0 2px 6px rgba(0,0,0,.35), 0 12px 32px -16px rgba(0,0,0,.55);
  --om-shadow-lg: 0 8px 24px rgba(0,0,0,.45), 0 24px 64px -24px rgba(0,0,0,.6);
}
[data-theme="light"]{
  color-scheme: light;
  --om-primary: hsl(var(--om-hue) var(--om-sat) 54%);
  --om-bg: #f3f5fa; --om-surface: #ffffff;
  --om-surface-2: #f3f5fb; --om-surface-3: #e9edf6;
  --om-border: #e4e8f1; --om-border-strong: #d0d7e6;
  --om-text-1: #171c2b; --om-text-2: #5c6579; --om-text-3: #9aa2b5;
  --om-primary-soft: color-mix(in oklab, var(--om-primary) 9%, var(--om-surface));
  --om-primary-ghost: color-mix(in oklab, var(--om-primary) 11%, transparent);
  --om-primary-border: color-mix(in oklab, var(--om-primary) 35%, var(--om-border));
  --om-shadow-sm: 0 1px 2px rgba(16,24,40,.05);
  --om-shadow-md: 0 2px 6px rgba(16,24,40,.05), 0 14px 34px -18px rgba(16,24,40,.16);
  --om-shadow-lg: 0 8px 24px rgba(16,24,40,.08), 0 28px 64px -28px rgba(16,24,40,.22);
}
```

不支持 `color-mix()` 的极旧内核：用固定降级色（深色 ghost `#2a2d4a`，浅色 ghost `#e8eaf7`），但本仓库目标环境可依赖 `color-mix` + `oklab`。

---

## 3. 组件清单及使用规范

类名全部短横线，无 BEM 双下划线。变体用附加类（`.btn.btn-primary`），状态用 `.on` / `.active` / `.open` / `.show`。

### 3.1 基础控件

#### 按钮 `.btn`

| 变体 | 类 | 视觉 |
|---|---|---|
| 主按钮 | `.btn-primary` | 主色实底 + 主色投影；悬停 `--om-primary-strong` |
| 描边 | `.btn-outline` | 透明底 + strong 边；悬停主色字与 ghost 底 |
| 幽灵 | `.btn-ghost` | 无边；悬停 surface-2 |
| 危险幽灵 | `.btn-danger-ghost` | 危险字；悬停 danger-soft |
| 危险描边 | `.btn-outline-danger` | 危险边；悬停危险实底白字 |
| 尺寸 | `.btn-sm` 30px / 默认 36px / `.btn-lg` 42px | |
| 禁用 | `:disabled` | `opacity:.5; cursor:not-allowed` |
| 按下 | `:active` | `scale(.97)` |

图标 15px，与文字 gap 7px。手机主路径按钮 `min-height: 40–44px`。

**不要**：主按钮再套一层紫粉渐变；扩展现状的 `.btn.primary{ linear-gradient(#a855f7,#6366f1) }` 应改为实色主色。

#### 图标按钮 `.icon-btn` / `.icon-btn-xs`

- 默认 36×36，圆角 sm，透明底；悬停 surface-2
- 通知红点：`.has-dot::after`（7px 圆，danger，2px 底色描边）
- 超小：28×28，用于日历翻月、复制/刷新
- 手机顶栏：强制 44×44

#### 输入 `.input` / `.input-wrap`

- 高 38px，左右 14px，圆角 sm，strong 边
- 聚焦：主色边 + `0 0 0 3px ghost`
- 前置图标：`.input-wrap` 内绝对定位，input `padding-left: 36px`
- 占位色：`--om-text-3`

#### 开关 `.switch`

- 门户：40×23，滑块 17px，打开后 `translateX(17px)`，开态背景 **主色实底**（不是渐变）
- 扩展现状：36×20 + 紫粉渐变 → 应对齐门户尺寸与实色
- 状态类：`.on`；禁用 `.switch:disabled` 或外包 `.switch-hit.locked`

#### 复选 `.checkbox`

隐藏原生 input，用 `.box` 17×17 圆角 5px。勾选后主色底 + 白勾。

#### 分段 `.seg` / `.seg-btn`

浅槽 + 内边 3px。选中项 `.active`：surface 底 + sm 阴影。用于明暗模式、编辑/分屏/预览、界面密度。

#### 标签页 `.tabs` / `.tab`

与分段同族（浅槽）。`.tab.active` 加粗 600。分类 tab 可拖（`cursor:grab`）。悬浮露出 `.tab-ops`（重命名/删除）。虚线 `.tab-add` 表示新建。

#### 状态胶囊 `.chip`

高 22px，左右 10px，字 11px/600。默认带 6px 圆点（`.no-dot` 去掉）。语义：`.success` `.warning` `.danger` `.info` `.primary`。

#### 头像 `.avatar`

34 默认 / `.sm` 28 / `.lg` 44。主色渐变圆。`.online::after` 成功色点。多用户可用 `.alt` / `.alt2` 换渐变，避免所有人头像同色。

#### 键盘提示 `.kbd`

等宽 11px，6px 圆角，surface-2 底。手机搜索里隐藏。

### 3.2 容器与反馈

#### 卡片 `.card`

结构：

```
article.card[.lift][.col-n]
  .card-head
    h3.card-title > svg.ic + 标题
    .chip?
    button.card-link?     /* margin-left:auto */
  .card-pad
```

- 静态：surface + 1px border + shadow-sm + radius-lg
- `.lift:hover`：上移 2px + shadow-md + border-strong
- 仪表盘卡片可带 `data-widget`

#### 空状态 `.empty`

`.empty-ic`（56 虚线圆）+ `.empty-title` + `.empty-sub`（max 260px）+ 可选 `.btn`。

#### 骨架 `.sk`

surface-3 底 + 微光扫过。组合：`.sk-line.w40|w60|w80`、`.sk-circle`、`.sk-block`。

#### Toast `.toast`

底栏居中胶囊，**反色**：文字色当底、页面底当字。`.show` 上移显现。错误 `.toast.err` 用危险色字。z-index 200。扩展 toast 目前是深色实底，应对齐为反色胶囊或至少用同一套成功/危险语义。

#### 下拉 `.menu` / `.drop-panel` / `.search-pop`

圆角 md，shadow-lg，默认隐藏（opacity + translateY）。`.open` 或 `:focus-within` 打开。菜单项悬停 surface-2；危险项悬停 danger-soft。

### 3.3 弹层

| 组件 | 选择器 | 规格 |
|---|---|---|
| 遮罩 | `.modal-mask` | `rgba(5,8,15,.55)` + blur(4px)；`.open` 显示 |
| 标准弹窗 | `.modal` | `min(420px, 92vw)`，入场 scale(.96) 上移 8px |
| 结构 | `.m-head` / `.m-body` / `.m-foot` | 脚栏右对齐：取消幽灵 + 确认主按钮 |
| 设置中心 | `.modal-settings` | `min(1040px,94vw) × min(680px,88vh)`，内 `.set-layout` 216px + 主区 |
| 确认框 | `#confirmMask` | z-index **260**，必须压过其它弹层 |
| 分享阅读 | `#kbShareViewMask` | z-index 180，高于登录页 150 |
| 灯箱 | `.asset-lightbox` | 200，暗 78% |
| 启动遮罩 | `.boot-splash` | 300，主色滑动条；8s 兜底消失 |

设置分区：`.set-item[data-setpanel]` + 目标面板 `hidden` 切换。`.set-row` = 左文案（label + sub）+ 右控件。危险操作进 `.set-card-danger`（危险色混入描边）。

关闭约定：关闭钮 / 取消 / 点遮罩 / Esc。保存成功后关窗 + Toast。

### 3.4 导航壳

| 件 | 类 | 要点 |
|---|---|---|
| 应用栅格 | `.app` | `sidebar-w + 1fr`；折叠改 `sidebar-w-rail` |
| 侧栏 | `.sidebar` | sticky 满高；分组 `.nav-group` > `.nav-title` + `.nav-item` |
| 当前项 | `.nav-item.active` | ghost 底 + 主色字 600 + 左侧 3×18 主色条 |
| 用户卡片 | `.user-chip` | 悬停上浮 2px、头像放大、箭头翻转；点击打开设置 |
| 顶栏 | `.topbar` | 64px，blur(14px)，折叠钮 + 标题 + 搜索 + 主题/铃铛/头像 |
| 内容 | `.content` | max-width 1400px，水平 space-6 |
| 视图 | `.view` / `.view.active` | hash 路由 `#/notes` 等 |
| 页头 | `.view-head` > `.vh-title` + `.vh-sub` + `.vh-actions` | |

Logo：`.logo-mark` 34px、圆角 11px、主色渐变 + 主色投影；`.logo-name` 15/700；`.logo-sub` 10px 字距 .8px。

### 3.5 业务组件（门户特有，扩展按需裁剪）

| 组件 | 关键类 | 对接要点 |
|---|---|---|
| 全局搜索 | `.searchbar` `.search-field` `.engine-chip` | 胶囊输入 40px；聚焦 4px ghost；引擎 chips |
| 天气 | `.wx-temp` `.wx-strip` `.wx-day.today` | 大号细体温度；「今天」主色浅底 |
| 环形仪 | `.gauge` `.g-val.ok\|warn\|bad` | SVG dasharray；阈值色见 2.2 |
| 进度条 | `.bar` `.bar-fill` | 高 6px |
| 书签磁贴 | `.bm-tile` `.bm-fav` `--fav` | 字母 favicon 用 hue 变量；悬停上浮 + 显手柄 |
| 书签大卡 | `.bm-card` | 快捷导航页；多选 `.sel`、批量条 `.bm-batch` |
| 保险库 | `.vault-wrap` `.lock-panel` `.strength` | 锁定 blur(7px)；强度 4 段语义色 |
| 日历 | `.cal-day.today` `.has-event` | 今日主色实底；有事件底部圆点 |
| 计划 | `.pl-line.done` | 完成删除线 + 成功色勾 |
| 单词 | `.word` `.phon` `.pos` `.ex` | 主色左边线引用块 |
| 编辑器 | `.editor` `.ed-bar` `.ed-body` `.ed-foot` | 底栏不可被 overflow 裁掉 |
| 知识库 | `.kb-layout` 240 + 1fr + auto | 手机改为列表/编辑两级 |
| 工具磁贴 | `.tool-tile` | 未上线半透明 + 角标 |
| 色板 | `.swatch.on` | 选中双环 + ✓ |

### 3.6 图标

门户：`demo/views/icons.html` 内联 SVG sprite，`<svg class="ic"><use href="#i-xxx"/></svg>`。

- `.ic`：18px，`stroke: currentColor`，宽 1.8，round cap/join
- `.ic-fill`：Logo 等填充图标
- 命名：`i-` + 短英文（`i-home` `i-bookmark` `i-shield` `i-gear` …）

扩展 popup 可内联同样 24 视口的 path，不要换成 emoji 当主图标（收藏按钮上的 ⭐ / ✨ 是现有文案，新项目优先 SVG）。

### 3.7 状态与 z-index

从低到高（门户）：

| 层 | z | 场景 |
|---|---|---|
| 卡片内部控件 | 2–8 | 勾选、拖拽柄、布局编辑钮 |
| 顶栏 | 30 | `.topbar` |
| 手机搜索展开 | 35 | |
| 侧栏（桌面） | 40 | |
| 搜索下拉 | 50 | |
| 菜单 / 下拉面板 | 60 | |
| 天气弹出 | 70 | |
| 大纲底板（手机） | 75 | |
| 抽屉遮罩 / 批量条 | 80 | `.nav-scrim` `.bm-batch` |
| 手机侧栏抽屉 | 90 | |
| 普通 modal | 100 | |
| 知识库菜单 | 120 | |
| 登录页 | 150 | `.auth-page` |
| 分享层 | 180 | |
| 分享页大纲（手机） | 190 | |
| Toast / 灯箱 | 200 | |
| 确认框 | 260 | 必须最高业务层之一 |
| 启动遮罩 | 300 | |
| 扩展页内卡片 | 2147483647 | Shadow DOM，压过任意宿主页 |

### 3.8 无障碍与触控

- 可点热区手机 ≥44px（`.nav-item`、`.icon-btn`、`.ed-btn`、设置 `.set-item`）
- 开关、分段用按钮，不只靠颜色
- 拖拽同时提供点击/菜单替代（删除、排序）
- `prefers-reduced-motion` 与设置开关双通道

---

## 4. 页面布局与响应式规则

### 4.1 门户骨架

```
PC ≥1024                         769–1024                      ≤768
┌────────┬─────────────────┐    ┌────┬─────────────────┐    ┌──────────────────┐
│ 250 侧栏│ 顶栏 64          │    │76  │ 顶栏             │    │ 顶栏 汉堡+标题+图标 │
│        ├─────────────────┤    │图标 ├─────────────────┤    ├──────────────────┤
│ 分组导航 │ content ≤1400   │    │栏  │ content          │    │ 单列内容          │
│        │ 12 列网格        │    │    │ 跨列重排          │    │ 抽屉侧栏（默认关）  │
│ 用户卡  │                 │    │    │                 │    │ 无底栏            │
└────────┴─────────────────┘    └────┴─────────────────┘    └──────────────────┘
```

### 4.2 断点（唯一标准）

| 视口 | 行为 |
|---|---|
| **≥1281px** | 完整侧栏 250px；卡片按 `col-2…col-12` 设计跨列 |
| **≤1280px** | `.col-8`→12，`.col-4/.col-3`→6，`.col-2`→4 |
| **≤1024px** | 侧栏自动收为 76px 图标栏（与 `.sidebar-collapsed` 同等视觉）；顶栏日期隐藏 |
| **≤900px** | 设置中心 `.set-layout` 单列，分区菜单横向滑动（组件级，不改导航壳） |
| **≤768px** | Phone Shell：`.app` 单列；侧栏 `position:fixed` 抽屉；`body.nav-open` 滑入；网格全 12 列 |
| **≥769px** | 禁止抽屉、禁止底栏；折叠只变图标栏 |

以 `demo/css/mobile.css` 的 `@media (max-width: 768px)` 与 `body.is-phone` 为准。不要再引入 680 作为导航断点（`DESIGN.md` 旧表已作废）。

### 4.3 12 列网格

```css
.grid12{ display:grid; grid-template-columns:repeat(12,1fr); gap:var(--om-space-5); }
.col-2{ grid-column:span 2; } /* … col-3/4/5/6/8/12 */
```

仪表盘节奏（宽屏）：监控 8 + 日历/单词等 4；快捷导航 12；速记 8 + 计划 4。编辑布局时允许 3–12 列、高度 160px 起按 20px 吸附。

### 4.4 知识库

- **PC**：`.kb-layout` = 树 240px + 编辑器 + 大纲（auto）。树 sticky 在顶栏下方。
- **≤1024**：笔记旧双栏改单列；目录折叠钮隐藏。
- **手机**：`body.kb-phone-list` 只显示树；`body.kb-phone-editor` 只显示编辑器。大纲改为底部 sheet（高 min(50dvh, 420px)）。分屏模式隐藏。`.ed-body{ min-height:0 }`，`.ed-foot` 不收缩。
- 分享页同样两级：`body.share-phone-editor`。

### 4.5 手机导航

- 入口：`#collapseBtn` 内 `.collapse-phone`（汉堡）；桌面用 `.collapse-desktop`
- 打开：`body.nav-open` + `.nav-scrim`
- 设置/退出：侧栏用户卡或顶栏头像菜单
- 搜索：`#searchToggle` 把 `.searchbar` 铺满顶栏；`body.search-open`

### 4.6 安全区与高度

- 高度只用 `var(--om-app-h)`，不要裸 `100vh` 当手机全屏
- 顶栏：`height: calc(var(--om-topbar-h) + var(--om-safe-top))`
- 内容底：`padding-bottom: calc(var(--om-space-4) + var(--om-safe-bottom))`
- 抽屉 padding 含 safe-top / safe-bottom

### 4.7 扩展 popup 布局（目标形态）

扩展不是门户缩小版：

- 宽 **384px**（当前实现），内边距 16，纵向 gap 14
- 结构：品牌头 → 登录卡 **或** 用户卡 + 功能卡 + 页脚
- 卡片圆角改用 `--om-radius-lg`（18，现为 13，应上调或至少 14）
- 不引入侧栏、12 列网格、顶栏搜索
- 明暗跟随 `prefers-color-scheme`，有条件时读取门户已存的 hue（后续）

### 4.8 Obsidian 插件布局（目标形态）

- **不要**自绘应用壳。设置页继续用 `PluginSettingTab` + Setting API
- 只对自定义块（帮助说明、同步日志、信息行、确认副文）套令牌映射
- 状态栏指示器一行文字 + 语义色，不插卡片
- 移动端 Obsidian 同样走宿主布局；自定义 log 区 `max-height: 220px` 内部滚动

### 4.9 验收视口

改任何用户可见界面，至少：

- 手机 375×667 或 390×844（≤768）
- PC 1280×800 或更大

检查：侧栏开合、仪表盘主路径、笔记编辑底栏是否在视口内、设置弹窗分区、扩展 popup 登录/已登录两态。

---

## 5. 目录结构与命名约定

### 5.1 门户（源）

```
demo/
├── index.html                 # 壳：侧栏 + 顶栏 + 视图挂载点
├── views/
│   ├── icons.html             # SVG sprite（服务端注入）
│   ├── dashboard.html
│   ├── monitor.html
│   ├── bookmarks.html
│   ├── vault.html
│   ├── notes.html
│   ├── toolbox.html
│   ├── overlays.html
│   └── overlays-settings.html
├── css/
│   ├── theme.css              # 令牌 + 重置 + 紧凑密度
│   ├── layout.css             # 壳 + 网格 + 断点 + 动效开关
│   ├── mobile.css             # 仅 ≤768 与粗指针叠加
│   ├── components.css         # 聚合 @import（生产 index 直接链各文件）
│   └── components/
│       ├── base.css           # 卡/钮/输入/chip/头像/菜单/搜索
│       ├── weather.css
│       ├── monitor.css
│       ├── widgets.css        # 单词/书签/保险库/日历…
│       ├── notes.css
│       ├── toolbox.css        # 开关/分段/色板/滑杆
│       ├── overlays.css       # 弹层/空态/骨架/Toast/设置
│       ├── kb.css             # 知识库 + 登录页
│       └── pages.css          # 书签大卡/保险库页/关于等
└── js/
    ├── theme-boot.js          # 同步主题，防闪白
    ├── boot.js                # ESM 入口
    └── …
```

静态 URL 带 `?v=__VER__`，由 `backend/app_version.py` 的 `VERSION` 注入。

### 5.2 浏览器扩展

```
extension/
├── popup.html / popup.css / popup.js
├── content.js                 # 页内保存卡，Shadow DOM + CARD_CSS
├── content-hook.js
├── background.js / api.js
└── manifest.json
```

### 5.3 Obsidian 插件

```
obsidian-plugin/omnihome-sync/
├── main.js
├── styles.css                 # 全部 omnihome-sync- 前缀
├── manifest.json
└── README.md
```

### 5.4 新项目建议结构

独立产品（例如账鹅）不要把门户 `components/*.css` 整包拷进去。建议：

```
<app>/
  css/
    om-tokens.css              # 第 2.8 节拷贝，可按产品改默认 hue
    om-base.css                # 仅基础控件：btn/input/chip/card/modal/toast/switch/seg
    app-layout.css             # 本产品自己的壳
    app-pages.css              # 业务
  js/
    theme-boot.js              # 同构的 data-theme 写入
```

门户继续作为令牌原件；其它仓库用复制 + 对照表，而不是 submodule 强行共享构建（当前无打包器）。

### 5.5 命名约定

| 类别 | 规则 | 例 |
|---|---|---|
| CSS 变量 | `--om-` + 语义 | `--om-text-2` |
| 布局类 | 短词 | `.app` `.sidebar` `.topbar` `.content` |
| 控件 | 短词 + 变体 | `.btn` `.btn-primary` `.icon-btn-xs` |
| 状态 | 形容词 / 缩写 | `.active` `.open` `.on` `.show` `.sel` `.err` |
| 业务前缀 | 两字母域 | `.bm-` 书签 `.wx-` 天气 `.kb-` 知识库 `.ed-` 编辑器 `.v-` 保险库 `.pl-` 计划 `.ms-` 设置弹窗 `.qk-` 仪表盘速览 |
| 图标 id | `i-` + 短名 | `i-bookmark` |
| JS data 属性 | `data-*` 行为钩子 | `data-nav` `data-open-settings` `data-widget` `data-hue` |
| localStorage | `om_` 前缀 | `om_theme_mode` `om_layout_compact` |
| 扩展宿主 | 固定 id | `#omni-ext-host` |
| 插件 CSS | `omnihome-sync-` | `.omnihome-sync-chip` |
| 文件 | 小写短横线 | `overlays-settings.html` |
| 禁止 | BEM 双下划线、驼峰类名、无前缀的插件全局 `.modal` | |

ID：页面唯一控件用驼峰 id（`#collapseBtn` `#globalSearch`），与历史代码一致；**新代码优先 data 属性**，减少 id 耦合。

---

## 6. 样式隔离方案

多项目同屏出现的场景：用户在门户里打开 Obsidian（或反过来）、扩展向任意网站注入保存卡、扩展 popup 与门户主题并存。隔离策略按宿主分成三档。

### 6.1 门户：全局令牌，无 Shadow

- 令牌挂在 `:root` / `html[data-theme]`
- 类名短且无命名空间（历史原因）。**新的第三方项目不要直接复用无前缀 `.btn`，除非整页都是万事屋壳**
- `[hidden]{ display:none !important }` 必须保留
- 第三方库（marked / purify）只负责 HTML，皮肤由 `.livemd` 等前缀类接管

### 6.2 浏览器扩展 popup：独立文档

popup 是独立 HTML，与当前页 CSS 天然隔离。

**要对齐的是令牌值，不是选择器。** 建议：

1. `popup.css` 的 `:root` 改为第 2.8 节 `--om-*` 令牌
2. 现有 `--bg` / `--panel` / `--primary` 改成别名：

```css
:root{
  /* 先引入 --om-* ，再： */
  --bg: var(--om-bg);
  --panel: var(--om-surface);
  --panel-2: var(--om-surface-2);
  --line: var(--om-border);
  --text: var(--om-text-1);
  --text-2: var(--om-text-2);
  --text-3: var(--om-text-3);
  --primary: var(--om-primary);
  --ok: var(--om-success);
  --err: var(--om-danger);
  --warn: var(--om-warning);
}
```

3. 删掉 `--primary-2: #6366f1` 双色渐变；主按钮改 `.btn-primary` 语义
4. 支持 `prefers-color-scheme: light` 时切 `data-theme="light"`

类名可暂时保留 `.card-block` `.btn.primary`，用别名过渡；新写的控件直接用门户类名。

### 6.3 扩展页内卡片：Closed Shadow DOM（必须）

`content.js` 已用 `attachShadow({ mode: 'closed' })` + `:host { all: initial; }`。这是正确隔离，保留。

要对齐的是 **Shadow 内部令牌**：把 `CARD_CSS` 里的 `#12141f` / `#a855f7` 换成 `--om-*`（在 `:host` 上定义一套深色令牌即可，宿主页不应泄漏主题；卡片始终用万事屋深色品牌，避免跟黄底新闻站走浅色）。

宿主冲突防护：

- 根节点 id 固定 `#omni-ext-host`
- 不把样式插到 `document.head`
- z-index 用最大值，保证压过站点顶栏
- 动画名带 `omni-` 前缀（已有 `omni-in`）

### 6.4 Obsidian 插件：前缀 + 宿主变量映射

Obsidian 主题已经占用 `--background-primary`、`--text-normal`、`--text-accent` 等。插件 **禁止覆盖** 这些全局变量。

正确做法：

```css
.omnihome-sync-help,
.omnihome-sync-log,
.omnihome-sync-banner,
.omnihome-sync-info{
  --om-surface: var(--background-secondary);
  --om-border: var(--background-modifier-border);
  --om-text-1: var(--text-normal);
  --om-text-2: var(--text-muted);
  --om-text-3: var(--text-faint);
  --om-primary: var(--text-accent);
  --om-success: var(--text-success, #10b981);
  --om-danger: var(--text-error, #f43f5e);
  --om-radius-sm: 10px;
}
```

自定义 UI 只用 `omnihome-sync-` 前缀类。确认弹窗尽量用 `Modal` API，副文用 `.omnihome-sync-confirm-sub`，按钮仍走宿主 `.mod-cta` / `.mod-warning`，但主 CTA 颜色会随用户 Obsidian 主题走——这是有意的：插件是「住在别人家里」，品牌靠状态栏文案「万事屋」和 chip 语义，而不是强行靛蓝覆盖用户主题。

若未来做自定义侧栏视图，根节点加 `.omnihome-sync-root`，令牌只挂在该根上。

### 6.5 新项目（独立 SPA / 多页）

| 策略 | 何时用 |
|---|---|
| 全局 `--om-*` + 门户短类名 | 整站就是万事屋家族产品，视觉要「同一个站」 |
| `--om-*` 令牌 + 本产品前缀类（如 `.gc-btn`） | 产品名不同、需要品牌识别，但色板一致 |
| Shadow DOM / iframe | 嵌入第三方页、浏览器插件、小部件 |

推荐独立产品：**令牌共享、类名前缀自有**。对照表写清 `.btn-primary` ↔ `.gc-btn-primary`。

### 6.6 加载顺序

门户：`theme.css` → `layout.css` → `components/*.css` → `mobile.css` → `theme-boot.js`。

其它项目同样：**令牌最先、重置其次、组件、最后才是断点叠加**。禁止在组件文件里重新定义 `--om-primary` 硬编码色。

### 6.7 与宿主冲突检查清单

接入后用浏览器审查：

1. 目标页的 `h1/button/input` 是否被我们的重置误伤（插件尤其危险）
2. `[hidden]` 是否仍生效
3. 深浅色切换是否只改表面、不把语义色（成功/危险）一起反相
4. 扩展卡片在浅色新闻站上是否仍是万事屋深色卡（预期：是）
5. Obsidian 换社区主题后，插件设置页是否仍可读（预期：跟随宿主，不要碎版）

---

## 7. 两项目间 UI 元素映射对照表

「项目 A」= 万事屋门户 `demo/`（源）。  
「项目 B」分两列：浏览器扩展、Obsidian 同步插件。  
「适配动作」是为了统一视觉应做的改动；`保持` 表示刻意不统一。

### 7.1 令牌与基础视觉

| 门户令牌 / 值 | 扩展现状 (`popup.css` / `CARD_CSS`) | Obsidian 现状 (`styles.css`) | 适配动作 |
|---|---|---|---|
| `--om-bg` `#0c0f15` | `--bg` `#0f1118` | 跟随 `--background-primary` | 扩展改为 `--om-bg`；插件保持宿主底，自定义块用 secondary |
| `--om-surface` `#141824` | `--panel` `#171a26` | `--background-secondary-alt` | 扩展对齐 surface；插件映射 secondary |
| `--om-surface-2` `#1a2030` | `--panel-2` `#1e2233` | `--background-secondary` | 扩展改别名 |
| `--om-border` `rgba(255,255,255,.07)` | `--line` `.08` | `--background-modifier-border` | 扩展改 `.07`；插件保持宿主边 |
| `--om-text-1` `#edf0f7` | `--text` `#e8e9f1` | `--text-normal` | 扩展对齐 `#edf0f7` |
| `--om-text-2` `#9aa3b8` | `--text-2` `#a7abc0` | `--text-muted` | 扩展对齐 |
| `--om-text-3` `#5f6880` | `--text-3` `#70748c` | `--text-faint` | 扩展对齐 |
| `--om-primary` 靛蓝 HSL 243 | `--primary` `#a855f7` + `--primary-2` `#6366f1` | `--text-accent`（用户主题） | **扩展必须改靛蓝令牌，去掉双色渐变**；插件 CTA 跟随 accent |
| `--om-success` `#10b981` | `--ok` `#10b981` | `--text-success` 或 `#4caf50` | 插件 fallback 改为 `#10b981` |
| `--om-danger` `#f43f5e` | `--err` `#f87171` | `--text-error` 或 `#e5534b` | 扩展改 `#f43f5e`；插件 fallback 对齐 |
| `--om-warning` `#f59e0b` | `--warn` `#fbbf24` | （无统一） | 扩展改 `#f59e0b` |
| `--om-radius-sm` 10px | 输入/按钮 9px | 帮助块 8px | 统一 10px |
| `--om-radius-lg` 18px | 卡 13px / 弹窗 14px | 8px | 扩展卡 ≥14px，弹窗 18px；插件自定义块 10px 即可 |
| `--om-font` 系统栈含 PingFang | 无 SF Pro / Noto | 宿主字体 | 扩展补全字体栈 |
| `--om-fs-md` 14px | body 13px | 宿主 | 扩展正文可维持 13px（窄弹窗），标题 14px |
| `--om-t-fast` 160ms | hover 无统一时长 / 开关 150ms / 卡片 180ms | 120ms | 扩展改 160ms；插件 160ms |
| `--om-ease` | `ease` / `ease-out` | `ease` | 统一 cubic-bezier(.4,0,.2,1) |
| 浅色主题 | 无 | 跟随 Obsidian | 扩展补 `prefers-color-scheme`；插件保持 |
| 用户色相 `--om-hue` | 写死紫 | 无 | 扩展可先锁默认 243；后续读门户设置 |

### 7.2 组件对照

| 门户组件 | 扩展对应 | Obsidian 对应 | 适配动作 |
|---|---|---|---|
| `.logo-mark` + `#i-logo` | `.logo` 字母 O + 紫粉渐变 | 无（用设置页标题） | 扩展渐变改 primary→primary-strong；有空间则换星形 logo |
| `.btn-primary` 实色 | `.btn.primary` 渐变 | 宿主 `mod-cta` | 扩展去渐变；插件保持宿主按钮 |
| `.btn-ghost` / `.btn-outline` | `.btn.ghost` 白 7% 底 | 宿主默认钮 | 扩展 ghost 用 surface-2；描边用 border-strong |
| `.btn-danger`（扩展独有渐变红） | `.btn.danger` `#ef4444→#dc2626` | `mod-warning` | 扩展改为 danger 实底 `#f43f5e` |
| `.icon-btn` 36 | `.icon-btn` 30 | 无 | 扩展可维持 30（弹窗紧凑），热区尽量 32+ |
| `.input` 高 38、聚焦 3px 光环 | input 9px 内边距，聚焦只改边色 | Setting text input | 扩展补 `box-shadow: 0 0 0 3px ghost` |
| `.switch` 40×23 主色实底 | `.switch` 36×20 渐变 | Setting toggle | 扩展对齐比例与实色 |
| `.chip.success` 等 | `.chip.ok/.err/.warn` | `.omnihome-sync-chip.kind-*` | 语义色对齐 7.1；圆角 999 |
| `.card` 18 圆角 + lift | `.card-block` / `#loginPanel` 13 圆角 | `.omnihome-sync-help` 8 圆角卡片 | 扩展圆角上调；插件保持小卡片 |
| `.user-chip` / `.avatar` | `.user-card` / `.avatar` 38px 紫粉渐变 | 无 | 头像改主色渐变；结构已接近，保留 |
| `.modal-mask` + `.modal` | `.modal` 全屏 72% 黑 + blur(3px) | `Modal` API | 扩展遮罩改为 `.55` + blur(4px)；卡圆角 18 |
| `.toast` 反色胶囊 | `.toast` 深底 `#232636` | `Notice` API | 扩展改为反色胶囊 + `.show` 动画；插件用 Notice |
| `.empty` | 无 | 无 | 扩展空同步态可用 chip+说明，不必上完整 empty |
| `.boot-splash` | 无（popup 太快） | 无 | 保持 |
| `.searchbar` | 无 | 无 | 保持（弹窗不做全局搜索） |
| `.nav-item.active` 左色条 | 无侧栏 | 功能区图标状态 | 插件状态栏 `mod-syncing` 用 accent；`mod-error` 用 danger |
| `.sec-banner` 成功浅底 | 无 | `.omnihome-sync-banner` 目前是错误红条 | 成功提示用 success-soft；错误条保持 danger，色值对齐 |
| 书签 `.bm-tag` | `.tag` 紫边芯片 | `.omnihome-sync-chip` | 扩展 tag 改 primary-ghost + primary 字，不要写死 `#c4b5fd` |
| 设置 `.set-row` | `.row-line` | Setting 一行 | 扩展 row-line 已接近；间距改 space-3 |
| 登录 `.auth-card` | `#loginPanel` | 设置里填 URL + API Key | 扩展登录卡按 auth-card 的圆角/内边距靠拢（16–20px） |
| 确认删除 | `#confirmMask` | `.omnihome-sync-confirm-*` | 文案层级：标题 + muted 副文 + 右对齐钮，已接近 |
| 同步日志 | 设置关于 / applog | `.omnihome-sync-log` | 等宽数字时间戳、虚线分隔、错误行 danger 色——保持结构，色代币化 |
| 页内保存卡 | `CARD_CSS` `.card` | 无 | 令牌化；Logo 与主按钮去紫粉；成功态用 success-soft |

### 7.3 交互对照

| 行为 | 门户 | 扩展 | 插件 | 统一口径 |
|---|---|---|---|---|
| 主操作 | 实色主按钮，按下 scale .97 | 渐变主按钮，`:hover` brightness | 宿主 CTA | 按下反馈统一 scale .97；悬停不要 brightness(1.15) |
| 危险操作 | 二次确认 + 危险按钮 | `.modal` + `.btn.danger` | `Modal` + 确认 | 必须二次确认；文案说明不可逆 |
| 开关 | `.on` 类 | `.on` 类 | Setting toggle 值 | 开态=主色（扩展）或宿主 accent（插件） |
| 加载 | 钮内 `.spin` / 骨架 | `.spin` 12px | 状态栏 `mod-syncing` 旋转 | 保留；旋转时长 ~700–900ms |
| 成功反馈 | Toast 反色 | Toast 深底 / 卡片 `.done` | Notice | 短文案；成功色勾 |
| 失败反馈 | Toast.err / `.err` 浅红条 | `.err` / `.toast.err` | `mod-error` + banner | 浅底 + 危险字 + 1px 危险边 |
| 主题 | 设置即时预览 | 无 | 跟随 Obsidian | 扩展至少跟随系统深浅 |
| 导航 | 侧栏 / 手机抽屉 | 无 | 功能区菜单 | 保持各宿主导航；不要在插件里做门户侧栏 |
| 动效关闭 | `data-motion` + 系统 | 无 | 宿主 | 扩展可听 `prefers-reduced-motion` |

### 7.4 布局对照

| 结构 | 门户 | 扩展 | 插件 |
|---|---|---|---|
| 应用壳 | `.app` 双栏 | 384 单列 wrap | Obsidian 设置页 |
| 顶栏 | 有 | 品牌头 `.head` | 无 |
| 网格 | `.grid12` | 无，纵向 flex gap 14 | 无 |
| 断点 | 768 / 1024 / 1280 | 无（固定宽） | 宿主移动端 |
| 安全区 | `--om-safe-*` | 不需要 | 宿主处理 |
| 手机策略 | 抽屉侧栏，无底栏 | N/A | N/A |

### 7.5 新项目接入空表（复制后填）

把下表贴进目标仓库，逐行填「目标现状」和「适配后」。

| 门户元素 | 目标现状 | 适配后类名 / 变量 | 备注 |
|---|---|---|---|
| `--om-hue` / `--om-primary` | | | 默认 243，除非产品有独立品牌色相 |
| `--om-bg` / `--om-surface` / `--om-text-1/2/3` | | | |
| `--om-radius-sm/lg/pill` | | | 10 / 18 / 999 |
| `.btn-primary` `.btn-outline` `.btn-ghost` | | | |
| `.input` 聚焦光环 | | | |
| `.switch` `.seg` `.chip` | | | |
| `.card` `.card-head` `.card-pad` | | | |
| `.modal-mask` `.toast` `.empty` | | | |
| 字体栈与 14px 正文 | | | |
| 160ms / 280ms 缓动 | | | |
| 深浅色 `data-theme` | | | |
| ≤768 导航策略 | | | 独立产品可自定壳，但触控与安全区要遵守 |
| 样式隔离方式 | | | 全局 / 前缀 / Shadow |

独立产品若需要**自己的品牌色**（例如账鹅）：只改默认 `--om-hue`（或另设 `--om-hue: …` 文档化），**不要改表面灰阶、圆角、字号阶梯、按钮高度**。家族识别靠「同一套灰与节奏」，品牌识别靠色相。

---

## 8. 落地顺序（给适配实施用）

不必一次改完。推荐批次：

1. **令牌换心**：扩展 `popup.css`、`CARD_CSS` 接 `--om-*` 别名；去掉紫粉硬编码。
2. **控件皮肤**：主按钮实色、开关尺寸、输入焦点环、chip / tag 色、圆角。
3. **弹层与 Toast**：遮罩透明度、确认框、toast 反色。
4. **浅色模式**：popup 跟随系统。
5. **Obsidian**：fallback 色值对齐；chip / banner / log 用映射变量；动画 160ms。
6. **文档回写**：改完把第 7 章「现状」列更新为「已对齐」，避免对照表腐烂。

门户自身新功能：只加 `components/` 下域文件或扩展现有类，不在 JS 里拼临时色值。

---

## 9. 验收清单

- [ ] 门户深色默认、浅色、五色色板切换时，按钮/导航/焦点环同时变
- [ ] 紧凑密度只缩间距与顶栏，不破坏 44px 手机热区
- [ ] 降低动效后无位移悬停
- [ ] 375 宽：抽屉可开合、笔记底栏可见、无横向滚动
- [ ] 1280 宽：双栏壳 + 仪表盘跨列正常
- [ ] 扩展 popup 主色是靛蓝而非品红紫
- [ ] 扩展页内卡在浅色网站上仍是深色万事屋卡，且不继承站点 `button` 样式
- [ ] Obsidian 换主题后设置页可读；插件选择器均带 `omnihome-sync-`
- [ ] 无新增无前缀全局选择器写进 `obsidian-plugin/**/styles.css`
- [ ] `[hidden]` 在扩展 popup 仍然生效

---

## 10. 变更记录

| 日期 | 说明 |
|---|---|
| 2026-09-18 | 初版：从 `demo/css` 与扩展/插件现状抽取令牌、组件、断点、隔离与映射表 |

后续门户若增减令牌（新语义色、新圆角档），先改 `theme.css`，再改本文件第 2 章与第 7 章同一行。
