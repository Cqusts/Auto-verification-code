#!/usr/bin/env python3
"""Local CAPTCHA OCR service backed by ddddocr.

The extension's bundled Tesseract is trained on printed text and does well on
clean digits and letters. It does not handle the style common on Chinese sites:
whole-image geometric warping, strike-through interference lines, coloured
noise backgrounds. ddddocr is trained on exactly that, so for those sites this
service is the answer rather than more preprocessing tuning.

Runs entirely on your machine; images never leave it.

    pip install ddddocr flask
    python ocr-server/server.py [--port 9898] [--host 127.0.0.1]

Then in the extension: 设置 → 图片验证码 → 识别引擎 = 自建 HTTP 接口
    接口地址        http://127.0.0.1:9898/ocr
    提交格式        JSON + base64
    字段名          image
    结果 JSON 路径  result
"""
import argparse
import base64
import sys

try:
    import ddddocr
except ImportError:
    sys.exit(
        "缺少 ddddocr。请先安装：\n"
        "    pip install ddddocr flask\n"
        "（Python 3.8–3.11 兼容性最好；3.12+ 若装不上可试 pip install ddddocr --no-deps）"
    )

try:
    from flask import Flask, jsonify, request
except ImportError:
    sys.exit("缺少 flask。请先安装：pip install flask")


parser = argparse.ArgumentParser(description="本地验证码识别服务")
parser.add_argument("--port", type=int, default=9898)
parser.add_argument("--host", default="127.0.0.1")
args = parser.parse_args()

app = Flask(__name__)
ocr = ddddocr.DdddOcr(show_ad=False)


def read_image():
    """Accepts all three formats the extension can send."""
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        data = payload.get("image") or payload.get("file") or payload.get("img")
        if data:
            # Tolerate a full data: URL as well as bare base64.
            if "," in data[:64] and data.lstrip().startswith("data:"):
                data = data.split(",", 1)[1]
            return base64.b64decode(data)
    if request.files:
        return next(iter(request.files.values())).read()
    if request.form:
        for key in ("image", "file", "img"):
            if key in request.form:
                return base64.b64decode(request.form[key])
    if request.data:
        return request.data
    return None


@app.post("/ocr")
def solve():
    try:
        raw = read_image()
    except Exception as exc:  # noqa: BLE001 - report, never crash the service
        return jsonify(result="", error=f"bad image payload: {exc}"), 400
    if not raw:
        return jsonify(result="", error="no image in request"), 400
    try:
        text = ocr.classification(raw)
    except Exception as exc:  # noqa: BLE001
        return jsonify(result="", error=str(exc)), 500
    print(f"  识别 -> {text}", flush=True)
    return jsonify(result=text)


@app.get("/")
@app.get("/status")
def status():
    return jsonify(service="auto-verification-code ocr", engine="ddddocr", ok=True)


print("Auto Verification Code — 本地验证码识别服务 (ddddocr)")
print(f"  监听            http://{args.host}:{args.port}")
print("")
print("  扩展设置 → 图片验证码：")
print("    识别引擎        自建 HTTP 接口")
print(f"    接口地址        http://127.0.0.1:{args.port}/ocr")
print("    提交格式        JSON + base64")
print("    字段名          image")
print("    结果 JSON 路径  result")
print("")
app.run(host=args.host, port=args.port, threaded=True)
