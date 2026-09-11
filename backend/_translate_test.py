# -*- coding: utf-8 -*-
"""翻译引擎选择与「英译中原样返回」过滤（不联网）。

用法：python3 backend/_translate_test.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import translate  # noqa: E402

OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{extra}]" if extra else ""))


print("\n翻译工具自检")
print("─" * 52)

check("zh-CN 归一", translate.norm_lang("zh-CN") == "zh-CN")
check("zh 归一为 zh-CN", translate.norm_lang("zh") == "zh-CN")
check("en-US 归一", translate.norm_lang("en-US") == "en")

check("英译中原样英文不可用",
      not translate._usable("hello world", "en", "zh-CN", "hello world"))
check("英译中出汉字可用",
      translate._usable("hello world", "en", "zh-CN", "你好世界"))
check("中译英原样中文不可用",
      not translate._usable("你好世界", "zh-CN", "en", "你好世界"))
check("中译英出拉丁可用",
      translate._usable("你好世界", "zh-CN", "en", "Hello world"))
check("空译文不可用", not translate._usable("hi", "en", "zh-CN", "  "))
check("同语种允许原样",
      translate._usable("hello", "en", "en", "hello"))

check("clients5 解析列表",
      translate._parse_clients5(["你好世界"]) == "你好世界")
check("clients5 解析嵌套",
      translate._parse_clients5([["你好世界", "en"]]) == "你好世界")

translate.clear_cache()


def boom(source, target, text):
    raise RuntimeError("down")


def noop(source, target, text):
    return text


def slow_en(source, target, text):
    return text  # 会被判定不可用


def good_zh(source, target, text):
    return "自托管很有趣"


out = translate.translate_text(
    "Self-hosting is fun", "en", "zh-CN",
    engines=(noop, boom, good_zh))
check("英译中跳过原样与失败引擎", out == "自托管很有趣")

translate.clear_cache()
out = translate.translate_text(
    "自托管的最大乐趣", "zh-CN", "en",
    engines=(lambda s, t, q: "The greatest joy of self-hosting",))
check("中译英走可用引擎", "self-hosting" in out.lower())

translate.clear_cache()
try:
    translate.translate_text("hello", "en", "zh-CN", engines=(noop, boom))
    check("全部失败应抛错", False)
except Exception:
    check("全部失败应抛错", True)

translate.clear_cache()
out = translate.translate_text("already english", "en", "en")
check("同语种直接返回", out == "already english")

print("─" * 52)
print(f"通过 {len(OK)}  失败 {len(FAIL)}")
if FAIL:
    sys.exit(1)
