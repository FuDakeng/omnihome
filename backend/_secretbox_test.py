# -*- coding: utf-8 -*-
"""secretbox 与 AI 配置加密落库的自检（单元测试，不需要运行中的服务）。

用法：/usr/bin/python3 backend/_secretbox_test.py
"""
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import secretbox                      # noqa: E402
import storage                        # noqa: E402
import routes                         # noqa: E402

OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{extra}]" if extra else ""))


TMP_USER = "__secretbox_test__"
SECRET = "sk-live-EXAMPLE-9f8a7b6c5d4e3f2a"   # 假密钥，仅用于验证


def cleanup():
    d = storage.USERS_DIR / TMP_USER
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


print("\nsecretbox / AI 密钥加密自检")
print("─" * 52)

# ---- 1. 依赖与加解密往返 ----
check("cryptography 依赖可用", secretbox.available())
cipher = secretbox.encrypt(SECRET)
check("密文不等于明文", cipher != SECRET)
check("密文带 enc1: 前缀", secretbox.is_encrypted(cipher))
check("解密还原原文", secretbox.decrypt(cipher) == SECRET)
check("明文可识别为非密文", not secretbox.is_encrypted(SECRET))

# ---- 2. 边界与兼容 ----
check("空值加密仍为空", secretbox.encrypt("") == "")
check("空值解密仍为空", secretbox.decrypt("") == "")
check("历史明文原样返回（兼容旧数据）", secretbox.decrypt("sk-legacy-plain") == "sk-legacy-plain")
check("密文不可重复识别为明文", secretbox.is_encrypted(cipher) and not secretbox.is_encrypted(None))

# ---- 3. 主密钥错乱时优雅降级 ----
saved = secretbox._key
secretbox._key, secretbox._fernet = b"x", None
try:
    secretbox._fernet = None
    secretbox._key = secretbox._gen_key()      # 换成一把新钥匙
    check("主密钥不匹配时返回空串而非崩溃", secretbox.decrypt(cipher) == "")
finally:
    secretbox._key, secretbox._fernet = saved, None

# ---- 4. 落库后磁盘上没有明文 ----
cleanup()
storage.save_user_json(TMP_USER, routes.AI_FILE,
                       {"endpoint": "https://api.example.com/v1",
                        "apiKey": secretbox.encrypt(SECRET),
                        "model": "gpt-4o-mini", "enabled": True})
ai_path = storage.USERS_DIR / TMP_USER / routes.AI_FILE
raw = ai_path.read_text(encoding="utf-8")
check("文件中的密钥字段是密文", '"enc1:' in raw)
check("文件中不含明文密钥", SECRET not in raw)

# ---- 5. 读取路径：明文自动升级为密文 ----
cleanup()
storage.save_user_json(TMP_USER, routes.AI_FILE,
                       {"endpoint": "https://api.example.com/v1",
                        "apiKey": SECRET, "model": "gpt-4o-mini", "enabled": False})
cfg = routes._ai_cfg(TMP_USER)
check("读取历史明文时自动升级为密文", secretbox.is_encrypted(cfg["apiKey"]))
check("升级后 _ai_key 仍能取出原文", routes._ai_key(cfg) == SECRET)
check("升级已回写磁盘", SECRET not in ai_path.read_text(encoding="utf-8"))

# ---- 6. 对外响应不泄露密钥 ----
pub = routes._ai_public(cfg)
check("响应包含 hasKey=True", pub["hasKey"] is True)
check("响应不含 apiKey 字段", "apiKey" not in pub)
check("响应不含明文密钥", SECRET not in str(pub))

# ---- 7. 主密钥文件 ----
st = secretbox.status()
check("主密钥文件已生成", st["keyExists"], st["keyFile"])
if st["keyExists"]:
    mode = os.stat(secretbox.SECRET_FILE).st_mode & 0o777
    check("主密钥文件权限为 600", mode == 0o600, oct(mode))

cleanup()
print("─" * 52)
print(f"通过 {len(OK)} / {len(OK) + len(FAIL)}" + ("  ✓ 全部通过\n" if not FAIL else "  ✗ 存在失败\n"))
sys.exit(1 if FAIL else 0)
