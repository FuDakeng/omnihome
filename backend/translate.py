"""翻译工具：多引擎并行，取第一条可用译文。

现网问题：
  · Google `client=gtx` 常 429 / 在国内连不上，串行等到超时才回退，体感很慢；
  · 回退 MyMemory 对「英→中」常直接回原文（翻译记忆没命中、配额或语种码），
    后端却当成成功，界面看起来「没有作用」。
"""
from __future__ import annotations

import html
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

import httpx

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_TIMEOUT = httpx.Timeout(2.8, connect=1.2)
_HTTP = httpx.Client(timeout=_TIMEOUT, headers=_UA, follow_redirects=True)
_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tr")

_CACHE: dict[tuple, tuple[float, str]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 30 * 60
_CACHE_MAX = 256
_TEXT_LIMIT = 1500


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


_LANG_ALIASES = {
    "zh": "zh-CN", "zh-cn": "zh-CN", "zh-hans": "zh-CN", "zh-chs": "zh-CN",
    "zh-tw": "zh-TW", "zh-hant": "zh-TW", "zh-cht": "zh-TW",
    "en": "en", "en-us": "en", "en-gb": "en",
    "ja": "ja", "jp": "ja", "ja-jp": "ja",
    "ko": "ko", "kr": "ko", "ko-kr": "ko",
}

Engine = Callable[[str, str, str], str]


def norm_lang(code: str) -> str:
    c = (code or "").strip()
    if not c:
        return "en"
    return _LANG_ALIASES.get(c.lower(), c)


def _cache_get(key: tuple) -> Optional[str]:
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if not hit:
            return None
        ts, val = hit
        if now - ts > _CACHE_TTL:
            _CACHE.pop(key, None)
            return None
        return val


def _cache_put(key: tuple, val: str) -> None:
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            oldest = min(_CACHE.items(), key=lambda kv: kv[1][0])[0]
            _CACHE.pop(oldest, None)
        _CACHE[key] = (time.time(), val)


def _usable(text: str, source: str, target: str, out: str) -> bool:
    """跨语种时拒绝空译文和「原样返回」（英译中无效果的主因）。"""
    if not out or not str(out).strip():
        return False
    out = html.unescape(str(out)).strip()
    low = out.lower()
    if "invalid language pair" in low or low.startswith("query length"):
        return False
    src, tgt = norm_lang(source), norm_lang(target)
    if src.split("-")[0].lower() == tgt.split("-")[0].lower():
        return True
    if out.casefold() == text.strip().casefold():
        return False
    if tgt.lower().startswith("zh") and not _CJK_RE.search(out):
        # 目标是中文却没有任何汉字（常见于引擎直接回英文）
        return False
    if tgt.lower().startswith("en") and not re.search(r"[A-Za-z]", out):
        return False
    return True


def _parse_clients5(data) -> str:
    if isinstance(data, str) and data.strip():
        return data.strip()
    if not isinstance(data, list) or not data:
        raise ValueError("empty google payload")
    first = data[0]
    if isinstance(first, str):
        return first
    if isinstance(first, list) and first and isinstance(first[0], str):
        return first[0]
    raise ValueError("unexpected google payload")


def google_clients5(source: str, target: str, text: str) -> str:
    r = _HTTP.get(
        "https://clients5.google.com/translate_a/t",
        params={"client": "dict-chrome-ex", "sl": source, "tl": target, "q": text},
    )
    r.raise_for_status()
    return _parse_clients5(r.json())


def youdao(source: str, target: str, text: str) -> str:
    yd = {
        "zh-CN": "zh-CHS", "zh-TW": "zh-CHT",
        "en": "en", "ja": "ja", "ko": "ko",
    }
    payload = {
        "q": text,
        "from": yd.get(source, source),
        "to": yd.get(target, target),
    }
    r = _HTTP.post("https://aidemo.youdao.com/trans", data=payload)
    r.raise_for_status()
    data = r.json()
    if str(data.get("errorCode", "")) not in ("0", ""):
        raise ValueError(f"youdao error {data.get('errorCode')}")
    parts = data.get("translation") or []
    out = "".join(p for p in parts if p)
    if not out:
        raise ValueError("youdao empty")
    return out


def mymemory(source: str, target: str, text: str) -> str:
    # MyMemory 对 zh-CN 识别不稳，统一用 zh
    def pair(s: str) -> str:
        return "zh" if s.lower().startswith("zh") else s

    r = _HTTP.get(
        "https://api.mymemory.translated.net/get",
        params={"q": text, "langpair": f"{pair(source)}|{pair(target)}"},
    )
    r.raise_for_status()
    data = r.json()
    if str(data.get("responseStatus")) != "200":
        detail = str(data.get("responseDetails") or "mymemory error")[:80]
        raise ValueError(detail)
    out = (data.get("responseData") or {}).get("translatedText") or ""
    return html.unescape(out)


DEFAULT_ENGINES: tuple[Engine, ...] = (google_clients5, youdao, mymemory)


def translate_text(text: str, source: str = "zh-CN", target: str = "en",
                   *, engines: Optional[tuple[Engine, ...] | list[Engine]] = None) -> str:
    raw = (text or "").strip()
    if not raw:
        raise ValueError("请输入要翻译的内容")
    raw = raw[:_TEXT_LIMIT]
    source, target = norm_lang(source), norm_lang(target)
    if source == target:
        return raw

    key = (source, target, raw)
    hit = _cache_get(key)
    if hit is not None:
        return hit

    runners = tuple(engines) if engines else DEFAULT_ENGINES
    errors: list[str] = []
    futs = {_POOL.submit(fn, source, target, raw): getattr(fn, "__name__", "eng")
            for fn in runners}
    deadline = 4.2
    try:
        for fut in as_completed(futs, timeout=deadline):
            name = futs[fut]
            try:
                out = fut.result()
            except Exception as e:
                errors.append(f"{name}: {e}")
                continue
            if _usable(raw, source, target, out):
                out = html.unescape(str(out)).strip()
                _cache_put(key, out)
                return out
            errors.append(f"{name}: unusable")
    except TimeoutError:
        errors.append("timeout")

    detail = "；".join(errors[:3])
    raise RuntimeError(detail or "翻译服务暂不可用")
