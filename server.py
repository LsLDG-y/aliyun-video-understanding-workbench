# -*- coding: utf-8 -*-
"""
视频理解工作台 · 本地服务（纯 Python 标准库实现，无需安装任何第三方包）

职责：
 1. 托管前端页面（index.html / assets/*）
 2. 代理「视频文件上传」：获取百炼上传凭证 → 上传至百炼临时 OSS → 返回 oss:// 临时 URL（48h 有效）
 3. 代理「对话 / 模型列表」：转发百炼 OpenAI 兼容 API（流式 SSE 透传），
    并自动为 oss:// 资源添加 X-DashScope-OssResourceResolve 请求头
 4. 保存 / 读取本机配置（config.json，包含 API Key，仅本机使用）

运行：python server.py   （或双击 启动.cmd）
"""

import json
import os
import re
import sys
import time
import threading
import webbrowser
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4 as uuid_like

# 版本门槛：提前拦截（f-string / ThreadingHTTPServer 等要求 3.8+），
# 给出明确提示而不是晦涩的 traceback
if sys.version_info < (3, 8):
    print("[ERROR] Video Understanding Workbench requires Python 3.8 or newer. "
          "Current: %d.%d.%d" % sys.version_info[:3])
    print("Please install a newer Python from https://www.python.org/downloads/ "
          "(check 'Add python.exe to PATH').")
    sys.exit(1)

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "config.json")
HOST = "127.0.0.1"
VERSION = "1.0"
PREFERRED_PORTS = [8686, 8687, 8688, 8689, 8690, 8710]
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com"
UPLOAD_API = "/api/v1/uploads"
CHAT_API = "/compatible-mode/v1/chat/completions"
MODELS_API = "/compatible-mode/v1/models"
CHUNK = 1024 * 1024  # 1MB

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


# ---------------------------------------------------------------- 配置
def load_config():
    cfg = {"apiKey": "", "baseUrl": DEFAULT_BASE_URL, "priceIn": None, "priceOut": None}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update({k: data[k] for k in cfg if k in data})
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


CONFIG = load_config()


def http_json(url, method="GET", headers=None, body=None, timeout=120):
    """返回 (status, bytes or None, headers)"""
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = resp.read()
        return resp.status, data, resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers
    except urllib.error.URLError as e:
        return -1, str(e).encode("utf-8"), {}


# ---------------------------------------------------------------- 上传（流式 multipart）
class MultipartBody:
    """把 head + 文件流 + tail 拼装为 file-like 对象，避免大文件占内存；支持发送进度回调"""

    def __init__(self, head_bytes, file_path, tail_bytes, on_sent=None):
        self.head = head_bytes
        self.tail = tail_bytes
        self.file = open(file_path, "rb")
        self.pos = 0  # head: [0, len(head)); file: [len(head), len(head)+fsize); tail: 之后
        self.file_size = os.path.getsize(file_path)
        self.total = len(head_bytes) + self.file_size + len(tail_bytes)
        self.on_sent = on_sent

    def _notify(self):
        if self.on_sent:
            try:
                self.on_sent(self.pos, self.total)
            except Exception:
                self.on_sent = None

    def read(self, size=-1):
        if size is None or size < 0:
            size = CHUNK
        out = bytearray()
        # head 部分
        if self.pos < len(self.head):
            take = min(size, len(self.head) - self.pos)
            out += self.head[self.pos:self.pos + take]
            self.pos += take
            self._notify()
            return bytes(out)
        # 文件部分
        fstart = len(self.head)
        fend = fstart + self.file_size
        if self.pos < fend:
            take = min(size, fend - self.pos)
            data = self.file.read(take)
            self.pos += len(data)
            self._notify()
            return data
        # tail 部分
        if len(out) < size:
            tstart = fend
            # tail 起点按 pos 计算
            tail_start = self.pos - fend
            if tail_start < len(self.tail):
                take = min(size - len(out), len(self.tail) - tail_start)
                out += self.tail[tail_start:tail_start + take]
                self.pos += take
        self._notify()
        return bytes(out)

    def close(self):
        try:
            self.file.close()
        except Exception:
            pass


def build_multipart(fields, file_field_name, filename, file_path, content_type, on_sent=None):
    boundary = "----VDU" + str(int(time.time() * 1000))
    lines = []
    for k, v in fields.items():
        lines.append(("--" + boundary).encode())
        lines.append(('Content-Disposition: form-data; name="%s"' % k).encode())
        lines.append(b"")
        lines.append(str(v).encode("utf-8"))
    lines.append(("--" + boundary).encode())
    lines.append(('Content-Disposition: form-data; name="%s"; filename="%s"' % (
        file_field_name, re.sub(r'["\\\r\n]', "_", filename))).encode())
    lines.append(("Content-Type: %s" % content_type).encode())
    lines.append(b"")
    head = b"\r\n".join(lines + [b""])
    tail = b"\r\n--" + boundary.encode() + b"--\r\n"
    return MultipartBody(head, file_path, tail, on_sent), boundary, head + tail


class UploadCancelled(Exception):
    """主动取消上传：worker 停止转存并清理临时文件"""


def _trunc(s, n=300):
    s = str(s)
    return s if len(s) <= n else s[:n] + "…（已截断）"


def upload_file(api_key, base_url, model, file_path, file_name, content_type, on_sent=None):
    """上传视频文件到百炼临时存储，返回 oss:// URL（on_sent: 已发送字节/总字节回调）

    超时语义（重要）：
      - getPolicy：60 秒 × 最多 2 次重试（凭证接口偶发抖动不应让大文件上传失败）
      - OSS 上传：timeout 是 socket 级（单次连接/读写阻塞上限），不是总时长墙钟；
        大文件总时长由前端「进度活跃度」轮询兜底（有进展即续命），两边不再互相误杀
    """
    policy_url = base_url.rstrip("/") + UPLOAD_API + "?" + urllib.parse.urlencode(
        {"action": "getPolicy", "model": model})
    policy = None
    last_err = ""
    for attempt in range(3):
        try:
            status, data, _ = http_json(policy_url, headers={
                "Authorization": "Bearer " + api_key,
                "Content-Type": "application/json",
            }, timeout=60)
            if status == 200:
                policy = json.loads(data)["data"]
                break
            last_err = "HTTP %s %s" % (status, _trunc(data.decode("utf-8", "replace")))
        except (ValueError, KeyError) as e:
            last_err = "响应解析失败: %s" % _trunc(e)
        except Exception as e:  # noqa: BLE001  网络异常也重试
            last_err = "网络异常: %s" % _trunc(e)
        time.sleep(1 + attempt)  # 退避 1s / 2s
    if policy is None:
        raise RuntimeError("获取上传凭证失败（%d 次尝试）: %s" % (3, last_err))

    key = "%s/%s" % (policy["upload_dir"].rstrip("/"), file_name)
    fields = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "Signature": policy["signature"],
        "policy": policy["policy"],
        "x-oss-object-acl": policy["x_oss_object_acl"],
        "x-oss-forbid-overwrite": policy["x_oss_forbid_overwrite"],
        "key": key,
        "success_action_status": "200",
    }
    body, boundary, _ = build_multipart(fields, "file", file_name, file_path, content_type, on_sent)
    try:
        req = urllib.request.Request(policy["upload_host"], data=body, method="POST", headers={
            "Content-Type": "multipart/form-data; boundary=" + boundary,
        })
        resp = urllib.request.urlopen(req, timeout=3600)
        resp.read()
        status = resp.status
    finally:
        body.close()
    if status != 200:
        raise RuntimeError("上传文件到临时存储失败: HTTP %s" % status)
    return "oss://" + key


# ---------------------------------------------------------------- 对话转发（SSE）
def build_chat_headers(api_key, url_text):
    h = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    }
    if "oss://" in url_text:
        h["X-DashScope-OssResourceResolve"] = "enable"
    return h


# ---------------------------------------------------------------- HTTP Handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "VideoUnderstandWorkbench/" + VERSION

    # ---- 工具
    def log_message(self, fmt, *args):  # 安静日志
        pass

    def handle_one_request(self):
        # 客户端（浏览器标签页关闭/刷新）异常断开连接时 socketserver 会打印扰人堆栈，这里静音
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionError):
            pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        remain = length
        buf = bytearray()
        while remain > 0:
            chunk = self.rfile.read(min(CHUNK, remain))
            if not chunk:
                break
            buf += chunk
            remain -= len(chunk)
        return bytes(buf)

    # ---- 路由
    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path.startswith("/api/"):
                return self.api_get(path, parsed)
            return self.static(path)
        except Exception as e:  # noqa: BLE001  任何未预期异常都返回 JSON，避免连接静默断开
            self._server_error(e)

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                return self.api_post(parsed.path, parsed)
            self.send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._server_error(e)

    def _server_error(self, e):
        import traceback
        traceback.print_exc()
        try:
            self.send_json({"error": "服务器内部错误: %s" % e}, 500)
        except Exception:
            pass

    # ---- API: GET
    def api_get(self, path, parsed):
        if path == "/api/health":
            return self.send_json({
                "ok": True, "version": VERSION,
                "hasKey": bool(CONFIG.get("apiKey")),
                "baseUrl": CONFIG.get("baseUrl", DEFAULT_BASE_URL),
            })
        if path == "/api/config":
            return self.send_json({
                "hasKey": bool(CONFIG.get("apiKey")),
                "baseUrl": CONFIG.get("baseUrl", DEFAULT_BASE_URL),
                "priceIn": CONFIG.get("priceIn"),
                "priceOut": CONFIG.get("priceOut"),
            })
        if path == "/api/upload_status":
            key = (parsed.query and dict(urllib.parse.parse_qsl(parsed.query)).get("key")) or ""
            st = _upload_state(key) if key else None
            if st is None:
                return self.send_json({"error": "未知的上传任务"}, 404)
            return self.send_json({
                "phase": st.get("phase", "received"),
                "progress": st.get("progress", 0),
                "result": st.get("result"),
                "error": st.get("error"),
            })
        if path == "/api/models":
            if not CONFIG.get("apiKey"):
                return self.send_json({"error": "未配置 API Key，请先在设置中填写"}, 400)
            url = CONFIG["baseUrl"].rstrip("/") + MODELS_API
            status, data, _ = http_json(url, headers={"Authorization": "Bearer " + CONFIG["apiKey"]}, timeout=60)
            if status != 200:
                try:
                    err = json.loads(data)
                    msg = err.get("error", {}).get("message", data.decode("utf-8", "replace"))
                except Exception:
                    msg = data.decode("utf-8", "replace")
                return self.send_json({"error": "获取模型列表失败 (HTTP %s): %s" % (status, _trunc(msg, 300))}, status)
            try:
                obj = json.loads(data)
                ids = [m.get("id") for m in obj.get("data", []) if m.get("id")]
            except Exception:
                ids = []
            return self.send_json({"models": ids})
        self.send_json({"error": "not found"}, 404)

    # ---- API: POST
    def api_post(self, path, parsed):
        cfg = CONFIG
        if path == "/api/config":
            try:
                body = json.loads(self.read_body() or b"{}")
            except json.JSONDecodeError:
                return self.send_json({"error": "无效 JSON"}, 400)
            if "apiKey" in body:
                cfg["apiKey"] = (body.get("apiKey") or "").strip()
            if "baseUrl" in body:
                url = (body.get("baseUrl") or "").strip()
                if url and not url.startswith(("http://", "https://")):
                    return self.send_json({"error": "Base URL 必须以 http:// 或 https:// 开头"}, 400)
                cfg["baseUrl"] = url or DEFAULT_BASE_URL
            if "priceIn" in body:
                try:
                    cfg["priceIn"] = float(body["priceIn"]) if body["priceIn"] not in (None, "") else None
                except (TypeError, ValueError):
                    cfg["priceIn"] = None
            if "priceOut" in body:
                try:
                    cfg["priceOut"] = float(body["priceOut"]) if body["priceOut"] not in (None, "") else None
                except (TypeError, ValueError):
                    cfg["priceOut"] = None
            save_config(cfg)
            return self.send_json({"ok": True, "hasKey": bool(cfg.get("apiKey"))})

        if path == "/api/checkurl":
            try:
                body = json.loads(self.read_body() or b"{}")
            except json.JSONDecodeError:
                return self.send_json({"error": "无效 JSON"}, 400)
            url = (body.get("url") or "").strip()
            if not url.startswith(("http://", "https://")):
                return self.send_json({"error": "URL 必须以 http:// 或 https:// 开头"}, 400)
            # 先 HEAD，部分服务器拒绝 HEAD 时降级为 Range GET
            def probe(method):
                headers = {"User-Agent": "Mozilla/5.0"}
                if method == "GET":
                    headers["Range"] = "bytes=0-0"
                rr = urllib.request.Request(url, method=method, headers=headers)
                return urllib.request.urlopen(rr, timeout=25)
            cl, ct, status = None, None, None
            for method in ("HEAD", "GET"):
                try:
                    r = probe(method)
                    status = r.status
                    cl = r.headers.get("Content-Length")
                    ct = r.headers.get("Content-Type")
                    break
                except urllib.error.HTTPError as e:
                    status = e.code
                    cl = e.headers.get("Content-Length")
                    ct = e.headers.get("Content-Type")
                    break
                except Exception as e:
                    return self.send_json({"error": "无法访问该 URL: %s" % e}, 400)
            cl_num = None
            try:
                cl_num = int(cl) if cl else None
            except (TypeError, ValueError):
                cl_num = None
            good_cl = cl_num is not None and cl_num > 0
            good_ct = bool(ct) and (ct.startswith("video/") or "mp4" in ct.lower() or "octet-stream" in ct.lower())
            return self.send_json({
                "ok": True, "status": status, "contentLength": cl_num, "contentType": ct,
                "hasCL": good_cl, "hasCT": good_ct,
                "warning": None if (good_cl and good_ct) else (
                    "响应头缺少 Content-Length（或为 0），百炼无法下载该文件" if not good_cl else
                    "响应头 Content-Type 不是视频类型（%s），可能无法识别" % ct),
            })

        if path == "/api/upload":
            if not cfg.get("apiKey"):
                return self.send_json({"error": "未配置 API Key，请先在设置中填写"}, 400)
            content_type = self.headers.get("Content-Type", "")
            m = re.search(r'boundary=([^;]+)', content_type)
            length = int(self.headers.get("Content-Length") or 0)
            if not m:
                return self.send_json({"error": "需要 multipart/form-data 请求"}, 400)
            if length <= 0:
                return self.send_json({"error": "缺少 Content-Length"}, 400)
            boundary = m.group(1).strip().strip('"')
            # tmp 文件名：pid + uuid 片段，避免同一秒内重试/并发上传互相覆盖同一个文件
            tmp_path = os.path.join(ROOT, "tmp_upload_%s_%s.bin" % (os.getpid(), uuid_like().hex[:12]))
            parser = MultipartParser(self.rfile, length, boundary)
            parser.file_sink = lambda fn: open(tmp_path, "wb")  # 视频文件直接落盘
            model = ""
            file_name = None
            file_size = 0
            parse_err = None
            try:
                for part in parser.read():
                    if part["filename"] is not None:
                        file_name = part["filename"]
                        file_size = part["size"]
                    elif part["name"] == "model":
                        model = part["data"].decode("utf-8", "replace").strip()
            except (ValueError, OSError) as e:
                # 客户端中断 / 畸形 multipart：清理临时文件后返回错误
                parse_err = "上传中断或请求格式异常: %s" % e
            finally:
                parser.cleanup()
            if parse_err is not None:
                _remove_tmp(tmp_path)
                return self.send_json({"error": parse_err}, 400)
            if not file_name:
                _remove_tmp(tmp_path)
                return self.send_json({"error": "未找到文件字段"}, 400)
            if not model:
                _remove_tmp(tmp_path)
                return self.send_json({"error": "缺少 model 参数"}, 400)
            # 文件名净化：避免把路径分隔符/控制字符带入 OSS key
            file_name = re.sub(r'[\\/:\x00-\x1f"<>|]', "_", file_name)
            # 两阶段上传：此请求只接收文件并落盘，随即返回 uploadKey；
            # 转存（getPolicy + 上传百炼临时 OSS）由后台线程执行，进度通过 /api/upload_status 查询
            key = uuid_like().hex
            _set_upload(key, phase="received", progress=0, error=None)
            content_type = mime_for_file(file_name)
            threading.Thread(target=_oss_upload_worker,
                             args=(key, model, tmp_path, file_name, cfg["apiKey"], cfg["baseUrl"], content_type),
                             daemon=True).start()
            return self.send_json({
                "ok": True,
                "uploadKey": key,
                "fileSize": file_size,
                "fileName": file_name,
                "expireInSeconds": 48 * 3600,
            })

        if path == "/api/upload_cancel":
            key = (parsed.query and dict(urllib.parse.parse_qsl(parsed.query)).get("key")) or ""
            if key:
                _set_upload(key, cancel=True)
            # 幂等：任务不存在/已结束也视为"已取消"，避免前端取消竞态报错
            return self.send_json({"ok": True, "cancelled": True})

        if path == "/api/chat":
            if not cfg.get("apiKey"):
                return self.send_json({"error": "未配置 API Key，请先在设置中填写"}, 400)
            body = self.read_body()
            if not body:
                return self.send_json({"error": "请求体为空"}, 400)
            url = cfg["baseUrl"].rstrip("/") + CHAT_API
            req = urllib.request.Request(url, data=body, method="POST",
                                         headers=build_chat_headers(cfg["apiKey"], body.decode("utf-8", "replace")))
            try:
                resp = urllib.request.urlopen(req, timeout=1800)
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", "replace")
                return self.send_json({"error": "百炼接口返回 HTTP %s: %s" % (e.code, _trunc(err_body, 500))}, e.code)
            except urllib.error.URLError as e:
                return self.send_json({"error": "无法连接百炼接口: %s" % _trunc(e.reason, 300)}, 502)

            # 判断是否流式：响应类型为 event-stream / octet-stream 时按 chunked 逐块转发
            ct = resp.headers.get("Content-Type", "") or ""
            is_stream = ("event-stream" in ct) or ("octet-stream" in ct)
            self.send_response(200)
            if is_stream:
                self.send_header("Content-Type", ct if ct else "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    while True:
                        chunk = resp.read(CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(b"%x\r\n" % len(chunk))
                        self.wfile.write(chunk)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass  # 客户端断开
                finally:
                    resp.close()
            else:
                data = resp.read()
                self.send_header("Content-Type", ct if ct else "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                resp.close()
            return

        self.send_json({"error": "not found"}, 404)

    # ---- 静态文件
    def static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = urllib.parse.unquote(path.lstrip("/"))
        full = os.path.normpath(os.path.join(ROOT, rel))
        # 必须位于项目目录内（含结尾分隔符判断，防止 "../视频理解-其他/x" 这类同级目录穿越）
        if (full != ROOT and not full.startswith(ROOT + os.sep)) or not os.path.isfile(full):
            self.send_json({"error": "文件不存在"}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


# ---------------------------------------------------------------- 后台转存任务
_UPLOADS = {}
_UPLOADS_LOCK = threading.Lock()


def _upload_state(key):
    with _UPLOADS_LOCK:
        return _UPLOADS.get(key)


def _set_upload(key, **kw):
    with _UPLOADS_LOCK:
        st = _UPLOADS.setdefault(key, {})
        st.update(kw)
        st["ts"] = time.time()
        # 简单清理：超过 200 个任务时清掉 1 小时前没有进展的
        if len(_UPLOADS) > 200:
            old = [k for k, v in _UPLOADS.items() if time.time() - v.get("ts", 0) > 3600]
            for k in old:
                _UPLOADS.pop(k, None)


def _oss_upload_worker(key, model, tmp_path, file_name, api_key, base_url, content_type="video/mp4"):
    """后台执行：获取凭证 + 上传到百炼临时 OSS，进度写入 _UPLOADS[key]（支持取消）"""
    try:
        _set_upload(key, phase="presign", progress=0, error=None)
        last_report = [0]

        def on_sent(done, total):
            st = _UPLOADS.get(key)
            if st and st.get("cancel"):
                raise UploadCancelled("上传已被取消")
            # 降频写进度：http.client 每 8KB 回调一次，若每次都加锁写进度，
            # 1GB 文件会产生 13 万次锁竞争；改为每 256KB 写一次（约 4000 次）
            if done - last_report[0] >= PROGRESS_WRITE_INTERVAL or done >= total:
                last_report[0] = done
                _set_upload(key, phase="uploading", progress=done / max(1, total))

        url = upload_file(api_key, base_url, model, tmp_path, file_name, content_type, on_sent=on_sent)
        _set_upload(key, phase="done", progress=1.0,
                    result={"url": url, "fileName": file_name,
                            "fileSize": os.path.getsize(tmp_path),
                            "expireInSeconds": 48 * 3600})
    except UploadCancelled:
        _set_upload(key, phase="canceled", progress=0, error=None)
    except Exception as e:  # noqa: BLE001
        _set_upload(key, phase="error", error=_trunc(e))
    finally:
        _remove_tmp(tmp_path)


def _remove_tmp(path):
    """尽力删除临时文件；文件句柄未释放时 Windows 可能拒绝，忽略即可（启动时会再清一次）"""
    try:
        os.remove(path)
    except OSError:
        pass

# 转存进度写入间隔（字节）：http.client 按 8KB 块回调 on_sent，降频写进度避免锁竞争
PROGRESS_WRITE_INTERVAL = 256 * 1024


def mime_for_file(name):
    ext = os.path.splitext(name or "")[1].lower()
    return {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
        ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
        ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".ts": "video/mp2t",
        ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".3gp": "video/3gpp",
    }.get(ext, "video/mp4")


def cleanup_stale_uploads():
    """清理上次异常退出遗留的 tmp_upload_*.bin（超过 1 小时未更新的残留文件）"""
    import glob
    try:
        for p in glob.glob(os.path.join(ROOT, "tmp_upload_*.bin")):
            try:
                if time.time() - os.path.getmtime(p) > 3600:
                    os.remove(p)
            except OSError:
                pass
    except Exception:  # noqa: BLE001
        pass


class MultipartParser:
    """流式 multipart/form-data 解析：非文件字段读入内存，文件字段写入 file_sink 指定的文件对象。

    用法:
        parser = MultipartParser(rfile, content_length, boundary)
        parser.file_sink = lambda filename: open(tmp_path, "wb")
        for part in parser.read():
            if part["filename"] is not None: ...  # 文件已保存，part["size"] 为字节数
            elif part["name"] == "model": ...    # 普通字段，part["data"] 为 bytes
    """

    def __init__(self, rfile, length, boundary):
        self.rfile = rfile
        self.remain = length
        self.b = b"--" + boundary.encode("utf-8")
        self.buf = b""
        self.file_sink = None  # callable(filename) -> writable file object
        self._active = None    # 当前正在写入的文件对象（中断时用于释放句柄）

    def cleanup(self):
        """关闭可能未完成写入的文件对象（流中断/异常时调用）"""
        if self._active is not None:
            try:
                self._active.close()
            except Exception:
                pass
            self._active = None

    def _fill(self):
        if self.remain <= 0:
            return False
        chunk = self.rfile.read(min(CHUNK, self.remain))
        if not chunk:
            self.remain = 0
            return False
        self.remain -= len(chunk)
        self.buf += chunk
        return True

    def _align(self):
        """确保 buf 以 boundary 开头；返回 False 表示流结束"""
        while True:
            idx = self.buf.find(self.b)
            if idx >= 0:
                if idx:
                    self.buf = self.buf[idx:]
                return True
            # boundary 可能横跨块边界，保留末尾 len(b)-1
            keep = max(0, len(self.buf) - (len(self.b) - 1))
            self.buf = self.buf[keep:]
            if not self._fill():
                return False

    def _read_line(self):
        while True:
            idx = self.buf.find(b"\r\n")
            if idx >= 0:
                line = self.buf[:idx]
                self.buf = self.buf[idx + 2:]
                return line
            if not self._fill():
                line = self.buf
                self.buf = b""
                return line

    def read(self):
        while self._align():
            if self.buf.startswith(self.b + b"--"):
                return
            self.buf = self.buf[len(self.b):]
            while not self.buf.startswith(b"\r\n"):
                if not self._fill():
                    return
            self.buf = self.buf[2:]
            headers = {}
            while True:
                line = self._read_line()
                if line == b"":
                    break
                h, _, v = line.partition(b":")
                headers[h.strip().decode("utf-8", "replace").lower()] = v.strip().decode("utf-8", "replace")
            cd = headers.get("content-disposition", "")
            nm = re.search(r'name="([^"]*)"', cd)
            fn = re.search(r'filename="([^"]*)"', cd)
            name = nm.group(1) if nm else ""
            filename = fn.group(1) if fn else None
            file_obj = None
            if filename is not None and self.file_sink:
                file_obj = self.file_sink(filename)
                self._active = file_obj
            parts = []
            size = 0
            while True:
                idx = self.buf.find(self.b)
                if idx >= 0:
                    data = self.buf[:max(0, idx - 2)]  # 去掉 boundary 前导 CRLF
                    if file_obj is not None:
                        file_obj.write(data)
                    else:
                        parts.append(data)
                    size += len(data)
                    self.buf = self.buf[idx:]
                    break
                keepn = max(0, len(self.buf) - (len(self.b) - 1))
                data = self.buf[:keepn]
                if file_obj is not None:
                    file_obj.write(data)
                else:
                    parts.append(data)
                size += len(data)
                self.buf = self.buf[keepn:]
                if not self._fill():
                    break
            if file_obj is not None:
                file_obj.close()
                self._active = None
                yield {"name": name, "filename": filename, "size": size}
            else:
                yield {"name": name, "filename": None, "data": b"".join(parts)}


def find_port():
    for p in PREFERRED_PORTS:
        import socket
        s = socket.socket()
        try:
            s.bind((HOST, p))
            s.close()
            return p
        except OSError:
            s.close()
    import socket
    s = socket.socket()
    s.bind((HOST, 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    cleanup_stale_uploads()
    port = int(os.environ.get("VDU_PORT", find_port()))
    server = ThreadingHTTPServer((HOST, port), Handler)
    url = "http://%s:%d/" % (HOST, port)
    print("=" * 56)
    print("  视频理解工作台 · 本地服务已启动")
    print("  访问地址: %s" % url)
    print("  按 Ctrl+C 停止服务")
    print("=" * 56)

    def opener():
        time.sleep(0.8)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=opener, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务")


if __name__ == "__main__":
    sys.path.insert(0, os.path.join(ROOT, "libs"))  # 兼容未来 pip --target 布局
    main()
