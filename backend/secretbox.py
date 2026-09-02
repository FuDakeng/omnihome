"""万事屋 · 服务端敏感信息保管

把 AI 接口密钥这类敏感配置**加密后**落库，避免数据库 / 用户数据文件里出现明文。

设计要点
- 主密钥首次使用时随机生成，存于 ``data/secret.key``（权限 600），
  与用户数据分属不同位置：只拿到数据库或 data/users 无法解密。
- 加密算法用 Fernet（AES-128-CBC + HMAC-SHA256 认证加密，密文自带时间戳），
  来自业界标准的 cryptography 库，不自行实现密码学原语。
- 密文带 ``enc1:`` 前缀；旧版明文数据可正常读出，并在下次写入时自动升级为密文。
- 迁移须知：整站迁移请备份整个 ``data/`` 目录（含 secret.key）。
  若只搬走用户数据而丢了主密钥，已存密钥将无法解密，
  此时按「未配置」处理（界面提示重新填写），不会让服务崩溃。

依赖
- 需要 ``cryptography``（已加入 requirements.txt）。
  该库缺失时降级为明文存储并打印一次警告，保证服务仍可运行。
"""
import logging
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SECRET_FILE = DATA_DIR / "secret.key"

MARKER = "enc1:"      # 密文前缀：用于区分密文与历史明文

_log = logging.getLogger("omnihome.secretbox")
_lock = threading.Lock()
_key = None
_fernet = None
_missing_warned = False


def available() -> bool:
    """cryptography 是否可用（不可用则降级为明文）。"""
    try:
        from cryptography.fernet import Fernet  # noqa: F401
        return True
    except ImportError:
        return False


def _warn_missing():
    """依赖缺失只警告一次，避免日志刷屏。"""
    global _missing_warned
    if _missing_warned:
        return
    _missing_warned = True
    _log.warning(
        "未安装 cryptography，敏感配置将以明文存储。"
        "执行 pip install cryptography 后重启即可自动加密（历史明文会在下次写入时升级）。"
    )


def _load_key() -> bytes:
    """读取（必要时生成）主密钥，生成后立刻收紧文件权限。"""
    global _key
    if _key is not None:
        return _key
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if SECRET_FILE.exists():
            raw = SECRET_FILE.read_bytes().strip()
            if raw:
                _key = raw
                return _key
        _key = _gen_key()
        SECRET_FILE.write_bytes(_key)
        try:
            os.chmod(SECRET_FILE, 0o600)      # 仅属主可读写
        except OSError:
            pass                               # Windows 等平台无 chmod，忽略
        _log.info("已生成新的数据加密主密钥：%s", SECRET_FILE)
    except OSError as e:
        raise RuntimeError(f"无法读写主密钥文件 {SECRET_FILE}：{e}")
    return _key


def _gen_key() -> bytes:
    from cryptography.fernet import Fernet
    return Fernet.generate_key()


def _get_fernet():
    global _fernet
    if _fernet is not None:
        return _fernet
    from cryptography.fernet import Fernet
    _fernet = Fernet(_load_key())
    return _fernet


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(MARKER)


def encrypt(plain: str) -> str:
    """加密；依赖缺失或值为空时原样返回。"""
    if not plain:
        return ""
    if not available():
        _warn_missing()
        return plain
    with _lock:
        try:
            token = _get_fernet().encrypt(plain.encode("utf-8"))
        except Exception as e:
            _log.error("加密失败，本次将按明文处理：%s", e)
            return plain
    return MARKER + token.decode("ascii")


def decrypt(stored) -> str:
    """解密；识别不出密文前缀时按历史明文原样返回。"""
    if not stored:
        return ""
    if not is_encrypted(stored):
        return stored                          # 旧版明文，调用方会在下次写入时升级
    if not available():
        _warn_missing()
        return ""                              # 明知是密文却解不开，不要回传乱码
    with _lock:
        try:
            return _get_fernet().decrypt(stored[len(MARKER):].encode("ascii")).decode("utf-8")
        except Exception as e:
            _log.warning("解密失败（主密钥可能已更换或丢失）：%s", e)
            return ""


def status() -> dict:
    """供「关于 / 数据安全」展示的状态摘要，不含任何密钥内容。"""
    return {
        "encryption": bool(available()),
        "keyFile": str(SECRET_FILE),
        "keyExists": SECRET_FILE.exists(),
    }
