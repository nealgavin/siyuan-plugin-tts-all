/**
 * 思源笔记 文本朗读（TTS）插件 —— 全平台版
 *
 * 支持的运行环境：
 * - 桌面端 Windows / macOS / Linux（Electron，有 Node.js）
 * - Pad / 手机 Android / iOS（WebView，无 Node）
 * - 鸿蒙 HarmonyOS 思源笔记（ArkWeb，无 Node），如华为 Pura / Mate 系列
 * - 浏览器 / Docker 自部署
 *
 * 语音引擎分层降级（上一级不可用时自动切到下一级）：
 *  1. Edge 直连   —— 桌面端用 Node net/tls 手写 WebSocket，可自定义 Origin/UA（音质最好，声源多）
 *  2. Edge 代理   —— 移动端经思源内核 /ws/network/proxy 转发 WebSocket（内核由 Go 发起连接，
 *                    可代发桌面 Edge 的 User-Agent，绕开浏览器禁止修改 User-Agent 的限制），需内核 ≥ 3.7.0
 *  3. HTTP 备用   —— 经思源内核 /api/network/forwardProxy 拉取在线 TTS 音频（内核 ≥ 3.1.28 即有）
 *  4. 系统语音    —— 设备自带 TTS（Web Speech API），可离线使用，作为最终兜底
 */

const { Plugin, Menu, showMessage, Dialog } = require("siyuan");

/*****************************************************************************
 * 一、平台环境检测
 *****************************************************************************/
const HAS_NODE = typeof window.require === "function";

let nodeCrypto = null;
let nodeNet = null;
let nodeTls = null;
let nodeEvents = null;
let nodeUrlLib = null;
if (HAS_NODE) {
  try {
    nodeCrypto = window.require("crypto");
    nodeNet = window.require("net");
    nodeTls = window.require("tls");
    nodeEvents = window.require("events");
    nodeUrlLib = window.require("url");
  } catch (e) {
    console.warn("[TTS] Node.js 模块不可用，将使用浏览器兼容模式", e);
  }
}
// 仅桌面端 Electron 具备完整的 Node 网络栈
const USE_NODE_NET = !!(nodeCrypto && nodeNet && nodeTls && nodeEvents && nodeUrlLib);

// 与思源源码 getBackend() 一致："windows"|"linux"|"darwin"|"docker"|"android"|"ios"|"harmony"
function getBackendName() {
  try {
    const sys = window.siyuan.config.system;
    if (["docker", "ios", "android", "harmony"].includes(sys.container)) {
      return sys.container;
    }
    return sys.os;
  } catch (e) {
    return "unknown";
  }
}

function isHarmonyOS() {
  return getBackendName() === "harmony";
}

// 移动端前端（手机 / Pad / 鸿蒙）：无底部状态栏，需要悬浮控制条
function isMobileUI() {
  try {
    return !!document.getElementById("sidebar") ||
      ["android", "ios", "harmony"].includes(getBackendName());
  } catch (e) {
    return false;
  }
}

function getKernelVersion() {
  try {
    return window.siyuan.config.system.kernelVersion || "";
  } catch (e) {
    return "";
  }
}

// 内核是否支持 /ws/network/proxy（v3.7.0 起提供）
function kernelSupportsWsProxy() {
  const v = getKernelVersion();
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) {
    return true; // 无法判断时按支持处理，失败后会自动降级
  }
  const num = parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10);
  return num >= 30700;
}

function getApiToken() {
  try {
    return window.siyuan.config.api.token || "";
  } catch (e) {
    return "";
  }
}

function getKernelHttpBase() {
  const proto = location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${location.host}`;
}

function getKernelWsBase() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

const logger = {
  level: "warn", // 'info' | 'warn' | 'error'
  info: (...args) => ["info"].includes(logger.level) && console.log(...args),
  warn: (...args) => ["info", "warn"].includes(logger.level) && console.warn(...args),
  error: (...args) => ["info", "warn", "error"].includes(logger.level) && console.error(...args),
};

/*****************************************************************************
 * 二、通用加密 / 字节工具（全平台，不依赖 Node.js）
 *****************************************************************************/
function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function base64UrlEncode(str) {
  return bytesToBase64(new TextEncoder().encode(str))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBytes(n) {
  if (nodeCrypto) {
    try {
      return new Uint8Array(nodeCrypto.randomBytes(n));
    } catch (e) { /* fallthrough */ }
  }
  const arr = new Uint8Array(n);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return arr;
}

function randomHex(n) {
  return bytesToHex(randomBytes(n));
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) {
    return buf;
  }
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view);
  return ab;
}

function concatBytes(list) {
  let total = 0;
  for (const item of list) {
    total += item.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of list) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

// 在字节数组中查找 ASCII 子串下标，未找到返回 -1
function indexOfBytes(haystack, needleStr, from = 0) {
  const n = needleStr.length;
  if (n === 0 || haystack.length < n) {
    return -1;
  }
  const first = needleStr.charCodeAt(0);
  const limit = haystack.length - n;
  for (let i = from; i <= limit; i++) {
    if (haystack[i] !== first) {
      continue;
    }
    let j = 1;
    for (; j < n; j++) {
      if (haystack[i + j] !== needleStr.charCodeAt(j)) {
        break;
      }
    }
    if (j === n) {
      return i;
    }
  }
  return -1;
}

// 纯 JS SHA-256：crypto.subtle 不可用时（如局域网非安全上下文）的降级实现
function sha256Js(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  let total = bytes.length + 9;
  while (total % 64 !== 0) {
    total++;
  }
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(total - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(chunk + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const y = w[i - 2];
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

async function sha256HexUpper(text) {
  if (nodeCrypto) {
    try {
      return nodeCrypto.createHash("sha256").update(text, "ascii").digest("hex").toUpperCase();
    } catch (e) { /* fallthrough */ }
  }
  const bytes = new TextEncoder().encode(text);
  if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
    try {
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return bytesToHex(new Uint8Array(digest)).toUpperCase();
    } catch (e) { /* fallthrough */ }
  }
  return sha256Js(bytes).toUpperCase();
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 按句子切分长文本（用于有长度限制或存在长文本中断问题的引擎）
function splitText(text, maxLen = 180) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return [];
  }
  const parts = clean.split(/(?<=[。！？!?；;：:\n])/);
  const out = [];
  let buf = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (part.length > maxLen) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < part.length; i += maxLen) {
        out.push(part.slice(i, i + maxLen));
      }
      continue;
    }
    if ((buf + part).length > maxLen) {
      out.push(buf);
      buf = part;
    } else {
      buf += part;
    }
  }
  if (buf) {
    out.push(buf);
  }
  return out;
}

// 简单的语言判定：含中日韩字符视为中文
function detectLang(text) {
  return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text) ? "zh-CN" : "en";
}

/*****************************************************************************
 * 三、WebSocket 传输层
 *   - NodeWebSocket       桌面端：net/tls 手写，可自定义 Origin / User-Agent
 *   - BrowserWebSocket    浏览器原生 WebSocket
 *   - KernelProxyWebSocket 经思源内核 /ws/network/proxy 转发（内核代发请求头）
 *****************************************************************************/

const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const EDGE_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split(".")[0]}.0.0.0`;

function edgeHeaders() {
  return {
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "User-Agent": EDGE_USER_AGENT,
    Origin: EDGE_ORIGIN,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

class NodeWebSocket extends (nodeEvents ? nodeEvents.EventEmitter : Object) {
  constructor(url, options = {}) {
    super();
    this.url = new nodeUrlLib.URL(url);
    this.options = options;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.isHandshakeComplete = false;
    this.readyState = 0;
    this.fragments = [];
    this.fragmentOpcode = 0;
  }

  connect() {
    const isSecure = this.url.protocol === "wss:";
    const port = this.url.port || (isSecure ? 443 : 80);
    const connectModule = isSecure ? nodeTls : nodeNet;

    this.socket = connectModule.connect({
      host: this.options.host || this.url.hostname,
      port: port,
      rejectUnauthorized: this.options.rejectUnauthorized !== false,
    }, () => this._sendHandshake());

    this.socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (!this.isHandshakeComplete) {
        this._handleHandshake();
      } else {
        this._processFrames();
      }
    });

    this.socket.on("close", () => {
      this.readyState = 3;
      if (this.onclose) this.onclose();
      this.emit("close");
    });

    this.socket.on("error", (err) => {
      if (err.code === "ECONNRESET" || err.code === "EPIPE") {
        this.readyState = 3;
        if (this.onclose) this.onclose();
        this.emit("close");
        return;
      }
      this.readyState = 3;
      if (this.onerror) this.onerror(err);
      this.emit("error", err);
    });
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    if (typeof data === "string") {
      this._writeFrame(0x1, Buffer.from(data, "utf8"));
    } else if (Buffer.isBuffer(data)) {
      this._writeFrame(0x2, data);
    } else {
      throw new Error("Data must be string or Buffer");
    }
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 2;
    this.fragments = [];
    this.fragmentOpcode = 0;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    try {
      this._writeFrame(0x8, payload);
    } catch (e) { /* ignore */ }
    setTimeout(() => {
      if (this.socket && !this.socket.destroyed) {
        try {
          this.socket.destroy();
        } catch (e) { /* ignore */ }
      }
    }, 1500);
  }

  _sendHandshake() {
    const key = Buffer.from(randomBytes(16)).toString("base64");
    const headers = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${this.url.hostname}:${this.url.port || (this.url.protocol === "wss:" ? 443 : 80)}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ];
    if (this.options.headers) {
      for (const [k, v] of Object.entries(this.options.headers)) {
        headers.push(`${k}: ${v}`);
      }
    }
    this.socket.write(headers.join("\r\n") + "\r\n\r\n");
  }

  _handleHandshake() {
    const idx = this.buffer.indexOf("\r\n\r\n");
    if (idx === -1) {
      return;
    }
    const statusLine = this.buffer.slice(0, idx).toString().split("\r\n")[0];
    this.buffer = this.buffer.slice(idx + 4);

    if (!statusLine.includes("101")) {
      const err = new Error(`Unexpected server response: ${statusLine}`);
      this.readyState = 3;
      if (this.onerror) this.onerror(err);
      this.socket.end();
      return;
    }
    this.isHandshakeComplete = true;
    this.readyState = 1;
    if (this.onopen) this.onopen();
    this.emit("open");
    if (this.buffer.length > 0) {
      this._processFrames();
    }
  }

  _writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      return;
    }
    const length = payload.length;
    let frameSize = 2;
    let lengthByte;
    if (length < 126) {
      lengthByte = length;
    } else if (length < 65536) {
      frameSize += 2;
      lengthByte = 126;
    } else {
      frameSize += 8;
      lengthByte = 127;
    }
    frameSize += 4;

    const frame = Buffer.alloc(frameSize + length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | lengthByte;

    let offset = 2;
    if (lengthByte === 126) {
      frame.writeUInt16BE(length, 2);
      offset += 2;
    } else if (lengthByte === 127) {
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(length, 6);
      offset += 8;
    }
    const maskKey = Buffer.from(randomBytes(4));
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i % 4];
    }
    this.socket.write(frame);
  }

  _processFrames() {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const fin = (firstByte & 0x80) === 0x80;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) === 0x80;
      let payloadLen = secondByte & 0x7f;
      let headerSize = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerSize += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = this.buffer.readUInt32BE(6);
        headerSize += 8;
      }
      if (masked) headerSize += 4;
      if (this.buffer.length < headerSize + payloadLen) return;

      let payload = this.buffer.slice(headerSize, headerSize + payloadLen);
      if (masked) {
        const maskKey = this.buffer.slice(headerSize - 4, headerSize);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }
      this.buffer = this.buffer.slice(headerSize + payloadLen);

      if (opcode === 0x0) {
        if (this.fragmentOpcode === 0) continue;
        this.fragments.push(payload);
        if (fin) {
          this._emitMessage(this.fragmentOpcode, Buffer.concat(this.fragments));
          this.fragments = [];
          this.fragmentOpcode = 0;
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments.push(payload);
        } else {
          this._emitMessage(opcode, payload);
        }
      } else if (opcode === 0x8) {
        this.close();
      }
    }
  }

  _emitMessage(opcode, payload) {
    if (!this.onmessage) {
      return;
    }
    if (opcode === 0x1) {
      this.onmessage({ data: payload.toString("utf8") });
    } else {
      this.onmessage({ data: toArrayBuffer(new Uint8Array(payload)) });
    }
  }
}

// 浏览器原生 WebSocket：延迟到 connect() 创建，保证事件回调先绑定
class BrowserWebSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.readyState = 0;
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.readyState = 3;
      if (this.onerror) this.onerror(e);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    };
    ws.onmessage = (ev) => {
      if (this.onmessage) this.onmessage({ data: ev.data });
    };
    ws.onclose = () => {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    };
    ws.onerror = (err) => {
      this.readyState = 3;
      if (this.onerror) this.onerror(err);
    };
  }

  send(data) {
    if (this.readyState !== 1 || !this.ws) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(data);
  }

  close() {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 2;
    try {
      this.ws && this.ws.close();
    } catch (e) { /* ignore */ }
    this.readyState = 3;
  }
}

/**
 * 经思源内核转发：GET /ws/network/proxy?u=<目标URL>&h=<请求头JSON>&token=<token>
 * 内核用 Go 发起 WebSocket 握手，因此可以代发浏览器禁止修改的 User-Agent（Edge TTS 必需 Edg/ 标记）
 */
class KernelProxyWebSocket extends BrowserWebSocket {
  constructor(targetUrl, targetHeaders) {
    const params = new URLSearchParams();
    params.set("u", base64UrlEncode(targetUrl));
    if (targetHeaders && Object.keys(targetHeaders).length) {
      const h = {};
      for (const [k, v] of Object.entries(targetHeaders)) {
        h[k] = [String(v)];
      }
      params.set("h", base64UrlEncode(JSON.stringify(h)));
    }
    const token = getApiToken();
    if (token) {
      params.set("token", token);
    }
    super(`${getKernelWsBase()}/ws/network/proxy?${params.toString()}`);
    this.kernelProxy = true;
  }
}

/*****************************************************************************
 * 四、Edge TTS 协议实现（传输层可替换）
 *****************************************************************************/
const CONNECT_TIMEOUT = 15000;
const REQUEST_IDLE_TIMEOUT = 30000;

const OUTPUT_FORMAT = {
  RAW_16KHZ_16BIT_MONO_PCM: "raw-16khz-16bit-mono-pcm",
  RAW_24KHZ_16BIT_MONO_PCM: "raw-24khz-16bit-mono-pcm",
  RAW_48KHZ_16BIT_MONO_PCM: "raw-48khz-16bit-mono-pcm",
  RIFF_16KHZ_16BIT_MONO_PCM: "riff-16khz-16bit-mono-pcm",
  RIFF_24KHZ_16BIT_MONO_PCM: "riff-24khz-16bit-mono-pcm",
  RIFF_48KHZ_16BIT_MONO_PCM: "riff-48khz-16bit-mono-pcm",
  AUDIO_16KHZ_32KBITRATE_MONO_MP3: "audio-16khz-32kbitrate-mono-mp3",
  AUDIO_16KHZ_64KBITRATE_MONO_MP3: "audio-16khz-64kbitrate-mono-mp3",
  AUDIO_16KHZ_128KBITRATE_MONO_MP3: "audio-16khz-128kbitrate-mono-mp3",
  AUDIO_24KHZ_48KBITRATE_MONO_MP3: "audio-24khz-48kbitrate-mono-mp3",
  AUDIO_24KHZ_96KBITRATE_MONO_MP3: "audio-24khz-96kbitrate-mono-mp3",
  AUDIO_24KHZ_160KBITRATE_MONO_MP3: "audio-24khz-160kbitrate-mono-mp3",
  AUDIO_48KHZ_96KBITRATE_MONO_MP3: "audio-48khz-96kbitrate-mono-mp3",
  AUDIO_48KHZ_192KBITRATE_MONO_MP3: "audio-48khz-192kbitrate-mono-mp3",
  WEBM_16KHZ_16BIT_MONO_OPUS: "webm-16khz-16bit-mono-opus",
  WEBM_24KHZ_16BIT_MONO_OPUS: "webm-24khz-16bit-mono-opus",
  OGG_24KHZ_16BIT_MONO_OPUS: "ogg-24khz-16bit-mono-opus",
};

// MP3 在桌面 / Android / iOS / 鸿蒙 WebView 中均可被 decodeAudioData 解码（WebM/Opus 在 iOS 上不支持）
const DEFAULT_OUTPUT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

async function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  return sha256HexUpper(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`);
}

async function combineUrl(url) {
  const secMsGec = await generateSecMsGecToken();
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

/**
 * Edge TTS 客户端。transport 决定连接方式：
 *   "node"   桌面端 Node net/tls（可自定义请求头）
 *   "kernel" 经思源内核 WebSocket 代理
 */
class MsEdgeTTS {
  static SYNTH_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
  static AUDIO_DELIM = "Path:audio\r\n";
  static VOICE_LANG_REGEX = /\w{2}-\w{2}/;

  constructor(transport = "node") {
    this.transport = transport;
    this._ws = null;
    this._wsInitPromise = null;
    this._voice = null;
    this._voiceLocale = null;
    this._outputFormat = DEFAULT_OUTPUT_FORMAT;
    this._requests = new Map();
  }

  async setMetadata(voiceName, outputFormat, voiceLocale) {
    const changed = this._voice !== voiceName ||
      this._outputFormat !== outputFormat ||
      this._voiceLocale !== voiceLocale;
    this._voice = voiceName;
    this._outputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT;
    this._voiceLocale = voiceLocale;
    if (!this._voiceLocale) {
      const match = MsEdgeTTS.VOICE_LANG_REGEX.exec(this._voice || "");
      if (!match) {
        throw new Error("Could not infer voiceLocale from voiceName!");
      }
      this._voiceLocale = match[0];
    }
    if (changed && this._ws) {
      this.close();
    }
    await this._initClient();
  }

  close() {
    this._rejectAll(new Error("TTS client closed"));
    const ws = this._ws;
    this._ws = null;
    this._wsInitPromise = null;
    if (ws) {
      try {
        ws.close();
      } catch (e) { /* ignore */ }
    }
  }

  _rejectAll(err) {
    for (const [, req] of this._requests) {
      clearTimeout(req.timer);
      try {
        req.reject(err);
      } catch (e) { /* ignore */ }
    }
    this._requests.clear();
  }

  _configMessage() {
    return "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "false",
                wordBoundaryEnabled: "false",
              },
              outputFormat: this._outputFormat,
            },
          },
        },
      });
  }

  _createSocket(url) {
    if (this.transport === "kernel") {
      return new KernelProxyWebSocket(url, edgeHeaders());
    }
    return new NodeWebSocket(url, {
      host: "speech.platform.bing.com",
      headers: edgeHeaders(),
      rejectUnauthorized: false,
    });
  }

  async _initClient() {
    if (this._ws && this._ws.readyState === 1) {
      return this._ws;
    }
    if (this._wsInitPromise) {
      return this._wsInitPromise;
    }

    this._wsInitPromise = (async () => {
      const url = await combineUrl(MsEdgeTTS.SYNTH_URL);
      const ws = this._createSocket(url);
      this._ws = ws;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("语音服务连接超时"));
        }, CONNECT_TIMEOUT);

        ws.onopen = () => {
          clearTimeout(timer);
          try {
            ws.send(this._configMessage());
          } catch (e) { /* 配置消息失败不阻断，后续请求会再次报错 */ }
          resolve(ws);
        };
        ws.onmessage = (m) => this._onMessage(m);
        ws.onclose = () => this._onClose();
        ws.onerror = (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error("语音服务连接失败"));
        };
        ws.connect();
      });
      return ws;
    })();

    try {
      return await this._wsInitPromise;
    } catch (e) {
      this._wsInitPromise = null;
      this._ws = null;
      throw e;
    }
  }

  _onClose() {
    this._ws = null;
    this._wsInitPromise = null;
    this._rejectAll(new Error("语音服务连接已断开"));
  }

  _onMessage(m) {
    const data = m.data;

    if (typeof data === "string") {
      const res = /X-RequestId:(.*?)\r\n/.exec(data);
      if (!res) {
        return;
      }
      if (data.includes("Path:turn.end")) {
        const requestId = res[1].trim();
        const req = this._requests.get(requestId);
        if (req) {
          this._requests.delete(requestId);
          clearTimeout(req.timer);
          req.resolve(toArrayBuffer(concatBytes(req.chunks)));
        }
      }
      return;
    }

    // 二进制帧：2 字节头长度 + ASCII 头 + 音频数据
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
    const audioIdx = indexOfBytes(bytes, MsEdgeTTS.AUDIO_DELIM);
    if (audioIdx === -1) {
      return;
    }
    const headerText = String.fromCharCode.apply(null, bytes.subarray(0, audioIdx));
    const res = /X-RequestId:(.*?)\r\n/.exec(headerText);
    if (!res) {
      return;
    }
    const requestId = res[1].trim();
    const req = this._requests.get(requestId);
    if (!req) {
      return;
    }
    const start = audioIdx + MsEdgeTTS.AUDIO_DELIM.length;
    if (start < bytes.length) {
      req.chunks.push(bytes.slice(start));
    }
    clearTimeout(req.timer);
    req.timer = setTimeout(() => {
      this._requests.delete(requestId);
      req.reject(new Error("语音合成超时"));
    }, REQUEST_IDLE_TIMEOUT);
  }

  async synthesize(text) {
    if (!this._voice) {
      throw new Error("Speech synthesis not configured yet.");
    }
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${this._voiceLocale}">
                <voice name="${this._voice}">
                    ${escapeXml(text)}
                </voice>
            </speak>`;
    return this._request(ssml);
  }

  _request(requestSSML) {
    const requestId = randomHex(16);
    const result = new Promise((resolve, reject) => {
      const req = { chunks: [], resolve, reject, timer: null };
      req.timer = setTimeout(() => {
        this._requests.delete(requestId);
        reject(new Error("语音合成超时"));
      }, REQUEST_IDLE_TIMEOUT);
      this._requests.set(requestId, req);
    });

    const message = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${requestSSML.trim()}`;
    this._send(message).catch((err) => {
      const req = this._requests.get(requestId);
      if (req) {
        this._requests.delete(requestId);
        clearTimeout(req.timer);
        req.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return result;
  }

  async _send(message) {
    let ws = this._ws;
    if (!ws || ws.readyState >= 2) {
      ws = await this._initClient();
    }
    ws.send(message);
  }
}

/*****************************************************************************
 * 五、HTTP 备用引擎：经思源内核 /api/network/forwardProxy 拉取在线 TTS 音频
 *     （内核由 Go 发起请求，不受浏览器 CORS / 禁止修改请求头限制）
 *
 *     多服务商按顺序尝试。注意：Google translate_tts 在中国大陆网络下不可达，
 *     因此把国内可直接访问的服务商放在前面，Google 仅作为海外环境兜底。
 *****************************************************************************/
const HTTP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// 百度 TTS 单次请求文本过长会被限流（err_no 529），实测 60 字稳定
const HTTP_CHUNK_SIZE = 60;

// 各服务商返回体是否为音频：按魔数判断，避免把 JSON 错误页当音频解码
function isAudioBytes(bytes) {
  if (!bytes || bytes.length < 4) {
    return false;
  }
  // ID3
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  // MP3 frame sync
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return true;
  }
  // RIFF/WAVE
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return true;
  }
  // OggS
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return true;
  }
  return false;
}

// 提取错误响应中的可读信息，便于用户/日志定位
function describeBadResponse(bytes) {
  try {
    const text = new TextDecoder("utf-8").decode(bytes.slice(0, 300));
    const m = /"err_msg"\s*:\s*"([^"]+)"/.exec(text) || /"msg"\s*:\s*"([^"]+)"/.exec(text);
    if (m) {
      return m[1];
    }
    return text.replace(/\s+/g, " ").slice(0, 120);
  } catch (e) {
    return "无法解析的响应";
  }
}

const HTTP_PROVIDERS = [
  {
    // 百度在线语音合成：国内可直接访问，无需密钥
    // 注意：不要传 rate 参数。百度只接受 rate ∈ {0,1,2,3,4,8,16,24,32}，
    // 传其它值（含文档里常见的默认值 5）都会返回 "aue and rate not match"。
    // 语速统一交给播放层 playbackRate 控制。
    name: "baidu",
    build(text, lang) {
      const q = encodeURIComponent(text);
      const per = lang === "zh-CN" ? 0 : 1;
      return `https://tts.baidu.com/text2audio?tex=${q}&cuid=baike&lan=ZH&ctp=1&pdt=301&vol=9&per=${per}`;
    },
    headers: {
      "User-Agent": HTTP_UA,
      Referer: "https://baike.baidu.com/",
    },
  },
  {
    // 有道词典发音：国内可访问（实测偶发 500，失败会自动换下一个服务商）
    name: "youdao",
    build(text, lang) {
      const le = lang === "zh-CN" ? "zh" : "en";
      return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&le=${le}&type=2`;
    },
    headers: { "User-Agent": HTTP_UA },
  },
  {
    // Google 翻译语音：海外环境可用，中国大陆不可达，故放最后
    name: "google",
    build(text, lang) {
      return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob` +
        `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
    },
    headers: { "User-Agent": HTTP_UA },
  },
];

class HttpTts {
  constructor() {
    this.kind = "buffer";
    this.activeProvider = null;
    this._deadProviders = new Set();
  }

  // 令牌延迟读取：插件构造时配置可能尚未就绪
  get token() {
    return getApiToken();
  }

  async _forward(targetUrl, headers = {}) {
    const body = {
      url: targetUrl,
      method: "GET",
      timeout: 20000,
      // 注意：内核 3.1.28 会直接断言 headers 为数组，因此必须始终传数组
      headers: Object.entries(headers).map(([k, v]) => ({ [k]: v })),
      responseEncoding: "base64-std",
    };
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    const token = this.token;
    if (token) {
      init.headers.Authorization = "Token " + token;
    }
    // 没有令牌时不发送 Authorization 头：同源请求会带上会话 Cookie，
    // 内核会用会话完成鉴权，也不会被记为「认证失败」。
    // 反之，发送一个错误的令牌会累计失败次数并按 IP 锁定整个内核。
    const res = await fetch(`${getKernelHttpBase()}/api/network/forwardProxy`, init);
    if (res.status === 429) {
      // 内核认证失败次数过多（按 IP 锁定，指数退避，最长 15 分钟）。
      // 此时即使令牌正确也会被拒，且每次重试都会延长锁定时间，必须立即停止。
      const retryAfter = res.headers && res.headers.get ? res.headers.get("Retry-After") : null;
      throw new Error(`内核认证被锁定，请稍后重试` +
        (retryAfter ? `（约 ${retryAfter} 秒）` : "") +
        `。若持续出现请检查「设置 → 关于 → API 令牌」是否与当前工作空间一致`);
    }
    if (res.status === 401) {
      throw new Error(token
        ? "API 令牌无效，请在「设置 → 关于 → API 令牌」中重新获取"
        : "内核拒绝访问，请确认已在本机登录思源");
    }
    if (!res.ok) {
      throw new Error(`内核代理请求失败：HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json || json.code !== 0) {
      throw new Error((json && json.msg) || "内核代理请求失败");
    }
    return json.data;
  }

  // 是否需要立即放弃重试（认证类错误重试只会加重锁定）
  static isAuthError(e) {
    const m = e && e.message ? e.message : "";
    return /内核认证被锁定|API 令牌无效|内核拒绝访问/.test(m);
  }

  // 依次尝试各服务商，返回第一个可用服务商及其已取回的首段音频
  async _pickProvider(chunks, lang, rate) {
    if (this.activeProvider) {
      return { provider: this.activeProvider, firstBytes: null };
    }
    let lastError = null;
    for (const provider of HTTP_PROVIDERS) {
      try {
        const bytes = await this._fetchChunk(provider, chunks[0], lang, rate);
        if (!isAudioBytes(bytes)) {
          throw new Error(describeBadResponse(bytes));
        }
        this.activeProvider = provider;
        return { provider, firstBytes: bytes };
      } catch (e) {
        // 认证/锁定问题与具体服务商无关，换服务商也是同样结果，
        // 且每次请求都会延长内核锁定时间，因此立即中断。
        if (HttpTts.isAuthError(e)) {
          throw e;
        }
        lastError = e;
        logger.warn(`[TTS]\t在线语音服务商 ${provider.name} 不可用：`, e && e.message ? e.message : e);
      }
    }
    throw lastError || new Error("没有可用的在线语音服务");
  }

  async _fetchChunk(provider, chunk, lang, rate) {
    let url = provider.build(chunk, lang);
    if (provider.rateParam) {
      url = url.replace("__RATE__", String(provider.rateParam(rate)));
    }
    const data = await this._forward(url, provider.headers);
    return base64ToBytes((data && data.body) || "");
  }

  // 单段取回，失败自动重试（国内服务商有频率限制）
  async _fetchChunkWithRetry(provider, chunk, lang, rate, label) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const got = await this._fetchChunk(provider, chunk, lang, rate);
        if (isAudioBytes(got)) {
          return got;
        }
        lastError = new Error(describeBadResponse(got));
      } catch (e) {
        // 认证类错误不能重试：内核按 IP 锁定，重试会延长锁定时间
        if (HttpTts.isAuthError(e)) {
          throw e;
        }
        lastError = e;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
    throw new Error(`在线语音合成失败（${label}）：` +
      (lastError && lastError.message ? lastError.message : "未知错误"));
  }

  async synthesize(text) {
    const lang = detectLang(text);
    const chunks = splitText(text, HTTP_CHUNK_SIZE);
    if (chunks.length === 0) {
      return { kind: "buffer", data: new ArrayBuffer(0) };
    }

    // 注意：语速由播放层 playbackRate 统一控制，这里不叠加变速，
    // 否则会与服务商自身的变速参数相乘，导致实际语速偏离用户设置。
    const picked = await this._pickProvider(chunks, lang, 1);
    let provider = picked.provider;
    const buffers = [];
    buffers.push(picked.firstBytes ||
      await this._fetchChunkWithRetry(provider, chunks[0], lang, 1, `1/${chunks.length}`));

    for (let i = 1; i < chunks.length; i++) {
      try {
        buffers.push(await this._fetchChunkWithRetry(provider, chunks[i], lang, 1,
          `${i + 1}/${chunks.length}`));
      } catch (e) {
        // 国内服务商中途限流时，换用备用服务商继续，避免整段朗读失败
        const fallback = HTTP_PROVIDERS.find((p) => p !== provider &&
          !this._deadProviders.has(p.name));
        if (!fallback) {
          throw e;
        }
        logger.warn(`[TTS]\t${provider.name} 中途失败，切换 ${fallback.name}:`, e.message);
        this._deadProviders.add(provider.name);
        provider = fallback;
        buffers.push(await this._fetchChunkWithRetry(provider, chunks[i], lang, 1,
          `${i + 1}/${chunks.length}`));
      }
    }
    return { kind: "buffer", data: toArrayBuffer(concatBytes(buffers)) };
  }

  close() { /* 无长连接 */ }
}

/*****************************************************************************
 * 六、系统语音引擎（Web Speech API，可离线，作为最终兜底）
 *****************************************************************************/
class SystemTts {
  constructor() {
    this.kind = "system";
    // 是否为「我们自己调用 stop()」打断的：被自己打断时属于预期中断，
    // 不能向上报错，否则切换声源/换块时会误报「系统语音播放失败」。
    this._cancelled = false;
  }

  get available() {
    if (typeof window.speechSynthesis === "undefined" ||
      typeof window.SpeechSynthesisUtterance === "undefined") {
      return false;
    }
    // 部分 WebView（含鸿蒙 ArkWeb）实现了该 API 但没有任何可用音色，
    // 此时 speak() 既不报错也不触发 onend，会导致朗读永久静默卡住。
    // 仅在能确认「有音色」时才算可用；确认不了则交给 speak() 的超时兜底。
    try {
      const voices = window.speechSynthesis.getVoices();
      if (Array.isArray(voices) && voices.length === 0) {
        // getVoices() 在部分环境首次调用返回空、稍后才就绪，故仅当明确不支持时才判否
        return true;
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  _pickVoice(lang) {
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      if (voices.length === 0) {
        return null;
      }
      const exact = voices.find((v) => v.lang && v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase());
      if (exact) {
        return exact;
      }
      const prefix = lang.split("-")[0].toLowerCase();
      return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) || null;
    } catch (e) {
      return null;
    }
  }

  async synthesize(text) {
    if (!this.available) {
      throw new Error("当前环境不支持系统语音（Web Speech API）");
    }
    const lang = detectLang(text);
    // 系统语音在部分平台存在长文本被截断的问题，按句切分更稳妥
    const chunks = splitText(text, 180);
    if (chunks.length === 0) {
      return { kind: "system", chunks: [] };
    }
    return { kind: "system", chunks, lang, voice: this._pickVoice(lang) };
  }

  speak(chunk, lang, voice, rate) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      this._cancelled = false;
      const finish = (fn, arg) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startTimer);
        clearTimeout(stallTimer);
        fn(arg);
      };

      // 若从未触发 onstart，说明该 WebView 根本没有可用语音引擎，
      // 超时后报错以便降级，而不是无声地永久等待。
      const startTimer = setTimeout(() => {
        if (!started) {
          finish(reject, new Error("系统语音无响应（该设备可能未安装语音引擎）"));
        }
      }, 3000);

      const clearStall = () => {
        clearTimeout(stallTimer);
        // 单块最长等待时间随文本长度放宽，防止引擎中途卡死导致整篇朗读挂住
        stallTimer = setTimeout(() => {
          finish(reject, new Error("系统语音播放超时"));
        }, Math.max(15000, chunk.length * 400));
      };
      let stallTimer = setTimeout(() => {
        finish(reject, new Error("系统语音播放超时"));
      }, Math.max(15000, chunk.length * 400));

      const utterance = new window.SpeechSynthesisUtterance(chunk);
      utterance.lang = lang;
      utterance.rate = Math.min(Math.max(rate || 1, 0.1), 10);
      if (voice) {
        utterance.voice = voice;
      }
      utterance.onstart = () => {
        started = true;
        clearTimeout(startTimer);
        clearStall();
      };
      utterance.onend = () => finish(resolve);
      utterance.onerror = (e) => {
        // interrupted / canceled 属于主动停止（含我们自己切声源、换块），
        // 不作为错误上报，否则会误报「系统语音播放失败」。
        const reason = (e && e.error) || "";
        if (reason === "interrupted" || reason === "canceled") {
          finish(resolve);
        } else if (this._cancelled) {
          finish(resolve);
        } else {
          finish(reject, new Error("系统语音播放失败：" + reason));
        }
      };
      try {
        window.speechSynthesis.speak(utterance);
      } catch (e) {
        finish(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  stop() {
    this._cancelled = true;
    try {
      window.speechSynthesis.cancel();
    } catch (e) { /* ignore */ }
  }

  pause() {
    try {
      window.speechSynthesis.pause();
    } catch (e) { /* ignore */ }
  }

  resume() {
    try {
      window.speechSynthesis.resume();
    } catch (e) { /* ignore */ }
  }

  close() {
    this.stop();
  }
}

/*****************************************************************************
 * 七、引擎调度：按优先级自动降级
 *****************************************************************************/
const ENGINE = {
  AUTO: "auto",
  EDGE_DIRECT: "edge-direct",
  EDGE_PROXY: "edge-proxy",
  HTTP: "http",
  SYSTEM: "system",
};

const ENGINE_LABELS = {
  [ENGINE.AUTO]: "engineAuto",
  [ENGINE.EDGE_DIRECT]: "engineEdgeDirect",
  [ENGINE.EDGE_PROXY]: "engineEdgeProxy",
  [ENGINE.HTTP]: "engineHttp",
  [ENGINE.SYSTEM]: "engineSystem",
};

// Edge 声源清单：菜单与悬浮窗共用
const VOICE_LIST = [
  { label: "晓晓 · 中文女声", value: "zh-CN-XiaoxiaoNeural", short: "晓晓" },
  { label: "晓伊 · 中文女声", value: "zh-CN-XiaoyiNeural", short: "晓伊" },
  { label: "云希 · 中文男声", value: "zh-CN-YunxiNeural", short: "云希" },
  { label: "云扬 · 中文男声", value: "zh-CN-YunyangNeural", short: "云扬" },
  { label: "云健 · 中文男声", value: "zh-CN-YunjianNeural", short: "云健" },
  { label: "辽宁小北 · 东北女声", value: "zh-CN-liaoning-XiaobeiNeural", short: "小北" },
  { label: "陕西小妮 · 陕西女声", value: "zh-CN-shaanxi-XiaoniNeural", short: "小妮" },
  { label: "曉臻 · 台湾女声", value: "zh-TW-HsiaoChenNeural", short: "曉臻" },
  { label: "曉曼 · 粤语女声", value: "zh-HK-HiuMaanNeural", short: "曉曼" },
  { label: "Connor · 英文男声", value: "en-IE-ConnorNeural", short: "Connor" },
];

function voiceLabelOf(value) {
  const hit = VOICE_LIST.find((v) => v.value === value);
  return hit ? hit.label : value;
}

function voiceShortOf(value) {
  const hit = VOICE_LIST.find((v) => v.value === value);
  return hit ? hit.short : value;
}

class TtsService {
  constructor(plugin) {
    this.plugin = plugin;
    this.engine = ENGINE.AUTO;
    this.voice = "zh-CN-XiaoxiaoNeural";
    this.rate = 1;
    this.active = null;
    this.failed = new Set();
    this.instances = {};
    this.lastEngineName = null;
    // 声源代次：每次切换声源自增。用于区分「引擎真的坏了」与
    // 「在途请求被我们自己的换声源 close() 打断」，后者不算故障。
    this.voiceGen = 0;
  }

  _candidates() {
    if (this.engine !== ENGINE.AUTO) {
      return [this.engine];
    }
    // 严格锁定声源（默认行为）：自动模式下只用 Edge（直连 / 内核代理）。
    // Edge 是唯一真正支持用户所选「晓晓 / 云希 / 曉臻 …」的引擎；
    // 百度 / 有道 / 系统语音都各有内置音色，一旦降级过去，用户就会听到
    // 「突然换人声」——这正是要避免的。宁可失败并明确报错，也不静默换声。
    // 需要 HTTP / 系统语音时，可在菜单里手动指定引擎（那时不保证声源一致）。
    const list = [];
    if (USE_NODE_NET) {
      list.push(ENGINE.EDGE_DIRECT);
    }
    if (kernelSupportsWsProxy()) {
      list.push(ENGINE.EDGE_PROXY);
    }
    return list;
  }

  _instance(name) {
    if (this.instances[name]) {
      return this.instances[name];
    }
    let instance = null;
    if (name === ENGINE.EDGE_DIRECT) {
      instance = new MsEdgeTTS("node");
    } else if (name === ENGINE.EDGE_PROXY) {
      instance = new MsEdgeTTS("kernel");
    } else if (name === ENGINE.HTTP) {
      instance = new HttpTts();
    } else if (name === ENGINE.SYSTEM) {
      instance = new SystemTts();
    }
    this.instances[name] = instance;
    return instance;
  }

  _isEdge(name) {
    return name === ENGINE.EDGE_DIRECT || name === ENGINE.EDGE_PROXY;
  }

  engineName(name) {
    const key = ENGINE_LABELS[name];
    return key ? (this.plugin.i18n[key] || name) : name;
  }

  async synthesize(text) {
    // 切换声源会 close() 掉在途请求，那属于预期中断而非引擎故障。
    // 对「因切换声源而中断」做有限次重试，用新声源重新合成，
    // 保证切换后立刻生效；期间绝不把引擎标记为失败。
    const MAX_VOICE_RETRY = 3;
    for (let attempt = 0; ; attempt++) {
      const gen = this.voiceGen;
      try {
        return await this._synthesizeWithFallback(text, gen);
      } catch (e) {
        if (e && e.voiceChanged && attempt < MAX_VOICE_RETRY) {
          logger.info(`[TTS]\t声源已切换，改用新声源重试（第 ${attempt + 1} 次）`);
          continue;
        }
        throw e;
      }
    }
  }

  async _synthesizeWithFallback(text, gen) {
    const candidates = this._candidates();
    if (!candidates.length) {
      // 自动模式下没有任何 Edge 通道可用（如内核 < 3.7.0 的移动端）。
      // 不做静默降级，直接说明原因与出路。
      throw new Error(this.plugin.i18n.edgeUnavailable ||
        "无法使用所选声源：需要 Edge 直连或内核 WS 代理（内核 ≥ 3.7.0）。" +
        "为避免突然换人声，不会自动改用其它语音；可在菜单中手动指定引擎。");
    }

    let lastError = null;
    // 最多两轮：第一轮跳过「本次会话已失败过」的引擎；若一个都没轮到
    // （全部躺在失败名单里），清空名单后**真正重试一轮**。
    // 旧实现此时只清名单就抛错，会出现「没尝试就失败」，与「失败要重试」不符。
    for (let round = 0; round < 2; round++) {
      let attempted = false;

      for (const name of candidates) {
        if (this.failed.has(name)) {
          continue;
        }
        attempted = true;
        try {
          const instance = this._instance(name);
          if (this._isEdge(name)) {
            await instance.setMetadata(this.voice, DEFAULT_OUTPUT_FORMAT);
          }
          if (instance.available === false) {
            throw new Error("引擎不可用");
          }
          const result = await instance.synthesize(text);
          // Edge 返回裸 ArrayBuffer，播放层约定 playable 形如 { kind, data }；
          // 此处统一包装，避免播放时取不到音频数据。
          const wrapped = (result instanceof ArrayBuffer ||
            (result && typeof result.byteLength === "number" && !result.kind))
            ? { kind: "buffer", data: result }
            : result;
          if (wrapped && wrapped.kind === "buffer" &&
            (!wrapped.data || !wrapped.data.byteLength)) {
            // 声源与文本语种不匹配时 Edge 会返回 0 字节（如英文声源读中文），
            // 必须抛错交给上层重试，而不是静默播空。
            throw new Error(this._isEdge(name)
              ? `声源「${voiceShortOf(this.voice)}」读不了这段内容（语种可能不匹配）`
              : "引擎返回空音频");
          }
          if (this.active !== name) {
            logger.info(`[TTS]\t使用引擎: ${name}`);
          }
          this.active = name;
          this.lastEngineName = this.engineName(name);
          return wrapped;
        } catch (e) {
          lastError = e;
          // 期间用户切换了声源：这次失败是我们自己的 close() 造成的，属预期中断。
          // 不能标记引擎失败：否则一次换声源就会永久跳过 Edge。
          if (this.voiceGen !== gen) {
            const changed = new Error("声源已切换");
            changed.voiceChanged = true;
            throw changed;
          }
          logger.warn(`[TTS]\t引擎 ${name} 失败:`, e && e.message ? e.message : e);
          this.failed.add(name);
          if (this.active === name) {
            this.active = null;
          }
        }
      }

      if (attempted) {
        break;
      }
      if (round === 0) {
        logger.info("[TTS]\t引擎失败名单已重置，重新尝试");
        this.failed.clear();
      }
    }

    throw lastError || new Error("所有语音引擎均不可用，请检查网络后重试");
  }

  setVoice(voice) {
    this.voice = voice;
    // 声源代次自增：让仍在途的旧声源请求知道自己已被取代（见 synthesize）
    this.voiceGen++;
    // 切换声源是用户主动操作，视为一次干净的重试：
    // 清掉历史失败标记，避免某次网络抖动导致 Edge 被永久跳过、
    // 一路降级到系统语音后报「系统语音播放失败」。
    this.failed.clear();
    // 主动断开 Edge 连接：让在途的旧声源请求立刻失败，
    // 进而在新生代下用新声源立即重试。
    // 不这样做的话，旧请求要等很久才会超时，表现为「切了人声没生效」。
    for (const name of [ENGINE.EDGE_DIRECT, ENGINE.EDGE_PROXY]) {
      const inst = this.instances[name];
      if (inst && inst._ws && typeof inst.close === "function") {
        try {
          inst.close();
        } catch (e) { /* ignore */ }
      }
    }
  }

  // 语音引擎切换时清理失败标记
  setEngine(engine) {
    this.engine = engine;
    this.failed.clear();
    this.active = null;
  }

  close() {
    for (const [name, instance] of Object.entries(this.instances)) {
      try {
        instance.close();
      } catch (e) { /* ignore */ }
      if (name === ENGINE.EDGE_DIRECT || name === ENGINE.EDGE_PROXY) {
        // Edge 客户端关闭后仍可复用，无需销毁实例
      }
    }
  }
}

/*****************************************************************************
 * 八、音频播放
 *****************************************************************************/
// 全局共享 AudioContext：避免多块缓存触发浏览器上下文数量上限，也便于统一暂停/恢复
let sharedAudioContext = null;

function getAudioContext() {
  if (!sharedAudioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      throw new Error("当前环境不支持 AudioContext");
    }
    sharedAudioContext = new Ctor();
  }
  return sharedAudioContext;
}

// 移动端（Android / iOS / 鸿蒙 ArkWeb）禁止「非用户手势」触发的音频播放：
// 合成需要 await 网络请求，等音频就绪时用户手势上下文已失效，
// AudioContext 会停在 suspended，source.start() 不报错但完全没有声音。
// 因此必须在点击的同步阶段先解锁：创建上下文 + resume + 播放一帧静音。
let audioUnlocked = false;
function unlockAudio() {
  try {
    const ctx = getAudioContext();
    const wasSuspended = ctx.state === "suspended";
    if (wasSuspended && typeof ctx.resume === "function") {
      const p = ctx.resume();
      if (p && p.catch) {
        p.catch(() => { /* 忽略，播放时会再次尝试 */ });
      }
    }
    // 每次处于 suspended（含切后台后被系统挂起）都重新播一帧静音，
    // 让 WebView 把它重新标记为「已被用户手势激活」
    if (wasSuspended || !audioUnlocked) {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      audioUnlocked = true;
    }
  } catch (e) {
    logger.warn("[TTS]\t音频解锁失败（将尝试播放时恢复）:", e && e.message ? e.message : e);
  }
}

// 等待 AudioContext 真正进入 running，避免在 suspended 状态下静默播放
async function ensureAudioRunning(timeout = 1200) {
  const ctx = getAudioContext();
  if (ctx.state === "running") {
    return true;
  }
  if (typeof ctx.resume === "function") {
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    } catch (e) { /* 忽略 */ }
  }
  return ctx.state === "running";
}

// 单块朗读失败后的重试次数与退避基数。
// 之前的实现是「失败即跳过该块」，网络抖动时会白白漏读一整块。
const MAX_BLOCK_RETRY = 2;
const BLOCK_RETRY_DELAY = 600;

// 从块元素向上找文档 ID（思源把 data-root-id 挂在 protyle 容器上，
// 不同版本位置不一，这里多找一层并允许元素自身带该属性）
function rootIdOf(el) {
  if (!el || typeof el.closest !== "function") {
    return null;
  }
  const holder = el.closest("[data-root-id]");
  const id = (holder && holder.getAttribute("data-root-id")) || el.getAttribute("data-root-id");
  return id || null;
}

// 当前打开的文档 ID；无法确定时返回 null
function currentDocRootId() {
  const w = document.querySelector(".protyle-wysiwyg");
  if (!w) {
    return null;
  }
  return rootIdOf(w) || w.getAttribute("data-node-id") || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Player {
  constructor(service, controller) {
    this.controller = controller;
    this.service = service;
    this.loaded = false;
    this.loading = false;
    this.isEmpty = true;
    this.error = null;
    this.rate = 1;
    this.playable = null;
    this.source = null;
    this.stopped = false;
    // _playBuffer 里等待 ended 的 resolve 队列：stop() 时要主动放行
    this._stopWaiters = [];
    this.id = new Date().getTime();
  }

  // block: Block 对象
  load(block) {
    this.isEmpty = block.isEmpty();
    if (this.isEmpty) {
      this.loaded = true;
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.block = block;
    this.content = block.content;
    logger.info(`[Player]\tloading block: '${this.content}'`);
    this.loading = true;

    this.loadPromise = this.service.synthesize(this.content)
      .then(async (playable) => {
        if (!playable || !playable.kind) {
          throw new Error("语音引擎返回数据格式不正确");
        }
        if (playable.kind === "buffer") {
          if (!playable.data || !playable.data.byteLength) {
            throw new Error("语音引擎返回空音频");
          }
          const context = getAudioContext();
          const audioBuffer = await new Promise((resolve, reject) => {
            context.decodeAudioData(playable.data, resolve, (err) => {
              reject(new Error("音频解码失败：" +
                (err && err.message ? err.message : "该设备可能不支持此音频格式")));
            });
          });
          this.playable = { kind: "buffer", audioBuffer };
        } else {
          this.playable = playable;
        }
        this.loaded = true;
        this.loading = false;
      })
      .catch((e) => {
        this.loading = false;
        // 跨 realm（如来自不同上下文）时 instanceof 可能失效，优先取 message
        this.error = (e && typeof e.message === "string" && e.message)
          ? new Error(e.message)
          : new Error(String(e));
        logger.error("[Player]\tload failed:", e);
      });

    return this.loadPromise;
  }

  /**
   * 清掉上次失败的缓存并**真正重新合成**。
   *
   * load() 会把 loadPromise / error / playable 缓存下来，成功前不会重来；
   * 若重试时不清缓存，player.play() 只会把同一个旧 error 再抛一遍，
   * 网络根本没被重新请求 —— 那样的「重试」是假的。
   */
  async retryLoad(block) {
    this.loadPromise = null;
    this.error = null;
    this.playable = null;
    this.loaded = false;
    this.loading = false;
    this.isEmpty = block ? block.isEmpty() : this.isEmpty;
    return this.load(block || this.block);
  }

  async setRate(rate) {
    this.rate = rate;
    if (this.source) {
      this.source.playbackRate.value = rate;
    }
  }

  async play() {
    if (!this.loaded) {
      await this.load(this.block);
    }
    if (this.error) {
      throw this.error;
    }
    if (this.isEmpty || !this.playable) {
      return;
    }
    this.block.highlight();

    if (this.playable.kind === "buffer") {
      await this._playBuffer();
    } else {
      await this._playSystem();
    }
    this.block.unhighlight();
  }

  async _playBuffer() {
    const context = getAudioContext();
    // 移动端/鸿蒙：必须等到 running 才能出声，否则 start() 静默失败
    const running = await ensureAudioRunning();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (e) { /* ignore */ }
      if (context.state !== "running") {
        throw new Error("音频被浏览器自动播放策略阻止（" + (running ? "suspended" : "blocked") + "）");
      }
    }
    // stop() 可能在上面 await 期间被调用（例如用户又双击了别的块），
    // 此时必须彻底放弃，否则等会儿 start() 会凭空多出一路声音。
    if (this.stopped || (this.controller && this.controller.stopped)) {
      return;
    }
    const source = context.createBufferSource();
    // 防御：拿不到解码结果时直接报错，避免 source.start() 静默播空音频
    if (!this.playable || !this.playable.audioBuffer) {
      throw new Error("音频数据缺失（解码失败或引擎返回格式不正确）");
    }
    source.buffer = this.playable.audioBuffer;
    source.playbackRate.value = this.rate;
    source.connect(context.destination);
    this.source = source;
    this.source.start(0);
    await new Promise((resolve) => {
      source.addEventListener("ended", resolve);
      // stop() 会主动 stop() 掉 source，ended 事件在部分环境（鸿蒙 ArkWeb）不再触发，
      // 需要一条退路把等待解开，否则整条 play() 链会永久悬挂。
      this._stopWaiters.push(resolve);
      if (this.stopped) {
        resolve();
      }
    });
    this._stopWaiters = [];
    this.source = null;
  }

  async _playSystem() {
    const { chunks, lang, voice } = this.playable;
    const system = this.service._instance(ENGINE.SYSTEM);
    for (const chunk of chunks) {
      if (this.stopped) {
        return;
      }
      await system.speak(chunk, lang, voice, this.rate);
    }
  }

  stop() {
    this.stopped = true;
    if (this.source) {
      try {
        this.source.stop();
      } catch (e) { /* ignore */ }
      this.source = null;
    }
    // 放行 _playBuffer 中等待 ended 的 promise（source.stop() 不保证触发 ended）
    const waiters = this._stopWaiters;
    this._stopWaiters = [];
    waiters.forEach((resolve) => {
      try {
        resolve();
      } catch (e) { /* ignore */ }
    });
    if (this.playable && this.playable.kind === "system") {
      try {
        this.service._instance(ENGINE.SYSTEM).stop();
      } catch (e) { /* ignore */ }
    }
  }

  pause() {
    if (this.playable && this.playable.kind === "buffer") {
      try {
        getAudioContext().suspend();
      } catch (e) { /* ignore */ }
    } else {
      try {
        this.service._instance(ENGINE.SYSTEM).pause();
      } catch (e) { /* ignore */ }
    }
  }

  resume() {
    if (this.playable && this.playable.kind === "buffer") {
      try {
        getAudioContext().resume();
      } catch (e) { /* ignore */ }
    } else {
      try {
        this.service._instance(ENGINE.SYSTEM).resume();
      } catch (e) { /* ignore */ }
    }
  }
}

class Block {
  constructor(blockElement) {
    if (!blockElement) {
      throw Error("Block constructor must has 1 parameter blockElement or string content");
    }
    if (typeof blockElement === "string") {
      this.content = blockElement;
      this.el = null;
      return;
    }
    this.el = blockElement;
    this.content = blockElement.textContent
      .normalize("NFD")
      .replace(/[\u200B-\u200D\uFEFF]/g, "");
  }

  isEmpty() {
    return this.content.trim() === "";
  }

  highlight() {
    this._toggleHighlight(true);
  }

  unhighlight() {
    this._toggleHighlight(false);
  }

  _toggleHighlight(add) {
    if (!this.el) {
      return;
    }
    const nodeId = this.el.getAttribute("data-node-id");
    const el2 = document.querySelector(`.protyle-wysiwyg [data-node-id="${nodeId}"]`);
    if (el2) {
      el2.classList[add ? "add" : "remove"]("tts-highlight");
    }
  }
}

class Controller {
  constructor(config, plugin) {
    this.plugin = plugin;
    this.init();
    this.maxCache = 3;
    this.service = plugin.tts || new TtsService(plugin);
    this.playbackRate = config.playbackRate;
    this.service.rate = config.playbackRate;
  }

  loadBlocks(blockElements) {
    this.blocks = blockElements.map((v) => new Block(v));
  }

  // 已加载的块 DOM 列表（用于「从某块开始朗读」时复用，避免重新请求）
  blockElements() {
    return this.blocks.filter((b) => b.el).map((b) => b.el);
  }

  loadContent(content) {
    if (typeof content !== "string") {
      throw Error("loadContent must have a string parameter");
    }
    this.blocks = [new Block(content)];
  }

  async play() {
    if (this.stopped) {
      return;
    }
    this.plugin.showControlBar(this);
    this.plugin.setStatus(this.plugin.i18n.loading);

    while (this.players.length < this.maxCache && this.cacheIndex < this.blocks.length) {
      if (this.blocks[this.cacheIndex].isEmpty()) {
        this.cacheIndex++;
        continue;
      }
      const player = new Player(this.service, this);
      player.load(this.blocks[this.cacheIndex]);
      this.players.push(player);
      this.cacheIndex++;
    }

    const player = this.players[0];
    if (!player) {
      this.stop();
      this.plugin.setStatus(this.plugin.i18n.idle);
      return;
    }

    if (typeof this.plugin.markPlayState === "function") {
      this.plugin.markPlayState("playing");
    }

    // 记住这一块：暂停/停止后点「继续」时要能回到上次朗读的位置
    if (player.block && typeof this.plugin.rememberBlock === "function") {
      this.plugin.rememberBlock(player.block);
    }

    const engineTip = this.service.lastEngineName ? ` · ${this.service.lastEngineName}` : "";
    this.plugin.setStatus(
      `${this.plugin.i18n.playing || "播放"} ${this.playIndex + 1}/${this.blocks.length}${engineTip}`
    );

    // 失败重试而不是跳过：网络抖动不该让用户白丢一整块内容。
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_BLOCK_RETRY; attempt++) {
      try {
        await player.setRate(this.playbackRate);
        if (attempt > 0) {
          // 重试必须重新合成：否则只是把缓存的旧错误再抛一遍
          await player.retryLoad(player.block);
        }
        await player.play();
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const reason = e && e.message ? e.message : String(e);
        logger.error(`[Controller]\tplay block failed (第 ${attempt + 1} 次):`, e);
        if (player.block) {
          player.block.unhighlight();
        }
        // 用户已停止 / 已切换朗读：立即退出，不再重试也不再推进
        if (this.stopped) {
          return;
        }
        if (attempt < MAX_BLOCK_RETRY) {
          this.plugin.setStatus(
            `${this.plugin.i18n.blockRetrying || "朗读失败，正在重试"} ${attempt + 1}/${MAX_BLOCK_RETRY}（${reason}）`);
          await sleep(BLOCK_RETRY_DELAY * (attempt + 1));
          if (this.stopped) {
            return;
          }
          continue;
        }
        // 重试用尽：明确告知，并把这块留在原地等用户决定，不静默跳过
        showMessage(`${this.plugin.i18n.blockFailed || "朗读失败"}：${reason}`, 6000);
        this.plugin.setStatus(
          `${this.plugin.i18n.blockFailed || "朗读失败"}（${reason}）`);
      }
    }
    // await 期间可能已被 stop()（用户又双击了别的块）或被新一次朗读接管，
    // 这时必须立刻退出，否则会推进索引并递归播放，造成多路声音重叠。
    if (this.stopped) {
      return;
    }
    this.players.shift();
    if (lastError) {
      // 本块重试仍失败：停下并询问是否继续读后续块，而不是直接跳过
      if (typeof this.plugin.onBlockFailed === "function") {
        this.plugin.onBlockFailed(this, lastError);
      }
      return;
    }
    this.playIndex++;
    // 不再在这里询问「是否继续」：默认就是一块接一块读下去。
    // 列表读完时递归调用 play() 会因为取不到 player 而自然收尾（stop + 空闲），
    // 这与改动前的行为一致。
    this.play();
  }

  stop() {
    this.stopped = true;
    this.players.forEach((p) => {
      try {
        p.stop();
      } catch (e) { /* ignore */ }
    });
    // 注意：这里绝不能调用 init()，它会把这个 stopped 重置回 false，
    // 于是被 stop() 打断、正卡在 await 里的那个 play() 循环会「复活」继续朗读。
    // 用户连续双击多个块时，就会出现几路声音叠在一起。
    // 只清空队列，保留 stopped = true 作为终态。
    const block = this.blocks[this.playIndex];
    this.players = [];
    this.blocks = [];
    this.cacheIndex = 0;
    this.playIndex = 0;
    // service 是插件级共享实例（plugin.tts），这里不能 close()，
    // 否则会把「下一段朗读」正要复用的 Edge 连接一起拆掉。
    if (block) {
      block.unhighlight();
    }
    if (typeof this.plugin.markPlayState === "function") {
      this.plugin.markPlayState("idle");
    }
    this.plugin.hideControlBar(this);
  }

  init() {
    this.blocks = [];
    this.players = [];
    this.cacheIndex = 0;
    this.playIndex = 0;
    this.isPaused = false;
    this.stopped = false;
  }

  pause() {
    if (this.players && this.players[0]) {
      this.players[0].pause();
    }
    this.isPaused = true;
  }

  resume() {
    if (this.players && this.players[0]) {
      this.players[0].resume();
    }
    this.isPaused = false;
  }
}

/*****************************************************************************
 * 九、环境自检：在手机 / 平板 / 鸿蒙等无法连调试器的设备上定位「无声」原因
 *****************************************************************************/
async function diagnose(plugin) {
  const lines = [];
  const add = (ok, label, detail) => {
    const mark = ok === true ? "✅" : (ok === false ? "❌" : "•");
    lines.push(`${mark} ${label}${detail ? "：" + detail : ""}`);
  };

  // 1. 平台识别
  let backend = "unknown";
  let frontend = "unknown";
  try {
    backend = getBackendName();
  } catch (e) { /* ignore */ }
  try {
    frontend = (typeof window.siyuan.config.system.container === "string" &&
      ["docker", "ios", "android", "harmony"].includes(window.siyuan.config.system.container))
      ? "mobile" : "desktop";
  } catch (e) { /* ignore */ }
  add(null, "平台", `backend=${backend} UI=${isMobileUI() ? "移动端" : "桌面端"} 鸿蒙=${isHarmonyOS()}`);
  add(null, "内核版本", getKernelVersion() || "未知");
  add(USE_NODE_NET === true, "Node 网络栈", USE_NODE_NET ? "可用（可直连 Edge）" : "不可用（移动端正常）");

  // 2. API Token（内核代理依赖它）
  const token = getApiToken();
  add(token ? true : false, "API Token", token ? "已获取" : "未获取，内核代理将不可用（请在设置中开启 API 令牌）");

  // 3. 内核 WebSocket 代理能力
  const wsOk = kernelSupportsWsProxy();
  add(wsOk, "内核 WS 代理", wsOk ? "支持（≥3.7.0）" : `不支持（内核 ${getKernelVersion()} < 3.7.0）`);

  // 4. AudioContext 与自动播放策略
  let ctxState = "不可用";
  try {
    const ctx = getAudioContext();
    ctxState = ctx.state;
    if (ctx.state === "suspended") {
      try {
        ctx.resume();
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    ctxState = "创建失败：" + (e && e.message ? e.message : e);
  }
  add(ctxState === "running" ? true : (ctxState === "suspended" ? false : null),
    "AudioContext", ctxState + (ctxState === "suspended" ? "（已被自动播放策略阻止，请点击一次播放解锁）" : ""));

  // 5. 系统语音音色
  let voiceInfo = "不支持";
  try {
    if (typeof window.speechSynthesis !== "undefined") {
      const voices = window.speechSynthesis.getVoices() || [];
      const zh = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("zh"));
      voiceInfo = `共 ${voices.length} 个音色，其中中文 ${zh.length} 个`;
      if (voices.length === 0) {
        voiceInfo += "（为空则该设备未安装语音引擎，系统语音会无声）";
      }
    }
  } catch (e) {
    voiceInfo = "异常：" + (e && e.message ? e.message : e);
  }
  add(/否则|共 [1-9]/.test(voiceInfo) ? true : (voiceInfo === "不支持" ? false : null), "系统语音", voiceInfo);

  // 6. 各在线引擎连通性实测
  lines.push("");
  lines.push("—— 在线引擎连通性实测 ——");

  const probeText = "语音测试";

  // Edge 直连
  if (USE_NODE_NET) {
    try {
      const edge = new MsEdgeTTS("node");
      await edge.setMetadata(plugin.currentMetadata || "zh-CN-XiaoxiaoNeural", DEFAULT_OUTPUT_FORMAT);
      const r = await edge.synthesize(probeText);
      edge.close();
      // Edge 引擎返回裸 ArrayBuffer，也可能是 { kind, data }，两种都兼容
      const size = r && typeof r.byteLength === "number" ? r.byteLength : (r && r.data ? r.data.byteLength : 0);
      add(size > 0, "Edge 直连", `成功，音频 ${size} 字节`);
    } catch (e) {
      add(false, "Edge 直连", "失败：" + (e && e.message ? e.message : e));
    }
  } else {
    add(null, "Edge 直连", "跳过（移动端无 Node 网络栈）");
  }

  // Edge 内核代理
  if (wsOk && token) {
    try {
      const edge = new MsEdgeTTS("kernel");
      await edge.setMetadata(plugin.currentMetadata || "zh-CN-XiaoxiaoNeural", DEFAULT_OUTPUT_FORMAT);
      const r = await edge.synthesize(probeText);
      edge.close();
      // Edge 引擎返回裸 ArrayBuffer，也可能是 { kind, data }，两种都兼容
      const size = r && typeof r.byteLength === "number" ? r.byteLength : (r && r.data ? r.data.byteLength : 0);
      add(size > 0, "Edge 内核代理", `成功，音频 ${size} 字节`);
    } catch (e) {
      add(false, "Edge 内核代理", "失败：" + (e && e.message ? e.message : e));
    }
  } else {
    add(null, "Edge 内核代理", !wsOk ? "跳过（内核版本过低）" : "跳过（缺少 API Token）");
  }

  // HTTP 在线语音（逐服务商）
  // 国内服务商有频率限制，瞬时连续请求会返回 ratelimit，
  // 因此重试几次再判定，避免把限流误报为「不可用」。
  const http = new HttpTts();
  for (const provider of HTTP_PROVIDERS) {
    let bytes = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const got = await http._fetchChunk(provider, probeText, "zh-CN", 1);
        if (isAudioBytes(got)) {
          bytes = got;
          break;
        }
        lastErr = describeBadResponse(got);
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        // 认证/锁定问题：所有服务商都会失败，且重试会延长锁定
        if (HttpTts.isAuthError(e)) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    if (bytes) {
      add(true, `在线语音 ${provider.name}`, `成功，音频 ${bytes.length} 字节`);
    } else {
      const limited = typeof lastErr === "string" && /ratelimit|rate limit/i.test(lastErr);
      add(false, `在线语音 ${provider.name}`,
        (limited ? "被限流（稍后重试通常可用）：" : "失败：") + lastErr);
    }
    if (typeof lastErr === "string" && /内核认证被锁定|API 令牌无效|内核拒绝访问/.test(lastErr)) {
      lines.push("  （已跳过其余在线服务商：内核认证问题与具体服务商无关）");
      break;
    }
  }

  // 7. 结论建议
  lines.push("");
  lines.push("—— 建议 ——");
  if (USE_NODE_NET) {
    lines.push("桌面端优先使用 Edge 直连，音质最好。");
  } else {
    lines.push("移动端推荐「自动」引擎，会依次尝试 Edge 内核代理 → 在线语音 → 系统语音。");
  }
  if (!wsOk) {
    lines.push("内核低于 3.7.0：Edge 内核代理不可用，将直接使用在线语音。");
  }
  if (!token) {
    lines.push("缺少 API Token 会同时禁用「Edge 内核代理」和「在线语音」两条路径。");
  }

  return lines.join("\n");
}

async function showDiagnoseDialog(plugin) {
  let content = "正在检测，请稍候…";
  const dialog = new Dialog({
    title: "TTS 环境自检",
    content: `<div class="b3-dialog__content" style="max-height:70vh;overflow:auto;">
      <pre id="tts-diag-result" style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;margin:0;">${content}</pre>
    </div>`,
    width: isMobileUI() ? "92vw" : "560px",
    height: isMobileUI() ? "72vh" : "auto",
  });

  const pre = dialog.element.querySelector("#tts-diag-result");
  try {
    content = await diagnose(plugin);
  } catch (e) {
    content = "自检过程出错：\n" + (e && e.stack ? e.stack : e);
  }
  if (pre) {
    pre.textContent = content;
  }
  return dialog;
}

/*****************************************************************************
 * 十、插件入口
 *****************************************************************************/
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

module.exports = class TTSPlugin extends Plugin {
  metadataMap = {
    "晓晓-中文女声": "zh-CN-XiaoxiaoNeural",
    "云希-中文男声": "zh-CN-YunxiNeural",
    "云扬-中文男声": "zh-CN-YunyangNeural",
    "Connor-英文男声": "en-IE-ConnorNeural",
  };

  currentMetadata = DEFAULT_VOICE;

  playbackRate = 1;

  engine = ENGINE.AUTO;

  controller = null;

  async loadStorage() {
    try {
      const config = await this.loadData("config.json");
      if (config) {
        this.currentMetadata = config.currentMetadata || DEFAULT_VOICE;
        this.playbackRate = config.playbackRate || 1;
        this.engine = config.engine || ENGINE.AUTO;
      }
    } catch (e) {
      logger.warn("[TTS]\tload storage failed", e);
    }
  }

  async saveStorage() {
    try {
      await this.saveData("config.json", JSON.stringify({
        currentMetadata: this.currentMetadata,
        playbackRate: this.playbackRate,
        engine: this.engine,
      }));
    } catch (e) {
      logger.warn("[TTS]\tsave storage failed", e);
    }
  }

  onload() {
    this.loadStorage();
    this.status = this.i18n.title;
    this.tts = new TtsService(this);
    this.tts.setVoice(this.currentMetadata);
    this.tts.rate = this.playbackRate;
    this.tts.engine = this.engine;

    this.addCommand({
      langKey: "quickOpen",
      hotkey: "⌥⌘W",
      callback: () => {
        const content = window.getSelection ? window.getSelection().toString() : "";
        if (content && content.trim()) {
          this.startRead([content]);
          return;
        }
        const blocks = document.querySelectorAll(".protyle-wysiwyg--select");
        if (blocks.length > 0) {
          this.startRead([...blocks].map((b) => b.textContent));
          return;
        }
        showMessage(this.i18n.noSelection || "没有可以朗读的选中内容");
      },
    });

    const topBarElement = this.addTopBar({
      icon: "iconRecord",
      title: this.i18n.title,
      position: "right",
      callback: () => {
        let rect = topBarElement.getBoundingClientRect();
        if (!rect.width) {
          const barMore = document.querySelector("#barMore");
          rect = barMore ? barMore.getBoundingClientRect() : { right: window.innerWidth - 8, bottom: 64 };
        }
        this.addMenu(rect);
      },
    });

    // 块菜单
    this.eventBus.on("click-blockicon", ({ detail }) => {
      const blocks = detail.blockElements.map((block) => {
        if (block.classList.contains("code-block")) {
          return null;
        }
        const clone = block.cloneNode(true);
        clone.querySelectorAll('span[data-type*="sup"]').forEach((sup) => sup.remove());
        return clone;
      }).filter((block) => block !== null);

      detail.menu.addItem({
        icon: "iconRecord",
        label: this.i18n.menuName,
        click: async () => {
          // 用户手势的同步阶段必须先解锁音频（await 之后手势失效会无声）
          unlockAudio();
          const rootID = detail.protyle.block.rootID;
          if (blocks.length === 1) {
            // 只选中一个块：从该块一直读到文档末尾（一块接一块，无需确认）。
            // 定位不到该块时 fetchBlocksFrom 会退回「从第一个块开始」。
            const from = await this.fetchBlocksFrom(rootID, blocks[0]);
            this.startBlocks(from.length ? from : blocks);
            return;
          }
          if (!blocks.length) {
            // 不知道从哪个块开始：从第一个块开始读整篇
            const all = await this.fetchBlocksFrom(rootID, null);
            if (all.length) {
              this.startBlocks(all);
            }
            return;
          }
          // 多选：读所选这些块（也无需确认，读完即止）
          this.startBlocks(blocks);
        },
      });

      detail.menu.addItem({
        icon: "iconRecord",
        label: this.i18n.menuToEnd,
        click: async () => {
          // 必须在 await 之前解锁：await 之后用户手势已失效，
          // 移动端/鸿蒙上 AudioContext 将无法恢复，导致无声
          unlockAudio();
          // 没有当前块时 currentBlockId 为 undefined，
          // fetchDocBlocks 的 fromBlockId 为空即从第一个块开始（整篇朗读）。
          const currentBlockId = blocks[0] && blocks[0].getAttribute("data-node-id");
          const allBlocks = await this.fetchDocBlocks(detail.protyle.block.rootID, currentBlockId);
          if (allBlocks.length) {
            this.startBlocks(allBlocks);
          } else {
            showMessage(this.i18n.loadFailed || "获取文档内容失败");
          }
        },
      });
    });

    // 文档标题菜单
    this.eventBus.on("click-editortitleicon", async ({ detail }) => {
      detail.menu.addItem({
        icon: "iconRecord",
        label: this.i18n.menuName,
        click: async () => {
          unlockAudio();
          const blocks = await this.fetchDocBlocks(detail.protyle.block.rootID, null);
          this.startBlocks(blocks);
        },
      });
    });

    this.addStatus();
    // 手势绑定失败不应影响插件其余功能
    try {
      this.bindDoubleTap();
    } catch (e) {
      logger.warn("[TTS]\t双击朗读绑定失败", e);
    }

    logger.info(`[TTS]\t平台: backend=${getBackendName()} 鸿蒙=${isHarmonyOS()} 内核=${getKernelVersion()} Node=${USE_NODE_NET}`);
  }

  onunload() {
    this.unbindDoubleTap();
    if (this.controller) {
      this.controller.stop();
      this.controller = null;
    }
    if (this.tts) {
      this.tts.close();
    }
    if (this.mobileBar) {
      this.mobileBar.remove();
      this.mobileBar = null;
      this.mobileBarText = null;
    }
    this.voiceLabelEl = null;
  }

  startBlocks(blockElements) {
    // 移动端/鸿蒙：必须在用户点击的同步阶段解锁音频，
    // 否则合成完成时手势已失效，AudioContext 处于 suspended 会完全无声
    unlockAudio();
    this.stopReading();
    this.controller = new Controller({
      playbackRate: this.playbackRate,
    }, this);
    this.controller.loadBlocks(blockElements);
    // 载入的列表就是全部要读的内容，一块接一块读到底，无需用户确认
    this.controller.play();
  }

  // 单块重试用尽：明确告知原因并停下（不静默跳过、也不放额外按钮）。
  // 用户想继续时，直接重新选择起点即可。
  onBlockFailed(controller, err) {
    if (this.controller !== controller) {
      return;
    }
    const reason = err && err.message ? err.message : String(err);
    this.setStatus(`${this.i18n.blockFailed || "朗读失败"}（${reason}）`);
    controller.stop();
  }

  // 双击块跳转朗读的绑定。
  // 只有在「正在播放（含暂停）」时才拦截手势，未播放时完全不干预，
  // 以免影响思源自身的双击选词 / 进入编辑。
  bindDoubleTap() {
    const resolveBlock = (target) => {
      if (!target || typeof target.closest !== "function") {
        return null;
      }
      const wysiwyg = target.closest(".protyle-wysiwyg");
      if (!wysiwyg) {
        return null;
      }
      const el = target.closest("[data-node-id]");
      if (!el || !wysiwyg.contains(el)) {
        return null;
      }
      // 代码块不参与朗读
      if (el.classList.contains("code-block")) {
        return null;
      }
      return el;
    };

    const isActive = () => !!(this.controller && this.controller.blocks &&
      this.controller.blocks.length && !this.controller.stopped);

    // 桌面端：双击
    const onDblClick = (ev) => {
      if (!isActive()) {
        return;
      }
      const el = resolveBlock(ev.target);
      if (!el) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.readFromBlock(el);
    };

    // 移动端 / 鸿蒙：ArkWeb 上 dblclick 触发不稳定，手动识别双击
    let lastTapAt = 0;
    let lastTapId = null;
    let startX = 0;
    let startY = 0;
    let moved = false;

    const onTouchStart = (ev) => {
      const t = ev.touches && ev.touches[0];
      if (!t) {
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      moved = false;
    };
    const onTouchMove = (ev) => {
      const t = ev.touches && ev.touches[0];
      if (!t) {
        return;
      }
      // 滑动翻页/滚动时不要算作点击，避免误触发朗读
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        moved = true;
      }
    };
    const onTouchEnd = (ev) => {
      if (!isActive() || moved) {
        lastTapAt = 0;
        lastTapId = null;
        return;
      }
      const el = resolveBlock(ev.target);
      if (!el) {
        return;
      }
      const id = el.getAttribute("data-node-id");
      const now = Date.now();
      if (now - lastTapAt < 320 && lastTapId === id) {
        lastTapAt = 0;
        lastTapId = null;
        ev.preventDefault();
        ev.stopPropagation();
        this.readFromBlock(el);
        return;
      }
      lastTapAt = now;
      lastTapId = id;
    };

    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, true);

    // 记住引用，插件卸载/重载时移除，避免重复绑定导致一次双击触发多次朗读
    this.dblTapHandlers = { onDblClick, onTouchStart, onTouchMove, onTouchEnd };
  }

  unbindDoubleTap() {
    const h = this.dblTapHandlers;
    if (!h) {
      return;
    }
    document.removeEventListener("dblclick", h.onDblClick, true);
    document.removeEventListener("touchstart", h.onTouchStart, true);
    document.removeEventListener("touchmove", h.onTouchMove, true);
    document.removeEventListener("touchend", h.onTouchEnd, true);
    this.dblTapHandlers = null;
  }

  startRead(texts) {
    unlockAudio();
    this.stopReading();
    this.controller = new Controller({
      playbackRate: this.playbackRate,
    }, this);
    this.controller.loadContent(texts.join("\n"));
    this.controller.play();
  }

  stopReading() {
    if (this.controller) {
      this.controller.stop();
    }
  }

  // 双击某个块：从该块开始朗读到文档末尾。
  // 仅在播放中生效（未播放时不拦截双击，避免影响思源自身的选词/编辑手势）。
  async readFromBlock(blockEl) {
    if (!blockEl) {
      return false;
    }
    // 用户手势的同步阶段先解锁音频，await 之后手势就失效了
    unlockAudio();

    const nodeId = blockEl.getAttribute("data-node-id");
    if (!nodeId) {
      return false;
    }

    // 情况一：该块已经在当前播放列表里（例如「读到文档末尾」加载的），
    // 直接切片复用，省掉一次网络请求，也保证顺序完全一致。
    const current = this.controller;
    if (current && Array.isArray(current.blocks)) {
      const idx = current.blocks.findIndex(
        (b) => b.el && b.el.getAttribute("data-node-id") === nodeId);
      if (idx !== -1) {
        const reuse = current.blocks.slice(idx).filter((b) => b.el);
        if (reuse.length) {
          this.startBlocks(reuse.map((b) => b.el));
          return true;
        }
      }
    }

    // 情况二：重新拉取「该块 → 文档末尾」
    const holder = blockEl.closest("[data-root-id]");
    const rootID = holder && holder.getAttribute("data-root-id");
    if (!rootID) {
      // 退化为只朗读该块，避免完全无响应
      this.startBlocks([blockEl]);
      return true;
    }
    const blocks = await this.fetchDocBlocks(rootID, nodeId);
    if (!blocks.length) {
      showMessage(this.i18n.loadFailed || "获取文档内容失败");
      return false;
    }
    // await 之后手势已失效，但前面已同步解锁过音频
    this.startBlocks(blocks);
    return true;
  }

  // 统一切换声源：菜单、悬浮窗都走这里。
  // 切换后立即生效：正在朗读时，用新声源从当前块重新朗读，
  // 而不是等当前段播完（长段落会让人以为没生效）。
  setVoice(value) {
    if (!value || value === this.currentMetadata) {
      return;
    }
    this.currentMetadata = value;
    this.tts.setVoice(value);
    this.saveStorage();
    this.updateControlBars();
    showMessage(`${this.i18n.changeMetadata || "声源"}: ${voiceShortOf(value)}`);
    this.restartWithVoice();
  }

  // 用新声源从「当前正在读的块」重新开始朗读。
  // 仅在播放中（含暂停）生效；未播放时只记住设置，不主动开口。
  restartWithVoice() {
    const c = this.controller;
    if (!c || c.stopped || !Array.isArray(c.blocks) || !c.blocks.length) {
      return;
    }
    // 当前正在读的块就是 blocks[playIndex]：Controller 用 players[0] 对应
    // blocks[playIndex]，playIndex 是在每块播完之后才自增的。
    // 夹紧到有效范围，避免索引越界。
    const idx = Math.max(0, Math.min(c.playIndex, c.blocks.length - 1));
    // 优先「当前块 → 末尾」，保持原有播放范围；没有文档块时退化为纯文本内容
    const rest = c.blocks.slice(idx).filter((b) => b.el);
    if (rest.length) {
      this.startBlocks(rest.map((b) => b.el));
      return;
    }
    const text = c.blocks.slice(idx).map((b) => b.content)
      .filter((t) => t && t.trim()).join("\n");
    if (text) {
      this.startRead([text]);
    }
  }

  // 悬浮窗上直接切到上/下一个声源（保留给快捷键/命令使用，不再绑定单击）
  cycleVoice(step) {
    const idx = VOICE_LIST.findIndex((v) => v.value === this.currentMetadata);
    const base = idx === -1 ? 0 : idx;
    const next = (base + step + VOICE_LIST.length) % VOICE_LIST.length;
    this.setVoice(VOICE_LIST[next].value);
  }

  // 弹出完整声源列表供选择（移动端与桌面端共用）。
  // 移动端：Menu.popup 内部会自动转成底部弹出面板（fullscreen("bottom")），
  //         这里显式调用，避免依赖内部行为；桌面端则定位到按钮下方。
  openVoiceMenu(anchorEl) {
    unlockAudio();
    const menu = new Menu("ttsVoiceMenu");
    VOICE_LIST.forEach((v) => {
      menu.addItem({
        icon: v.value === this.currentMetadata ? "iconSelect" : "",
        label: v.label,
        click: () => this.setVoice(v.value),
      });
    });
    if (isMobileUI()) {
      menu.fullscreen("bottom");
      return;
    }
    let x = 0;
    let y = 0;
    try {
      const rect = anchorEl && anchorEl.getBoundingClientRect
        ? anchorEl.getBoundingClientRect()
        : null;
      if (rect) {
        // 菜单挂在按钮上方，避免贴到屏幕底部被裁掉
        x = Math.max(8, Math.min(rect.left, window.innerWidth - 200));
        y = Math.max(8, rect.top - 8);
      } else {
        x = window.innerWidth / 2;
        y = window.innerHeight / 2;
      }
    } catch (e) { /* ignore，用默认位置 */ }
    menu.open({ x, y });
  }

  // 同步底部状态栏与移动端悬浮窗上的声源文字
  updateControlBars() {
    const text = voiceShortOf(this.currentMetadata);
    if (this.voiceLabelEl) {
      this.voiceLabelEl.textContent = text;
    }
  }

  async fetchDocBlocks(rootID, fromBlockId) {
    const res = await this.fetchSyncPost("/api/block/getBlockDOM", { id: rootID });
    if (!res || res.code !== 0 || !res.data) {
      showMessage(this.i18n.loadFailed || "获取文档内容失败");
      return [];
    }
    const doc = new DOMParser().parseFromString(res.data.dom, "text/html");
    doc.querySelectorAll('span[data-type*="sup"]').forEach((span) => span.remove());
    doc.querySelectorAll('div[data-type="NodeCodeBlock"]').forEach((code) => code.remove());

    const allBlocks = [];
    let currentFound = !fromBlockId;
    Array.from(doc.body.children).forEach((block) => {
      if (!currentFound && block.getAttribute("data-node-id") === fromBlockId) {
        currentFound = true;
      }
      if (currentFound) {
        allBlocks.push(block);
      }
    });
    return allBlocks;
  }

  // 取「从指定块开始到文档末尾」的块（含该块本身），用于单块朗读时自动续读。
  // 返回 DOM 元素数组，交给 startBlocks 时会被包成 Block。
  // 若拿不到块 ID（即「不知道从哪个块开始」），则退回整篇文档，
  // 也就是从第一个块开始读 —— 不因为定位失败就什么都不读。
  async fetchBlocksFrom(rootID, blockEl) {
    try {
      const nodeId = blockEl && typeof blockEl.getAttribute === "function"
        ? blockEl.getAttribute("data-node-id") : null;
      if (!rootID) {
        return [];
      }
      if (!nodeId) {
        return await this.fetchDocBlocks(rootID, null);
      }
      const all = await this.fetchDocBlocks(rootID, nodeId);
      if (all.length) {
        return all;
      }
      // 该块不在文档块列表里（例如已被删除）：从第一个块开始
      logger.warn("[TTS]\t未定位到起始块，改为从第一个块开始");
      return await this.fetchDocBlocks(rootID, null);
    } catch (e) {
      logger.warn("[TTS]\t获取起始块失败", e);
      return [];
    }
  }

  async fetchSyncPost(url, data, returnType = "json") {
    const init = { method: "POST" };
    if (data) {
      init.body = data instanceof FormData ? data : JSON.stringify(data);
    }
    const token = getApiToken();
    if (token) {
      init.headers = { Authorization: "Token " + token };
    }
    try {
      const res = await fetch(url, init);
      return returnType === "json" ? await res.json() : await res.text();
    } catch (e) {
      console.error(e);
      return returnType === "json" ? { code: e.code || 1, msg: e.message || "", data: null } : "";
    }
  }

  setStatus(content) {
    this.status = content;
    this.updateStatus(content);
  }

  updateStatus(content) {
    if (this.statusIconTemp) {
      this.statusIconTemp.textContent = content;
    }
    if (this.mobileBarText) {
      this.mobileBarText.textContent = content;
    }
  }

  // 移动端悬浮控制条：移动端前端不挂载状态栏
  // 用 activeController 判定归属：被取代的旧朗读结束时不得把新朗读的悬浮条关掉，
  // 否则表现为「双击换块后悬浮窗有时不出现」。
  showControlBar(controller) {
    this.activeController = controller || this.controller || null;
    if (this.mobileBar) {
      this.mobileBar.style.display = "flex";
    }
  }

  hideControlBar(controller) {
    if (controller && this.activeController && controller !== this.activeController) {
      return;
    }
    this.activeController = null;
    if (this.mobileBar) {
      this.mobileBar.style.display = "none";
    }
  }

  scrollToCurrentBlock() {
    if (!this.controller || !this.controller.blocks) {
      return;
    }
    const index = Math.max(0, this.controller.playIndex - 1);
    const block = this.controller.blocks[index];
    if (!block || !block.el) {
      return;
    }
    const nodeId = block.el.getAttribute("data-node-id");
    const el2 = document.querySelector(`.protyle-wysiwyg [data-node-id="${nodeId}"]`);
    if (el2) {
      el2.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  addMenu(rect) {
    const menu = new Menu("ttsPluginTopBarMenu");

    // 播放中才是「暂停」，暂停/已停止/读完都是「继续」（点了会重新找起点）
    const isPlaying = !!(this.controller && !this.controller.stopped && !this.controller.isPaused
      && this.controller.players && this.controller.players.length);
    menu.addItem({
      icon: isPlaying ? "iconPause" : "iconPlay",
      label: isPlaying ? this.i18n.pause : this.i18n.resume,
      click: () => this.togglePause(),
    });

    menu.addItem({
      icon: "iconFocus",
      label: this.i18n.scrollToCurrent || "滚动到当前播放块",
      click: () => this.scrollToCurrentBlock(),
    });

    menu.addItem({
      icon: "iconClose",
      label: this.i18n.stop,
      click: () => this.stopReading(),
    });

    // 环境自检：移动端 / 鸿蒙无法连调试器时用来定位无声原因
    menu.addItem({
      icon: "iconInfo",
      label: this.i18n.diagnose || "环境自检",
      click: () => {
        showDiagnoseDialog(this);
      },
    });

    // 语音引擎。自动模式严格锁定所选声源（只用 Edge）；
    // HTTP / 系统语音各有内置音色，手动选择时会明确标注「可能不是所选声源」。
    const warn = this.i18n.engineVoiceWarning || "可能不是所选声源";
    const engineMenus = [
      [ENGINE.AUTO, this.i18n.engineAuto, ""],
      [ENGINE.EDGE_DIRECT, this.i18n.engineEdgeDirect, USE_NODE_NET ? "" : this.i18n.engineDesktopOnly],
      [ENGINE.EDGE_PROXY, this.i18n.engineEdgeProxy, ""],
      [ENGINE.HTTP, this.i18n.engineHttp, warn],
      [ENGINE.SYSTEM, this.i18n.engineSystem, warn],
    ].map(([value, label, tip]) => ({
      icon: value === this.engine ? "iconSelect" : "",
      label: tip ? `${label}（${tip}）` : label,
      click: () => {
        this.engine = value;
        this.tts.setEngine(value);
        this.saveStorage();
        showMessage(`${this.i18n.engine}: ${label}`);
      },
    }));

    menu.addItem({
      icon: "",
      label: `${this.i18n.engine}${this.tts.active ? " · " + this.tts.engineName(this.tts.active) : ""}`,
      type: "submenu",
      submenu: engineMenus,
    });

    // Edge 声源
    const voiceMenus = VOICE_LIST.map((v) => ({
      icon: v.value === this.currentMetadata ? "iconSelect" : "",
      label: v.label,
      click: () => this.setVoice(v.value),
    }));

    menu.addItem({
      icon: "",
      label: this.i18n.changeMetadata,
      type: "submenu",
      submenu: voiceMenus,
    });

    const playRateMenus = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 3, 5, 10].map((v) => ({
      icon: v === this.playbackRate ? "iconSelect" : "",
      label: String(v),
      click: () => {
        this.playbackRate = v;
        this.tts.rate = v;
        this.saveStorage();
        if (this.controller && this.controller.players && this.controller.players[0]) {
          this.controller.players[0].setRate(v);
        }
      },
    }));

    menu.addItem({
      icon: "",
      label: this.i18n.playbackRate,
      type: "submenu",
      submenu: playRateMenus,
    });

    menu.open({
      x: rect.right,
      y: rect.bottom,
      isLeft: true,
    });
  }

  // 播放/暂停按钮的统一状态。state: "playing" | "paused" | "idle"
  // 三种状态都让图标与提示文字保持一致（提示文字在手机上就是唯一的说明）。
  markPlayState(state) {
    const icon = state === "playing" ? "#iconPause" : (state === "paused" ? "#iconPlay" : "#iconRecord");
    const label = state === "playing" ? (this.i18n.pause || "暂停") : (this.i18n.resume || "继续");
    document.querySelectorAll('.tts-nav-btn[data-type="pause"]').forEach((btn) => {
      btn.setAttribute("title", label);
      const use = btn.querySelector("use");
      if (use) {
        use.setAttribute("xlink:href", icon);
      }
    });
  }

  // 记录「上次朗读的块」。停止后依然保留，所以停止后再点「继续」能接着读。
  rememberBlock(block) {
    if (!block || !block.el || typeof block.el.getAttribute !== "function") {
      return;
    }
    const id = block.el.getAttribute("data-node-id");
    if (!id) {
      return;
    }
    this.lastNodeId = id;
    this.lastRootId = rootIdOf(block.el) || this.lastRootId || null;
  }

  // 播放/暂停按钮，兼作「继续」：
  //   播放中 → 暂停；暂停中 → 继续；已停止或没有在进行的朗读 → 重新找起点开始读
  togglePause() {
    // 恢复播放同样属于用户手势，借此机会再次解锁音频
    unlockAudio();
    const c = this.controller;
    if (c && !c.stopped && Array.isArray(c.players) && c.players.length) {
      const paused = c.isPaused;
      if (paused) {
        c.resume();
      } else {
        c.pause();
      }
      this.markPlayState(paused ? "playing" : "paused");
      return;
    }
    // 没有可继续的朗读（已停止 / 从未开始 / 已读完）：当作「继续」处理
    this.resumeReading();
  }

  // 「继续」：按优先级决定从哪读 ——
  //   ① 当前选中的块  ② 上一次朗读的块  ③ 文档第一个块
  // （①②都没有时自然落到③，也就是「不知道从哪个块开始就从第一个块开始」）
  async resumeReading() {
    unlockAudio();

    // ① 选中的块（与块菜单一致：从该块读到文档末尾）
    let startEl = null;
    let rootID = null;
    const selected = document.querySelectorAll(".protyle-wysiwyg--select");
    if (selected.length) {
      startEl = selected[0];
      rootID = rootIdOf(startEl);
    }

    // ② 上次朗读的块
    if (!startEl && this.lastNodeId) {
      startEl = document.querySelector(`.protyle-wysiwyg [data-node-id="${this.lastNodeId}"]`);
      if (startEl) {
        rootID = rootIdOf(startEl) || rootID;
      }
    }

    // 依次尝试：已定位的文档 → 当前打开的文档 → 上次朗读所在的文档
    const tried = [];
    const push = (v) => {
      if (v && tried.indexOf(v) === -1) {
        tried.push(v);
      }
    };
    push(rootID);
    push(currentDocRootId());
    push(this.lastRootId);

    for (const id of tried) {
      // 有起点块：从该块开始；没有起点块：从第一个块开始读整篇
      let blocks = startEl ? await this.fetchBlocksFrom(id, startEl) : await this.fetchDocBlocks(id, null);
      if (!blocks.length && startEl) {
        // 起点块不属于该文档（例如正在看另一篇）→ 该文档从第一个块开始
        blocks = await this.fetchDocBlocks(id, null);
      }
      if (blocks.length) {
        this.startBlocks(blocks);
        return;
      }
    }
    showMessage(this.i18n.loadFailed || "获取文档内容失败");
  }

  addStatus() {
    // 桌面端：底部状态栏（移动端前端不会挂载 statusBarIcons）
    // 移动端悬浮条是唯一控件，必须与状态栏互不影响：
    // 状态栏构造/挂载失败时也要保证悬浮条仍然可用。
    try {
      this.createStatusBar();
    } catch (e) {
      logger.warn("[TTS]\t状态栏创建失败（不影响悬浮条）", e);
    }
    if (isMobileUI()) {
      try {
        this.createMobileBar();
      } catch (e) {
        logger.error("[TTS]\t移动端悬浮条创建失败", e);
      }
    }
  }

  createStatusBar() {
    const template = document.createElement("template");
    template.innerHTML = `<div class="toolbar__item">
      <span class="tts-nav-btn" style="margin: 0; padding: 0; font-size: unset;" data-type="pause">
        <svg><use xlink:href="#iconRecord"></use></svg>
      </span>
      <span id="tts-content">${this.i18n.title}</span>
      <span class="tts-voice-chip" data-type="voice" title="${this.i18n.voiceHint || this.i18n.changeMetadata}">
        ${voiceShortOf(this.currentMetadata)}
      </span>
    </div>`;
    const element = template.content.firstElementChild;
    if (!element) {
      throw new Error("状态栏模板解析失败");
    }
    element.querySelector('[data-type="pause"]').addEventListener("click", () => this.togglePause());
    element.querySelector("#tts-content").addEventListener("click", () => this.scrollToCurrentBlock());

    // 状态栏上的声源：点击直接弹出完整列表（与悬浮窗行为一致）
    const chip = element.querySelector(".tts-voice-chip");
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.openVoiceMenu(chip);
    });
    chip.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.openVoiceMenu(chip);
    });

    this.addStatusBar({ element });
    this.statusIconTemp = element.querySelector("#tts-content");
    this.voiceLabelEl = chip;
  }

  createMobileBar() {
    const bar = document.createElement("div");
    bar.className = "tts-mobile-bar";
    bar.style.display = "none";
    bar.innerHTML = `
      <span class="tts-nav-btn" data-type="pause" title="${this.i18n.resume}">
        <svg><use xlink:href="#iconRecord"></use></svg>
      </span>
      <span class="tts-mobile-content">${this.i18n.title}</span>
      <span class="tts-voice-chip" data-type="voice" title="${this.i18n.voiceHint || this.i18n.changeMetadata}">
        ${voiceShortOf(this.currentMetadata)}
      </span>
      <span class="tts-nav-btn" data-type="stop" title="${this.i18n.stop}">
        <svg><use xlink:href="#iconClose"></use></svg>
      </span>`;
    document.body.appendChild(bar);

    this.mobileBar = bar;
    this.mobileBarText = bar.querySelector(".tts-mobile-content");
    this.voiceLabelEl = bar.querySelector(".tts-voice-chip");
    bar.querySelector('[data-type="pause"]').addEventListener("click", () => this.togglePause());
    bar.querySelector('[data-type="stop"]').addEventListener("click", () => this.stopReading());
    this.mobileBarText.addEventListener("click", () => this.scrollToCurrentBlock());

    // 人声切换：点击直接弹出完整声源列表供选择
    const chip = this.voiceLabelEl;
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      this.openVoiceMenu(chip);
    });
    // 桌面端/外接鼠标仍可用右键
    chip.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.openVoiceMenu(chip);
    });
  }
};
