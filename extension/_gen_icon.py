"""生成 OmniHome 插件图标（纯标准库：zlib + struct，4× 超采样抗锯齿）。"""
import math
import struct
import zlib

N = 128          # 画布尺寸
SS = 4           # 超采样倍数
C1 = (139, 92, 246)   # 紫
C2 = (59, 130, 246)   # 蓝
WHITE = (255, 255, 255)


def rounded(x, y, x0, y0, x1, y1, r):
    """圆角矩形内判定（点到角圆心距离）。"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return 0.0
    cx = max(x0 + r, min(x, x1 - r))
    cy = max(y0 + r, min(y, y1 - r))
    d = math.hypot(x - cx, y - cy)
    return 1.0 if d <= r else max(0.0, 1.0 - (d - r))


def in_poly(x, y, poly):
    """射线法多边形内判定。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def main():
    # 底：圆角方块 12..116（r=26），书签：48..80 × 34..96 底部 V 口
    mark = [(48, 34), (80, 34), (80, 96), (64, 82), (48, 96)]
    img = bytearray()
    for py in range(N):
        row = bytearray()
        for px in range(N):
            acc = 0.0
            cr = cg = cb = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + .5) / SS
                    y = py + (sy + .5) / SS
                    a_bg = rounded(x, y, 12, 12, 116, 116, 26)
                    if a_bg <= 0:
                        continue
                    t = (x + y) / 232
                    br, bg_, bb = (C1[i] + (C2[i] - C1[i]) * t for i in range(3))
                    a_mk = 1.0 if in_poly(x, y, mark) else 0.0
                    cr += (br * (1 - a_mk) + WHITE[0] * a_mk) * a_bg
                    cg += (bg_ * (1 - a_mk) + WHITE[1] * a_mk) * a_bg
                    cb += (bb * (1 - a_mk) + WHITE[2] * a_mk) * a_bg
                    acc += a_bg
            if acc <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                a = int(acc / (SS * SS) * 255)
                row += bytes((int(cr / acc), int(cg / acc), int(cb / acc), a))
        img += bytes(row)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    raw = b"".join(b"\x00" + bytes(img[y * N * 4:(y + 1) * N * 4]) for y in range(N))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open("icons/icon128.png", "wb") as f:
        f.write(png)
    print("icon128.png written", len(png), "bytes")


if __name__ == "__main__":
    main()
