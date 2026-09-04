# Obsidian 同步插件 · 服务端 API

> 适用版本：0.2.27 起 · 后端框架：FastAPI · 路由文件：`backend/routes.py`

万事屋门户为 Obsidian 双向同步插件提供一组以**相对路径寻址**的 RESTful API。站点笔记仍存于 storage 抽象层（NAS 上是 PostgreSQL 的 `bm_notes` 表，**不落物理 `.md` 文件**），`path` 是逻辑地址（`文件夹/标题.md`）。每个 API Key 绑定一个**笔记仓库**，只同步该仓库内的普通笔记。

FastAPI 自带 OpenAPI 交互文档：启动服务后访问 **`/docs`**（Swagger UI）或 **`/redoc`**，可在线试调下列所有端点。

---

## 一、鉴权

API 分两类，鉴权方式不同：

| 类别 | 端点 | 鉴权头 | 说明 |
| --- | --- | --- | --- |
| **管理端点** | `/api/sync/apikey`（POST/GET/DELETE） | `Authorization: Bearer <session token>` | 与门户其它接口一致，用登录会话，仅能操作本人 Key |
| **数据端点** | `/api/sync/list`、`/api/sync/file`、`/api/sync/file/rename` | `X-API-Key: <raw key>` | 用长期 API Key 解析出用户名做数据隔离 |

### API Key 机制

- 每用户每个**笔记仓库**一枚长期 API Key，形如 `ohs_` + 43 位随机串（`secrets.token_urlsafe(32)`）。系统内置仓库禁止发令牌。
- 服务端**只存 Key 的 sha256 哈希**（`config.json` 的 `syncKeys`：`{hash: {u, vault, prefix, created}}`）。**明文只在生成时返回一次**。
- **重置**会作废该仓库旧 Key；**吊销**同理。
- 生成入口：门户「设置 → 功能设置 → Obsidian 插件同步」。另有 `GET /api/sync/hello`（插件握手）、`GET/POST /api/sync/log`（同步日志）。

---

## 二、管理端点（session 鉴权）

### 2.1 生成 / 重置 API Key

```
POST /api/sync/apikey
Authorization: Bearer <session token>
```

**响应 200：**
```json
{ "ok": true, "apiKey": "ohs_9f2c...（43位随机，明文仅此一次）" }
```

> 若该用户已有 Key，此操作**重置**：旧 Key 立即失效，返回新明文。

### 2.2 查询 API Key 信息（掩码，不含明文）

```
GET /api/sync/apikey
Authorization: Bearer <session token>
```

**响应 200：**
```json
{
  "enabled": true,
  "prefix": "ohs_9f2cA1b2",
  "masked": "ohs_9f2cA1b2…",
  "created": 1756166400
}
```
- 未生成时：`{ "enabled": false, "prefix": "", "masked": "", "created": 0 }`

### 2.3 吊销 API Key

```
DELETE /api/sync/apikey
Authorization: Bearer <session token>
```

**响应 200：**
```json
{ "ok": true }
```

---

## 三、数据端点（X-API-Key 鉴权）

所有数据端点均需 `X-API-Key` 头；缺失或无效返回 **401**。

### 3.1 列出全部可同步笔记

```
GET /api/sync/list
X-API-Key: <raw key>
```

**响应 200：**
```json
{
  "files": [
    { "path": "工作/项目A.md", "mtime": 1756166400000 },
    { "path": "读书笔记.md",   "mtime": 1756166390000 }
  ]
}
```
- `mtime = note.updated × 1000`（毫秒），供客户端 LWW 对账。
- **刻意不返回 `size`**：本接口被客户端每 5–10s 轮询，读全部正文会压垮数据库；`size` 属信息性字段，可由 `GET /api/sync/file` 的 `content` 长度得出。
- **同步范围**：仅普通笔记。排除常驻笔记（`pinned`，如生词本）、回收站笔记（`deleted`）、内置文件夹「每日计划」「灵感速记」下的笔记，以及系统垃圾路径。
- **同名序号**：同一文件夹下标题相同的两篇笔记，第二篇 path 自动追加 `-2`、`-3`。序号由 `(folder, title, id)` 确定性排序分配，**多次 `/list` 之间稳定不抖动**。

### 3.2 读取单篇笔记

```
GET /api/sync/file?path=工作/项目A.md
X-API-Key: <raw key>
```

**响应 200：**
```json
{
  "path": "工作/项目A.md",
  "content": "# 项目A\n\n正文……\n",
  "mtime": 1756166400000
}
```
- `content` 为完整 Markdown，**标题作首行 H1**（`# 标题`），与浏览器端 `noteToMd` 一致。
- `path` 未命中任何笔记：返回 **404** `{ "detail": "文件不存在" }`。

### 3.3 写入 / 更新单篇笔记

```
POST /api/sync/file
X-API-Key: <raw key>
Content-Type: application/json

{
  "path": "工作/项目A.md",
  "content": "# 项目A\n\n新正文……\n",
  "clientMtime": 1756166500000
}
```

**响应 200（应用了写入）：**
```json
{ "path": "工作/项目A.md", "mtime": 1756166500000, "id": "a1b2c3d4", "applied": true }
```

**响应 200（LWW 拒绝，站点胜）：**
```json
{ "path": "工作/项目A.md", "mtime": 1756166400000, "id": "a1b2c3d4",
  "applied": false, "reason": "site-wins" }
```

**语义：**
- `path` 命中现有笔记：按 **LWW（2 秒内站点优先）** 决定是否覆盖。
  - **仅当** `clientMtime > 站点 mtime + 2000` 才覆盖站点（`applied:true`），并更新该笔记的 `title`（取 `content` 首行 H1，无则取文件名）、`folder`（取 path 目录部分）、`updated`。
  - 否则站点胜（`applied:false, reason:"site-wins"`），**返回站点当前 mtime**，客户端应改为拉取站点版本。
  - 这样站点（真源）永不会被近乎同时或更旧的推送覆盖。
- `path` 未命中：**新建**笔记。先逐级补齐 `folder`（否则笔记在目录树中不可见），再写正文。返回 `applied:true`。
- `clientMtime` 可省略（视作 0）；此时若命中现有笔记，几乎总是 `site-wins`（用于「只读拉取校验」场景）。

### 3.4 重命名 / 移动笔记

```
PUT /api/sync/file/rename
X-API-Key: <raw key>
Content-Type: application/json

{ "oldPath": "工作/项目A.md", "newPath": "工作/归档/项目A.md" }
```

**响应 200：**
```json
{ "ok": true, "path": "工作/归档/项目A.md", "id": "a1b2c3d4", "mtime": 1756166600000 }
```
- 按 `newPath` 更新笔记的 `folder` 与 `title`（`title` = 新文件名去掉 `.md`），**正文不变**，**笔记 ID 不变**（保留历史与引用，不退化成「删+建」）。
- `oldPath` 未命中：返回 **404** `{ "detail": "源文件不存在" }`。

### 3.5 删除笔记（软删进回收站）

```
DELETE /api/sync/file?path=工作/项目A.md
X-API-Key: <raw key>
```

**响应 200：**
```json
{ "ok": true, "softDeleted": true }
```
- **软删**：设笔记 `deleted` / `deleted_title` 时间戳，与 Web 端删除一致，**进门户「回收站」可恢复**，不物理删除正文。
- `path` 未命中：返回 **404** `{ "detail": "文件不存在" }`。

### 3.6 列出 / 读写附件

笔记正文里的 `/api/notes/assets/{name}` 引用对应门户附件分区。Obsidian 插件会在推送笔记前上传引用文件、拉取笔记后下载缺失文件。

```
GET /api/sync/assets
X-API-Key: <raw key>
```

**响应 200：** `{ "assets": [{ "name", "type", "size", "mtime" }] }`

```
GET /api/sync/asset?name=shot-ab12cd.png
X-API-Key: <raw key>
```

**响应 200：** `{ "name", "dataB64", "type", "mtime" }`

```
POST /api/sync/asset
X-API-Key: <raw key>
Content-Type: application/json

{ "filename": "shot.png", "dataB64": "<base64>" }
```

**响应 200：** `{ "name": "shot-ab12cd.png", "mtime": …, "unchanged": false }`

- 支持 png/jpg/gif/webp/svg/pdf/mp3/mp4/webm/wav/zip，单文件上限 5MB。
- `name` 为「原文件名主干 + 内容 sha256 前 6 位」，相同文件重复上传幂等。

### 3.7 knownRemoteMtime

`POST /api/sync/file` 可额外传 `knownRemoteMtime`（客户端上次同步记下的站点 mtime）。若当前站点 mtime **未超过**该值，视为服务端无独立变更，**即使** `clientMtime` 落在 2 秒窗口内也会落地本地内容（`applied:true`）。这避免 Obsidian 连续按键保存被误判为站点优先并回拉旧正文。

---

## 四、路径安全校验

所有接受 `path` / `oldPath` / `newPath` 的端点，入参都会先经规范化 + 安全校验（`_validate_sync_path`），拒绝以下情况，返回 **400**：

| 情况 | 示例 | 响应 `detail` |
| --- | --- | --- |
| 空路径 | `path=` | `path 不能为空` |
| 绝对路径 | `/etc/passwd.md` | `path 不能为绝对路径` |
| 含 `.` / `..` 段 | `../secret.md`、`a/./b.md` | `path 含非法路径段` |
| 含隐藏段（`.` 开头） | `.obsidian/x.md`、`.git/config` | `path 含隐藏段（. 开头），不在同步范围` |
| 系统资源垃圾 | `._临时.md`、`__MACOSX/x.md` | `path 为系统资源垃圾，已拒绝` |

- 反斜杠 `\` 统一规范化为 `/`，首尾 `/` 被剥离。
- 因 `path` 最终映射到数据库笔记而非物理文件，路径遍历攻击面本就很小，但仍严格校验以满足纵深防御。

---

## 五、错误码汇总

| HTTP 状态 | 触发场景 |
| --- | --- |
| **401** | 数据端点缺少 `X-API-Key`；或 Key 无效 / 已吊销 / 已重置。管理端点未登录（无有效 session） |
| **400** | `path` 校验失败（空 / 绝对 / `..` / 隐藏段 / 垃圾），见第四节 |
| **404** | `path` / `oldPath` 未命中任何同步范围内的笔记 |
| **422** | 请求体字段缺失或类型不符（FastAPI/Pydantic 自动校验，如 `POST /api/sync/file` 缺 `path`） |
| **500** | 服务端内部错误（正常不应出现） |

错误响应体统一为 FastAPI 默认结构：`{ "detail": "错误说明" }`（422 为 `{ "detail": [ ... ] }`）。

---

## 六、curl 速查

```bash
BASE="https://home.example.com"

# 1) 登录拿 session（略），生成 API Key
curl -s -X POST "$BASE/api/sync/apikey" \
  -H "Authorization: Bearer $TOKEN"
# -> {"ok":true,"apiKey":"ohs_xxx"}

# 2) 用 Key 列出笔记
KEY="ohs_xxx"
curl -s "$BASE/api/sync/list" -H "X-API-Key: $KEY"

# 3) 读单篇
curl -s "$BASE/api/sync/file?path=%E5%B7%A5%E4%BD%9C/%E9%A1%B9%E7%9B%AEA.md" \
  -H "X-API-Key: $KEY"

# 4) 写单篇（LWW）
curl -s -X POST "$BASE/api/sync/file" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"工作/项目A.md","content":"# 项目A\n\n新正文\n","clientMtime":1756166500000}'

# 5) 重命名
curl -s -X PUT "$BASE/api/sync/file/rename" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"oldPath":"工作/项目A.md","newPath":"工作/归档/项目A.md"}'

# 6) 删除（软删进回收站）
curl -s -X DELETE "$BASE/api/sync/file?path=%E5%B7%A5%E4%BD%9C/%E9%A1%B9%E7%9B%AEA.md" \
  -H "X-API-Key: $KEY"

# 7) 吊销 Key
curl -s -X DELETE "$BASE/api/sync/apikey" -H "Authorization: Bearer $TOKEN"
```

> `path` 含中文时在 URL 中需 percent-encode（如上例 `%E5%B7%A5%E4%BD%9C` = 「工作」）。Obsidian 插件通过 `requestUrl` 自动编码。

---

## 七、相关文档

- 用户操作：`docs/Obsidian同步插件-用户使用指南.md`
- 插件源码与侧载：`obsidian-plugin/omnihome-sync/README.md`
- 部署补充：`DEPLOY.md`（「Obsidian 同步」一节）
- 浏览器版本地同步：`docs/本地同步功能用户使用指南.md`
