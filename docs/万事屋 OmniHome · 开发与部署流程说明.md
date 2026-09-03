

> 适用对象：万事屋开发者（外网环境） 更新日期：2026-09-02

---

## 一、仓库信息（Gitea 私服）

|                   |                                                  |
| ----------------- | ------------------------------------------------ |
| 项目                | 地址                                               |
| Gitea 主站          | `https://git.jeanlaw.xyz/`                       |
| 万事屋源码仓库           | `https://git.jeanlaw.xyz/jeanlaw/omnihome.git`   |
| 账鹅源码仓库            | `https://git.jeanlaw.xyz/jeanlaw/goosecount.git` |
| 镜像仓库（容器 registry） | `git.jeanlaw.xyz`（`/v2/`）                        |
| Gitea 账号          | `jeanlaw`                                        |
| Gitea令牌           | `d475d507ca92727ba4f095a8689ab8336fa39344`       |

> 拉取私有源码/镜像需登录： `docker login git.jeanlaw.xyz`（用户名 jeanlaw，密码用令牌） 令牌在 Gitea → 设置 → 应用 → 生成（勾选 package 权限）

---

## 二、开发完成后的标准动作（外网开发环境）

> 外网环境**无法推送镜像**（镜像由 NAS 侧构建），只需推送源码。

### 万事屋示例（每次发版收尾）

---

## 三、NAS 侧部署流程（Hermes 自动执行）

---

## 四、硬性要求（务必遵守）

1. **版本号必改**：`backend/app_version.py` 的 `VERSION` 每版递增 （镜像 tag、页面"关于"、更新日志都读它）

2. **扩展同步**：浏览器扩展有改动时，最新 `omnihome-extension.zip` 必须放到源码根目录一起提交（NAS 构建时自动打包进镜像）

3. **私钥严禁上传**：`*.pem`（扩展签名私钥）已在 `.gitignore`， 若 `git status` 出现 pem 文件立即撤销，切勿推送

4. **Dockerfile 保持**：保留阿里云 pip 源修正（构建需要）， 需带 `COPY omnihome-extension.zi[p] ./` 扩展行

---

## 五、常用地址

|         |                            |
| ------- | -------------------------- |
| 用途      | 地址                         |
| 万事屋（生产） | `https://home.jeanlaw.xyz` |
| Gitea   | `https://git.jeanlaw.xyz/` |
