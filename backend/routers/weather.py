"""万事屋 · 天气与每日单词"""
from __future__ import annotations

import re
import hashlib
import secrets
import threading
import time
import uuid
import json
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Body, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import storage
import secretbox
import teams
from sessions import require_user, verify_password

router = APIRouter()

WMO = {0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "雾凇",
       51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨", 56: "冻毛毛雨", 57: "强冻毛毛雨",
       61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
       71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
       80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "小阵雪", 86: "大阵雪",
       95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹"}
WMO_ICON = {0: "sun", 1: "sun", 2: "cloud-sun", 3: "cloud", 45: "cloud", 48: "cloud",
            51: "cloud-rain", 53: "cloud-rain", 55: "cloud-rain", 56: "cloud-rain",
            57: "cloud-rain", 61: "cloud-rain", 63: "cloud-rain", 65: "cloud-rain",
            66: "cloud-rain", 67: "cloud-rain", 71: "cloud", 73: "cloud", 75: "cloud",
            77: "cloud", 80: "cloud-rain", 81: "cloud-rain", 82: "cloud-rain",
            85: "cloud", 86: "cloud", 95: "cloud-rain", 96: "cloud-rain", 99: "cloud-rain"}

@router.get("/api/weather")
def weather(lat: float = 30.2741, lon: float = 120.1552,
            authorization: Optional[str] = Header(None)):
    require_user(authorization)
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat}&longitude={lon}"
           "&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
           "weather_code,wind_speed_10m,wind_direction_10m,uv_index"
           "&daily=weather_code,temperature_2m_max,temperature_2m_min,"
           "precipitation_probability_max"
           "&timezone=auto&forecast_days=7")
    try:
        r = httpx.get(url, timeout=10)
        data = r.json()
    except Exception as e:
        raise HTTPException(502, f"天气服务暂不可用：{e}")
    cur = data.get("current", {})
    daily = data.get("daily", {})
    code = cur.get("weather_code", 0)
    rain_list = daily.get("precipitation_probability_max") or []
    days = []
    for i in range(len(daily.get("time", []))):
        c = daily["weather_code"][i]
        days.append({
            "date": daily["time"][i],
            "cond": WMO.get(c, "未知"),
            "icon": WMO_ICON.get(c, "cloud"),
            "max": round(daily["temperature_2m_max"][i]),
            "min": round(daily["temperature_2m_min"][i]),
            "rain": rain_list[i] if i < len(rain_list) else None,
        })
    # 空气质量（独立接口，失败不影响主数据）
    aqi = None
    try:
        r = httpx.get("https://air-quality-api.open-meteo.com/v1/air-quality",
                      params={"latitude": lat, "longitude": lon,
                              "current": "us_aqi"}, timeout=8)
        aqi = r.json().get("current", {}).get("us_aqi")
    except Exception:
        pass
    return {
        "temp": round(cur.get("temperature_2m", 0)),
        "feels": round(cur.get("apparent_temperature", 0)),
        "cond": WMO.get(code, "未知"),
        "icon": WMO_ICON.get(code, "cloud"),
        "humidity": cur.get("relative_humidity_2m"),
        "windSpeed": round(cur.get("wind_speed_10m", 0)),
        "windDeg": cur.get("wind_direction_10m", 0),
        "uv": cur.get("uv_index"),
        "aqi": aqi,
        "rainProb": rain_list[0] if rain_list else None,
        "tzOffset": data.get("utc_offset_seconds", 0),
        "tzName": data.get("timezone", ""),
        "updated": time.strftime("%H:%M"),
        "days": days,
    }

def _search_openmeteo(name):
    """Open-Meteo 地名词典：仅保留可信的城市/区县级结果，
    滤掉同名村镇（无人口且非行政驻地），避免“南昌”搜出各地南昌路/村。"""
    try:
        r = httpx.get("https://geocoding-api.open-meteo.com/v1/search",
                      params={"name": name, "count": 10, "language": "zh"}, timeout=8)
        out = []
        for x in r.json().get("results", []):
            code = x.get("feature_code") or ""
            if not x.get("population") and not code.startswith(("PPLA", "ADM")):
                continue
            out.append({"city": x["name"], "lat": x["latitude"], "lon": x["longitude"],
                        "region": x.get("admin1", ""),
                        "district": x.get("admin2", "") or "",
                        "_pop": x.get("population") or 0})
        return out
    except Exception:
        return []

_PROVINCE_SUFFIX = ("壮族自治区", "维吾尔自治区", "回族自治区", "自治区", "特别行政区", "省", "市")

def _search_photon(name):
    """Photon（OSM）正向搜索：覆盖 Open-Meteo 缺失的区县，支持模糊匹配。"""
    try:
        r = httpx.get("https://photon.komoot.io/api/",
                      params={"q": name, "limit": 6},
                      headers={"User-Agent": "Mozilla/5.0 (OmniHome self-hosted portal)"},
                      timeout=8)
        out = []
        for f in r.json().get("features", []):
            p = f.get("properties", {})
            nm = p.get("name") or ""
            # 仅保留名称完全匹配的结果，排除车站 / 设施等噪音（如“抚州站”“资溪县人民法院”）
            if nm != name:
                continue
            lon, lat = (f.get("geometry") or {}).get("coordinates", (None, None))
            region = p.get("state") or ""
            for sfx in _PROVINCE_SUFFIX:
                if region.endswith(sfx):
                    region = region[:-len(sfx)]
                    break
            district = p.get("county") or p.get("city") or ""
            if district == nm:
                district = ""
            out.append({"city": nm, "lat": lat, "lon": lon,
                        "region": region, "district": district, "_pop": 0})
        return out
    except Exception:
        return []

@router.get("/api/weather/geocode")
def geocode(city: Optional[str] = None, lat: Optional[float] = None,
            lon: Optional[float] = None, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    # 经纬度 → 反向解析城市名（精确到区县；Nominatim 主源，bigdatacloud 备源，均免 key）
    if not city and lat is not None and lon is not None:
        district = ""
        try:
            r = httpx.get("https://nominatim.openstreetmap.org/reverse",
                          params={"lat": lat, "lon": lon, "format": "json",
                                  "accept-language": "zh", "zoom": 14},
                          headers={"User-Agent": "OmniHome/1.0 (self-hosted portal)"},
                          timeout=6)
            d = r.json()
            addr = d.get("address", {})
            name = (addr.get("city") or addr.get("town") or addr.get("county")
                    or addr.get("state") or d.get("name") or "")
            district = (addr.get("city_district") or addr.get("suburb")
                        or addr.get("county") or addr.get("town") or "")
            # 区县与城市同名时不重复展示（如北京市→朝阳区保留，县市级去重）
            if district and district == name:
                district = ""
        except Exception:
            name = ""
        if not name:
            try:
                r = httpx.get("https://api.bigdatacloud.net/data/reverse-geocode-client",
                              params={"latitude": lat, "longitude": lon,
                                      "localityLanguage": "zh"}, timeout=8,
                              follow_redirects=True)
                d = r.json()
                name = (d.get("city") or d.get("locality")
                        or d.get("principalSubdivision") or "")
                district = d.get("locality") or ""
                if district and district == name:
                    district = ""
            except Exception:
                name = ""
        if not name:
            return []
        return [{"city": name, "district": district,
                 "lat": lat, "lon": lon, "region": ""}]
    if not city:
        raise HTTPException(400, "请提供城市名或经纬度")
    q = city.strip()
    # 模糊搜索：原名 / 去行政后缀（抚州市→抚州） / 补后缀（抚州→抚州市、资溪→资溪县）
    base = re.sub(r"(市|县|区|省|盟|旗)$", "", q)
    candidates = [q]
    if base != q:
        candidates.append(base)
    else:
        candidates += [q + "市", q + "县"]
    results, seen = [], set()
    for name in candidates:
        for x in _search_openmeteo(name):
            k = (x["city"], x["region"])
            if k not in seen:
                seen.add(k)
                results.append(x)
    # 区县在 Open-Meteo 词典常缺失：无结果或结果过少时用 Photon 补充（不抛错，仅影响补全）
    if len(results) < 3:
        for name in candidates[:2]:
            for x in _search_photon(name):
                k = (x["city"], x["region"])
                if k not in seen:
                    seen.add(k)
                    results.append(x)
    if not results:
        raise HTTPException(502, "城市搜索失败：服务暂不可用，请稍后重试")
    # 排序：完全匹配（含去/补后缀变体）优先，其次按人口（大城市靠前），最多 6 条
    exacts = {q, base, base + "市", base + "县"}
    results.sort(key=lambda x: (x["city"] not in exacts, -x["_pop"]))
    return [{k: v for k, v in x.items() if k != "_pop"}
            for x in results[:6]]

WORDS_FILE = storage.ROOT / "backend" / "data" / "words.json"

def load_words():
    return storage.read_json(WORDS_FILE, [])

@router.get("/api/dict/word")
def daily_word(date: Optional[str] = None, shuffle: bool = False,
               exclude: Optional[str] = None,
               authorization: Optional[str] = Header(None)):
    require_user(authorization)
    words = load_words()
    # 排除已加入生词本的单词（逗号分隔列表）
    if exclude:
        bad = {w.strip().lower() for w in exclude.split(",") if w.strip()}
        words = [w for w in words if w.get("word", "").lower() not in bad]
    if not words:
        raise HTTPException(404, "词库中的单词都已加入生词本")
    if shuffle:
        import random
        return random.choice(words)
    key = date or time.strftime("%Y-%m-%d")
    idx = sum(ord(ch) for ch in key) % len(words)
    return words[idx]

