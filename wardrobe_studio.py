#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Leithhome 本地衣物工坊。

纯 Python 标准库实现：读取 See-through PSD/ZIP、预览透明图层、生成 PNG，
并维护 wardrobe/catalog.json + catalog.js。只监听 127.0.0.1。
"""

from __future__ import annotations

import cgi
import hashlib
import io
import json
import os
import re
import shutil
import struct
import tempfile
import threading
import time
import uuid
import webbrowser
import zipfile
import zlib
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
WARDROBE = ROOT / "wardrobe"
ASSETS = WARDROBE / "assets"
CATALOG_JSON = WARDROBE / "catalog.json"
CATALOG_JS = WARDROBE / "catalog.js"
SESSIONS_ROOT = Path(tempfile.gettempdir()) / "leith-wardrobe-studio"
SESSIONS: dict[str, dict] = {}

SLOT_MAP = {
    "topwear": "top",
    "top": "top",
    "bottomwear": "bottom",
    "bottom": "bottom",
    "dress": "dress",
    "onepiece": "dress",
    "onepiecedress": "dress",
    "legwear": "socks",
    "socks": "socks",
    "stockings": "socks",
    "hosiery": "socks",
    "footwear": "shoes",
    "shoes": "shoes",
    "headwear": "hat",
    "hat": "hat",
}
SLOT_LABELS = {
    "top": "上衣", "bottom": "下装（含半身裙/裤子）", "dress": "连衣裙",
    "socks": "袜子/丝袜", "shoes": "鞋子", "hat": "帽子",
}
ALLOWED_SLOTS = set(SLOT_LABELS)


@dataclass
class Layer:
    name: str
    left: int
    top: int
    right: int
    bottom: int
    rgba: bytes
    order: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top


def u16(data: bytes, pos: int) -> int:
    return struct.unpack(">H", data[pos:pos + 2])[0]


def i16(data: bytes, pos: int) -> int:
    return struct.unpack(">h", data[pos:pos + 2])[0]


def u32(data: bytes, pos: int) -> int:
    return struct.unpack(">I", data[pos:pos + 4])[0]


def i32x4(data: bytes, pos: int) -> tuple[int, int, int, int]:
    return struct.unpack(">iiii", data[pos:pos + 16])


def unpack_bits(data: bytes, expected: int) -> bytes:
    output = bytearray()
    pos = 0
    while pos < len(data) and len(output) < expected:
        value = data[pos]
        pos += 1
        if value <= 127:
            size = value + 1
            output.extend(data[pos:pos + size])
            pos += size
        elif value >= 129:
            size = 257 - value
            if pos >= len(data):
                break
            output.extend(data[pos:pos + 1] * size)
            pos += 1
    if len(output) < expected:
        output.extend(b"\0" * (expected - len(output)))
    return bytes(output[:expected])


def decode_channel(raw: bytes, width: int, height: int) -> bytes:
    compression = u16(raw, 0)
    payload = raw[2:]
    expected = width * height
    if compression == 0:
        return (payload + b"\0" * expected)[:expected]
    if compression == 1:
        row_sizes = struct.unpack(">" + "H" * height, payload[:2 * height])
        pos = 2 * height
        rows = []
        for row_size in row_sizes:
            rows.append(unpack_bits(payload[pos:pos + row_size], width))
            pos += row_size
        return b"".join(rows)
    if compression in (2, 3):
        decoded = bytearray(zlib.decompress(payload))
        if compression == 3:
            for y in range(height):
                row = y * width
                for x in range(1, width):
                    decoded[row + x] = (decoded[row + x] + decoded[row + x - 1]) & 255
        return (bytes(decoded) + b"\0" * expected)[:expected]
    raise ValueError(f"暂不支持 PSD 压缩类型 {compression}")


def read_psd(data: bytes) -> tuple[int, int, list[Layer]]:
    if data[:4] != b"8BPS" or u16(data, 4) != 1:
        raise ValueError("只支持普通 PSD（不是 PSB）")
    channels = u16(data, 12)
    height, width = struct.unpack(">II", data[14:22])
    depth, color_mode = struct.unpack(">HH", data[22:26])
    if depth != 8 or color_mode != 3 or channels < 3:
        raise ValueError("目前只支持 8 位 RGB/RGBA PSD")

    pos = 26
    for _ in range(2):
        length = u32(data, pos)
        pos += 4 + length
    layer_mask_length = u32(data, pos)
    pos += 4
    if layer_mask_length == 0:
        raise ValueError("PSD 中没有可读取的图层")
    layer_info_length = u32(data, pos)
    pos += 4
    layer_info_end = pos + layer_info_length
    layer_count = abs(i16(data, pos))
    pos += 2

    records = []
    for order in range(layer_count):
        top, left, bottom, right = i32x4(data, pos)
        pos += 16
        channel_count = u16(data, pos)
        pos += 2
        channel_records = []
        for _ in range(channel_count):
            channel_id = i16(data, pos)
            length = u32(data, pos + 2)
            pos += 6
            channel_records.append((channel_id, length))
        pos += 12  # blend signature/key, opacity, clipping, flags, filler
        extra_length = u32(data, pos)
        pos += 4
        extra_end = pos + extra_length
        mask_length = u32(data, pos)
        pos += 4 + mask_length
        ranges_length = u32(data, pos)
        pos += 4 + ranges_length
        name_length = data[pos]
        pos += 1
        name = data[pos:pos + name_length].decode("macroman", "replace")
        pos += name_length
        pos += (4 - ((1 + name_length) % 4)) % 4
        while pos + 12 <= extra_end:
            key = data[pos + 4:pos + 8]
            block_length = u32(data, pos + 8)
            pos += 12
            block = data[pos:pos + block_length]
            pos += block_length + (block_length % 2)
            if key == b"luni" and len(block) >= 4:
                char_count = u32(block, 0)
                name = block[4:4 + char_count * 2].decode("utf-16be", "replace")
        pos = extra_end
        records.append({
            "name": name.strip() or f"layer-{order + 1}",
            "left": left, "top": top, "right": right, "bottom": bottom,
            "channels": channel_records, "order": order,
        })

    layers = []
    for record in records:
        layer_width = max(0, record["right"] - record["left"])
        layer_height = max(0, record["bottom"] - record["top"])
        decoded = {}
        for channel_id, length in record["channels"]:
            raw = data[pos:pos + length]
            pos += length
            if layer_width and layer_height:
                decoded[channel_id] = decode_channel(raw, layer_width, layer_height)
        if not layer_width or not layer_height:
            continue
        count = layer_width * layer_height
        red = decoded.get(0, b"\0" * count)
        green = decoded.get(1, b"\0" * count)
        blue = decoded.get(2, b"\0" * count)
        alpha = decoded.get(-1, b"\xff" * count)
        rgba = bytearray(count * 4)
        for index in range(count):
            offset = index * 4
            rgba[offset:offset + 4] = bytes((red[index], green[index], blue[index], alpha[index]))
        layers.append(Layer(
            record["name"], record["left"], record["top"], record["right"],
            record["bottom"], bytes(rgba), record["order"],
        ))
    if pos != layer_info_end:
        # Some PSD writers append padding. A mismatch is not fatal when layers decoded.
        pass
    return width, height, layers


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    stride = width * 4
    rows = b"".join(b"\0" + rgba[y * stride:(y + 1) * stride] for y in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(rows, 9)) + png_chunk(b"IEND", b"")


def full_canvas_rgba(canvas_width: int, canvas_height: int, layer: Layer) -> bytes:
    output = bytearray(canvas_width * canvas_height * 4)
    source_stride = layer.width * 4
    for source_y in range(layer.height):
        target_y = layer.top + source_y
        if target_y < 0 or target_y >= canvas_height:
            continue
        source_x0 = max(0, -layer.left)
        target_x0 = max(0, layer.left)
        copy_width = min(layer.width - source_x0, canvas_width - target_x0)
        if copy_width <= 0:
            continue
        source_start = source_y * source_stride + source_x0 * 4
        target_start = (target_y * canvas_width + target_x0) * 4
        output[target_start:target_start + copy_width * 4] = layer.rgba[source_start:source_start + copy_width * 4]
    return bytes(output)


def alpha_bounds(width: int, height: int, rgba: bytes, threshold: int = 3) -> tuple[int, int, int, int]:
    left, top, right, bottom = width, height, -1, -1
    for y in range(height):
        row = y * width * 4
        for x in range(width):
            if rgba[row + x * 4 + 3] > threshold:
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
    if right < left:
        return 0, 0, width, height
    return left, top, right + 1, bottom + 1


def crop_rgba(width: int, height: int, rgba: bytes, box: tuple[int, int, int, int], margin: int = 8) -> tuple[int, int, bytes]:
    left, top, right, bottom = box
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(width, right + margin)
    bottom = min(height, bottom + margin)
    crop_width, crop_height = right - left, bottom - top
    output = bytearray(crop_width * crop_height * 4)
    for y in range(crop_height):
        source_start = ((top + y) * width + left) * 4
        target_start = y * crop_width * 4
        output[target_start:target_start + crop_width * 4] = rgba[source_start:source_start + crop_width * 4]
    return crop_width, crop_height, bytes(output)


def safe_id(text: str, fallback: str = "wardrobe") -> str:
    ascii_text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if ascii_text:
        return ascii_text[:48]
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
    return f"{fallback}-{digest}"


def extract_psd(upload: bytes, filename: str) -> bytes:
    if filename.lower().endswith(".zip") or upload[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(upload)) as archive:
            candidates = [name for name in archive.namelist() if name.lower().endswith(".psd") and not name.startswith("__MACOSX/")]
            if not candidates:
                raise ValueError("ZIP 里没有找到 PSD")
            return archive.read(candidates[0])
    return upload


def normalized_layer_name(name: str) -> str:
    return re.sub(r"[\s_-]+", "", name.lower())


def detect_slot(name: str) -> str:
    normalized = normalized_layer_name(name)
    direct = SLOT_MAP.get(normalized, "")
    if direct:
        return direct
    for keyword, slot in SLOT_MAP.items():
        if keyword and keyword in normalized:
            return slot
    return ""


def png_canvas_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24 or data[12:16] != b"IHDR":
        raise ValueError("请上传透明 PNG、PSD 或 PSD.ZIP")
    width, height = struct.unpack(">II", data[16:24])
    if width < 64 or height < 64 or width > 8192 or height > 8192:
        raise ValueError("PNG 尺寸不正常")
    return width, height


def load_catalog() -> dict:
    if CATALOG_JSON.exists():
        try:
            data = json.loads(CATALOG_JSON.read_text("utf-8"))
            data.setdefault("version", 1)
            data.setdefault("base", None)
            data.setdefault("items", [])
            return data
        except Exception:
            pass
    return {"version": 1, "generatedAt": "", "base": None, "items": []}


def save_catalog(catalog: dict) -> None:
    catalog["version"] = int(catalog.get("version", 0)) + 1
    catalog["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    CATALOG_JSON.write_text(text, "utf-8")
    CATALOG_JS.write_text("window.LEITH_WARDROBE_CATALOG = " + text.rstrip() + ";\n", "utf-8")


def create_session(upload: bytes, filename: str) -> dict:
    if filename.lower().endswith(".png") or upload[:8] == b"\x89PNG\r\n\x1a\n":
        canvas_width, canvas_height = png_canvas_size(upload)
        token = uuid.uuid4().hex
        folder = SESSIONS_ROOT / token
        folder.mkdir(parents=True, exist_ok=True)
        full_name = "00-clothing.png"
        (folder / full_name).write_bytes(upload)
        slot = detect_slot(Path(filename).stem) or "top"
        session = {
            "token": token,
            "filename": filename,
            "folder": str(folder),
            "canvas": [canvas_width, canvas_height],
            "crop": [0, 0, canvas_width, canvas_height],
            "layers": [{
                "index": 0,
                "name": Path(filename).stem,
                "slot": slot,
                "slotLabel": SLOT_LABELS[slot],
                "selected": True,
                "preview": f"/preview/{token}/{full_name}",
                "fullFile": full_name,
                "thumbFile": full_name,
                "bounds": [0, 0, canvas_width, canvas_height],
                "order": 0,
            }],
        }
        SESSIONS[token] = session
        return {key: value for key, value in session.items() if key != "folder"}

    psd = extract_psd(upload, filename)
    canvas_width, canvas_height, layers = read_psd(psd)
    token = uuid.uuid4().hex
    folder = SESSIONS_ROOT / token
    folder.mkdir(parents=True, exist_ok=True)
    response_layers = []
    union_left, union_top, union_right, union_bottom = canvas_width, canvas_height, 0, 0
    for index, layer in enumerate(layers):
        slot = detect_slot(layer.name)
        # 人脸、头发、眼睛、四肢都是固定人物的一部分，衣物上新时完全不展示也不处理。
        if slot not in ALLOWED_SLOTS:
            continue
        full = full_canvas_rgba(canvas_width, canvas_height, layer)
        full_name = f"{index:02d}-{safe_id(layer.name, 'layer')}.png"
        (folder / full_name).write_bytes(encode_png(canvas_width, canvas_height, full))
        bounds = alpha_bounds(canvas_width, canvas_height, full)
        union_left = min(union_left, bounds[0])
        union_top = min(union_top, bounds[1])
        union_right = max(union_right, bounds[2])
        union_bottom = max(union_bottom, bounds[3])
        thumb_width, thumb_height, thumb = crop_rgba(canvas_width, canvas_height, full, bounds, 12)
        thumb_name = f"{index:02d}-{safe_id(layer.name, 'layer')}-thumb.png"
        (folder / thumb_name).write_bytes(encode_png(thumb_width, thumb_height, thumb))
        response_layers.append({
            "index": index,
            "name": layer.name,
            "slot": slot,
            "slotLabel": SLOT_LABELS.get(slot, "身体/结构层"),
            "selected": bool(slot),
            "preview": f"/preview/{token}/{thumb_name}",
            "fullFile": full_name,
            "thumbFile": thumb_name,
            "bounds": list(bounds),
            "order": layer.order,
        })
    if not response_layers:
        raise ValueError("没有识别到衣物图层。推荐直接上传透明 PNG；PSD 图层名可用 topwear、bottomwear、dress、legwear、footwear、headwear。")
    crop = [
        max(0, union_left - 14), max(0, union_top - 14),
        min(canvas_width, union_right + 14), min(canvas_height, union_bottom + 14),
    ]
    session = {
        "token": token,
        "filename": filename,
        "folder": str(folder),
        "canvas": [canvas_width, canvas_height],
        "crop": crop,
        "layers": response_layers,
    }
    SESSIONS[token] = session
    return {key: value for key, value in session.items() if key != "folder"}


def publish(payload: dict) -> dict:
    token = str(payload.get("token", ""))
    session = SESSIONS.get(token)
    if not session:
        raise ValueError("预览已过期，请重新选择文件")
    pack_name = str(payload.get("packName", "新衣物包")).strip() or "新衣物包"
    pack_id = safe_id(str(payload.get("packId", "")) or pack_name, "pack")
    target = ASSETS / pack_id
    target.mkdir(parents=True, exist_ok=True)
    session_folder = Path(session["folder"])
    selected = payload.get("layers", [])
    by_index = {int(layer["index"]): layer for layer in session["layers"]}
    catalog = load_catalog()

    added = []
    existing_ids = {item.get("id") for item in catalog.get("items", [])}
    for selected_layer in selected:
        index = int(selected_layer["index"])
        source = by_index[index]
        slot = str(selected_layer.get("slot") or source.get("slot") or "top")
        if slot not in ALLOWED_SLOTS:
            slot = "top"
        name = str(selected_layer.get("name") or source["name"]).strip()
        item_id = safe_id(str(selected_layer.get("id") or f"{pack_id}-{slot}-{name}"), "item")
        if item_id in existing_ids:
            item_id = f"{item_id}-{int(time.time())}"
        asset_name = f"{item_id}.png"
        thumb_name = f"{item_id}-thumb.png"
        shutil.copy2(session_folder / source["fullFile"], target / asset_name)
        shutil.copy2(session_folder / source["thumbFile"], target / thumb_name)
        item = {
            "id": item_id,
            "name": name,
            "emoji": str(selected_layer.get("emoji") or "👗"),
            "price": max(1, int(selected_layer.get("price") or 36)),
            "slot": slot,
            "asset": f"wardrobe/assets/{pack_id}/{asset_name}",
            "thumbnail": f"wardrobe/assets/{pack_id}/{thumb_name}",
            "sourcePack": pack_id,
            "sourceLayer": source["name"],
            "style": str(selected_layer.get("style") or ""),
            "note": str(selected_layer.get("note") or ""),
            "addedAt": int(time.time() * 1000),
        }
        catalog.setdefault("items", []).append(item)
        existing_ids.add(item_id)
        added.append(item)
    save_catalog(catalog)
    return {"message": f"已上架 {len(added)} 件衣物", "version": catalog["version"], "items": added}


STUDIO_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leithhome 衣物工坊</title>
<style>
:root{color-scheme:dark;--bg:#171719;--card:#222225;--line:#3b383c;--ink:#f3edef;--dim:#aaa1a4;--rose:#d19aa8;--rose2:#ad7485}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#342a30,transparent 36%),var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.wrap{max-width:1120px;margin:auto;padding:34px 20px 80px}.head{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:22px}h1{margin:0;font:600 28px Georgia,serif}.sub{color:var(--dim);margin-top:6px}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 12px;color:var(--dim)}
.drop{border:1.5px dashed #665b61;border-radius:24px;padding:34px;text-align:center;background:rgba(255,255,255,.025);cursor:pointer;transition:.2s}.drop.over,.drop:hover{border-color:var(--rose);background:rgba(209,154,168,.07)}.drop strong{display:block;font-size:16px}.drop span{display:block;color:var(--dim);font-size:12px;margin-top:6px}
.maker{margin-bottom:18px;padding:18px;border:1px solid var(--line);border-radius:22px;background:rgba(255,255,255,.025)}.maker h2{font-size:16px;margin:0 0 5px}.maker-grid{display:grid;grid-template-columns:180px 1fr auto;gap:10px;margin-top:12px}.maker select,.maker input,.maker textarea{width:100%;border:1px solid var(--line);border-radius:11px;background:#19191b;color:var(--ink);padding:10px;font:inherit}.maker textarea{display:none;min-height:116px;margin-top:10px;resize:vertical}.maker-actions{display:none;gap:8px;margin-top:9px}.secondary{border:1px solid var(--line);border-radius:10px;padding:9px 13px;color:var(--ink);background:#302d31;cursor:pointer}
.toolbar{display:none;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:18px 0}.field{background:var(--card);border:1px solid var(--line);border-radius:15px;padding:10px 12px}.field label{display:block;color:var(--dim);font-size:11px;margin-bottom:5px}.field input,.field select{width:100%;border:0;outline:0;color:var(--ink);background:transparent;font:inherit}
.kind{display:flex;gap:8px;margin:18px 0}.kind button,button.primary{border:0;border-radius:12px;padding:10px 16px;color:var(--ink);background:#39353a;cursor:pointer}.kind button.active,button.primary{background:linear-gradient(135deg,var(--rose2),var(--rose))}.layers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.layer{display:grid;grid-template-columns:92px 1fr;gap:12px;padding:10px;border:1px solid var(--line);border-radius:17px;background:var(--card);opacity:.52}.layer.on{opacity:1;border-color:#715864}.preview{height:112px;border-radius:12px;background:linear-gradient(45deg,#303034 25%,transparent 25%,transparent 75%,#303034 75%),linear-gradient(45deg,#303034 25%,#27272a 25%,#27272a 75%,#303034 75%);background-size:16px 16px;background-position:0 0,8px 8px;display:flex;align-items:center;justify-content:center;overflow:hidden}.preview img{max-width:94%;max-height:94%;object-fit:contain}.line{display:flex;gap:7px;align-items:center;margin-bottom:7px}.line input[type=text],.line input[type=number],.line select{min-width:0;width:100%;border:1px solid var(--line);border-radius:9px;background:#19191b;color:var(--ink);padding:6px 7px}.small{font-size:11px;color:var(--dim)}.actions{position:sticky;bottom:18px;display:none;justify-content:flex-end;gap:10px;margin-top:22px;padding:12px;border:1px solid var(--line);border-radius:17px;background:rgba(29,28,31,.9);backdrop-filter:blur(16px)}button.primary{font-size:14px;padding:11px 21px}.status{margin-right:auto;color:var(--dim);align-self:center}.empty{padding:24px;text-align:center;color:var(--dim)}
@media(max-width:900px){.layers{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.head{display:block}.pill{display:inline-block;margin-top:12px}.toolbar,.maker-grid{grid-template-columns:1fr}.layers{grid-template-columns:1fr}.layer{grid-template-columns:84px 1fr}}
</style></head><body><div class="wrap">
<div class="head"><div><h1>Leithhome 衣物工坊</h1><div class="sub">固定人物不再拆。这里只有生成衣服和上架商品两步。</div></div><div class="pill">仅在这台电脑本地运行 · 不消耗 Leith token</div></div>
<div class="maker"><h2>① 生成衣服</h2><div class="small">写一句想要的款式，工坊会生成一段适配 Susie 固定站姿的生产提示词。复制到你常用的生图工具，最后导出透明 PNG；如果只能得到完整人物图，再用 See-through 拆一次。</div><div class="maker-grid"><select id="promptSlot"><option value="top">上衣</option><option value="bottom">下装（半身裙/裤子）</option><option value="dress">连衣裙</option><option value="socks">袜子/丝袜</option><option value="shoes">鞋子</option><option value="hat">帽子</option></select><input id="promptIdea" placeholder="例如：奶油白男友衬衫，袖口宽松，柔软居家感"><button class="primary" id="buildPrompt">生成提示词</button></div><textarea id="promptOutput" readonly></textarea><div class="maker-actions" id="promptActions"><button class="secondary" id="copyPrompt">复制提示词</button><span class="small" style="align-self:center">生成完成后，把透明 PNG 拖到下面。</span></div></div>
<div class="drop" id="drop"><strong>② 拖入透明衣服 PNG，直接上架</strong><span>可以一次选择多张 PNG；也兼容 See-through 的 PSD / ZIP，人物结构层会自动忽略</span><input id="file" type="file" accept=".png,.psd,.zip" multiple hidden></div>
<div class="toolbar" id="toolbar"><div class="field"><label>衣物包名称</label><input id="packName" value="新衣物包"></div><div class="field"><label>文件夹 ID（英文，可不改）</label><input id="packId" value="new-pack"></div><div class="field"><label>默认价格</label><input id="defaultPrice" type="number" value="36" min="1"></div></div>
<div class="layers" id="layers"></div>
<div class="actions" id="actions"><div class="status" id="status">等待选择图层</div><button class="primary" id="publish">写入衣物目录</button></div>
</div><script>
let session=null;
const $=s=>document.querySelector(s), drop=$('#drop'), file=$('#file'), layers=$('#layers');
const promptNames={top:'上衣',bottom:'下装（半身裙或裤子）',dress:'连衣裙',socks:'袜子或丝袜',shoes:'鞋子',hat:'帽子'};
$('#buildPrompt').onclick=()=>{const slot=$('#promptSlot').value,idea=$('#promptIdea').value.trim();if(!idea)return alert('先写想要什么衣服');const text=`以提供的 Susie 固定人物立绘为唯一姿势和比例参考，为她设计一件${promptNames[slot]}：${idea}。保持正面站立、双臂自然垂下、身体比例和画布位置完全一致，不改变脸、头发、眼镜、肤色和身体。服装边缘清晰，日系精致换装游戏立绘风格，柔和低饱和配色，线条与原人物一致。最终优先输出 1024×1024 透明背景 PNG，只保留${promptNames[slot]}本身，其他人体和背景透明；如果工具无法只生成衣物，则输出完整人物但不要改变姿势，供后续 See-through 拆层。不要文字、不要水印、不要第二个人物。`;$('#promptOutput').value=text;$('#promptOutput').style.display='block';$('#promptActions').style.display='flex'};
$('#copyPrompt').onclick=async()=>{await navigator.clipboard.writeText($('#promptOutput').value);$('#copyPrompt').textContent='已复制'};
drop.onclick=()=>file.click(); drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')}; drop.ondragleave=()=>drop.classList.remove('over'); drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over'); if(e.dataTransfer.files.length) upload([...e.dataTransfer.files])}; file.onchange=()=>file.files.length&&upload([...file.files]);
async function upload(files){drop.innerHTML='<strong>正在读取衣物…</strong><span>共 '+files.length+' 个文件</span>';try{const sessions=[];for(const f of files){const form=new FormData();form.append('file',f);const r=await fetch('/api/import',{method:'POST',body:form});const data=await r.json();if(!r.ok)throw Error(f.name+'：'+data.error);sessions.push(data)}session={filename:files.map(f=>f.name).join('、'),sessions,layers:sessions.flatMap(s=>s.layers.map(l=>({...l,token:s.token,canvas:s.canvas})))};render();}catch(e){drop.innerHTML='<strong>读取失败</strong><span>'+e.message+' · 点这里重试</span>';}}
function render(){drop.innerHTML='<strong>已读取 '+session.layers.length+' 件衣物</strong><span>'+session.filename+' · 点击可换文件</span><input id="file2" type="file" accept=".png,.psd,.zip" multiple hidden>';drop.onclick=()=>$('#file2').click();$('#file2').onchange=()=>$('#file2').files.length&&upload([...$('#file2').files]);$('#toolbar').style.display='grid';$('#actions').style.display='flex';layers.innerHTML=session.layers.map(layerCard).join('');bindCards();updateStatus();}
function layerCard(l){const slot=l.slot||'top';return `<div class="layer ${l.selected?'on':''}" data-token="${l.token}" data-index="${l.index}"><div class="preview"><img src="${l.preview}"></div><div><div class="line"><input class="take" type="checkbox" ${l.selected?'checked':''}><strong>${escapeHtml(l.name)}</strong></div><div class="line"><select class="slot"><option value="top" ${slot==='top'?'selected':''}>上衣</option><option value="bottom" ${slot==='bottom'?'selected':''}>下装（半身裙/裤子）</option><option value="dress" ${slot==='dress'?'selected':''}>连衣裙</option><option value="socks" ${slot==='socks'?'selected':''}>袜子/丝袜</option><option value="shoes" ${slot==='shoes'?'selected':''}>鞋子</option><option value="hat" ${slot==='hat'?'selected':''}>帽子</option></select></div><div class="line"><input class="name" type="text" value="${escapeAttr(defaultName(l))}" placeholder="商品名"></div><div class="line"><input class="price" type="number" min="1" value="36"><input class="emoji" type="text" value="${emoji(slot)}" maxlength="4" style="max-width:48px"></div><div class="line"><input class="style" type="text" placeholder="风格标签，用、分隔"></div><div class="line"><input class="note" type="text" placeholder="Leith 的一句备注"></div><div class="small">只会上架这一件衣服，不会动人物底图</div></div></div>`}
function defaultName(l){const names={top:'新上衣',bottom:'新下装',dress:'新连衣裙',socks:'新袜子',shoes:'新鞋子',hat:'新帽子'};return names[l.slot]||l.name} function emoji(slot){return ({top:'👚',bottom:'👗',dress:'👗',socks:'🧦',shoes:'👞',hat:'👒'})[slot]||'👗'}
function bindCards(){document.querySelectorAll('.layer').forEach(card=>{const box=card.querySelector('.take');box.onchange=()=>{card.classList.toggle('on',box.checked);updateStatus()};card.querySelector('.slot').onchange=e=>card.querySelector('.emoji').value=emoji(e.target.value)})}
function updateStatus(){const n=document.querySelectorAll('.take:checked').length;$('#status').textContent=`将上架 ${n} 件衣物商品`}
$('#defaultPrice').oninput=e=>document.querySelectorAll('.price').forEach(input=>input.value=e.target.value);
$('#packName').oninput=e=>{if($('#packId').dataset.touched!=='1')$('#packId').value='pack-'+Date.now().toString().slice(-6)};$('#packId').oninput=e=>e.target.dataset.touched='1';
$('#publish').onclick=async()=>{if(!session)return;const cards=[...document.querySelectorAll('.layer')].filter(c=>c.querySelector('.take').checked);if(!cards.length)return alert('至少选择一件衣物');const groups={};cards.forEach(c=>(groups[c.dataset.token]??=[]).push({index:+c.dataset.index,slot:c.querySelector('.slot').value,name:c.querySelector('.name').value,price:+c.querySelector('.price').value,emoji:c.querySelector('.emoji').value,style:c.querySelector('.style').value,note:c.querySelector('.note').value}));$('#publish').disabled=true;$('#status').textContent='正在整理图片并更新目录…';try{let total=0;for(const [token,items] of Object.entries(groups)){const r=await fetch('/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,packName:$('#packName').value,packId:$('#packId').value,layers:items})});const data=await r.json();if(!r.ok)throw Error(data.error);total+=data.items.length}$('#status').textContent='已上架 '+total+' 件衣物 · 刷新 Leithhome 即可看到';alert('已上架 '+total+' 件衣物！');}catch(e){$('#status').textContent='失败：'+e.message}finally{$('#publish').disabled=false}};
function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function escapeAttr(s){return escapeHtml(s).replace(/"/g,'&quot;')}
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "LeithWardrobeStudio/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print("[衣物工坊]", fmt % args)

    def send_bytes(self, status: int, content_type: str, data: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status: int, payload: dict) -> None:
        self.send_bytes(status, "application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_bytes(200, "text/html; charset=utf-8", STUDIO_HTML.encode("utf-8"))
            return
        if parsed.path.startswith("/preview/"):
            parts = [unquote(part) for part in parsed.path.split("/") if part]
            if len(parts) != 3 or parts[0] != "preview" or parts[1] not in SESSIONS:
                self.send_json(404, {"error": "预览不存在"})
                return
            folder = Path(SESSIONS[parts[1]]["folder"]).resolve()
            candidate = (folder / Path(parts[2]).name).resolve()
            if candidate.parent != folder or not candidate.exists():
                self.send_json(404, {"error": "预览不存在"})
                return
            self.send_bytes(200, "image/png", candidate.read_bytes())
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            if self.path == "/api/import":
                form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={
                    "REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                })
                field = form["file"] if "file" in form else None
                if field is None or not getattr(field, "file", None):
                    raise ValueError("没有收到文件")
                upload = field.file.read()
                if len(upload) > 80 * 1024 * 1024:
                    raise ValueError("文件超过 80MB")
                self.send_json(200, create_session(upload, field.filename or "upload.psd"))
                return
            if self.path == "/api/publish":
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self.send_json(200, publish(payload))
                return
            self.send_json(404, {"error": "not found"})
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    print(f"\nLeithhome 衣物工坊已启动：{url}")
    print("关闭这个终端窗口即可停止。\n")
    threading.Timer(0.45, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
