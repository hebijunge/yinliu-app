/**
 * @capacitor/core 测试替身：默认模拟 Web 平台。
 * 通过 globalThis.__yinliuCacheTest 共享状态（见 capacitor-filesystem.mjs 说明）。
 */
function state() {
  return (globalThis.__yinliuCacheTest ??= { fs: {}, calls: [] });
}

export const Capacitor = {
  get platform() {
    return state().platform ?? 'web';
  },
  isNativePlatform: () => state().isNative ?? false,
  convertFileSrc: (filePath) => {
    const custom = state().convertFileSrc;
    if (typeof custom === 'function') return custom(filePath);
    return 'https://localhost/_capacitor_file_/' + String(filePath).replace(/^\//, '');
  },
};

/** platformFetch 测试所需：CapacitorHttp 替身（测试仅覆盖 web 路径，不应被调用） */
export const CapacitorHttp = {
  request: async () => {
    throw new Error('CapacitorHttp.request 不应在 web 测试路径被调用');
  },
};
