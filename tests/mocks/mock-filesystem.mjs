/**
 * @capacitor/filesystem 内存文件系统替身（streamCacheCleanup 专用）。
 * 与 tests/stubs/capacitor-filesystem.mjs 的差别：自带真实的内存 Map 存储，
 * 并暴露 __seed / __has / __reset 供测试直接播种与断言磁盘状态。
 * 通过 globalThis.__yinliuCacheTest 共享平台开关（isNative）等状态。
 *
 * encoding 语义对齐真实 Capacitor Filesystem：
 * - readFile 带 encoding: UTF8 → 返回 { data: string }（UTF-8 文本）
 * - readFile 不带 encoding    → 返回 { data: base64 }
 * - writeFile 带 encoding: UTF8 → data 为文本；否则 data 为 base64
 */
const store = (globalThis.__yinliuMockFsStore ??= new Map());

function enc(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function dec(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

export const Directory = { Data: 'DATA', Documents: 'DOCUMENTS' };
export const Encoding = { UTF8: 'UTF8' };

export const Filesystem = {
  async mkdir() {
    // 内存 FS 无需真实建目录
  },
  async readFile({ path, encoding }) {
    if (!store.has(path)) {
      throw Object.assign(new Error(`File does not exist: ${path}`), { code: 'ENOENT' });
    }
    const bytes = store.get(path);
    if (encoding === Encoding.UTF8) {
      return { data: utf8Decode(bytes) };
    }
    return { data: enc(bytes) };
  },
  async writeFile({ path, data, encoding }) {
    const bytes = encoding === Encoding.UTF8 ? utf8Encode(data) : dec(data);
    store.set(path, bytes);
    return { uri: 'file://' + path };
  },
  async appendFile({ path, data }) {
    const prev = store.get(path) ?? new Uint8Array(0);
    const chunk = dec(data);
    const next = new Uint8Array(prev.length + chunk.length);
    next.set(prev, 0);
    next.set(chunk, prev.length);
    store.set(path, next);
    return { uri: 'file://' + path };
  },
  async deleteFile({ path }) {
    store.delete(path);
  },
  async stat({ path }) {
    if (!store.has(path)) {
      throw Object.assign(new Error(`File does not exist: ${path}`), { code: 'ENOENT' });
    }
    return { size: store.get(path).length, type: 'file', uri: 'file://' + path };
  },
  async readdir({ path }) {
    const prefix = path.endsWith('/') ? path : path + '/';
    const files = [];
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) files.push({ name: rest, type: 'file' });
      }
    }
    return { files };
  },
  async getUri({ path }) {
    return { uri: 'file://' + path };
  },
};

/** 测试辅助：直接播种一个"磁盘文件" */
export function __seed(path, bytes) {
  store.set(path, bytes instanceof Uint8Array ? bytes : utf8Encode(String(bytes)));
}

/** 测试辅助：断言磁盘上是否存在某文件 */
export function __has(path) {
  return store.has(path);
}

/** 测试辅助：清空整个内存 FS */
export function __reset() {
  store.clear();
}
