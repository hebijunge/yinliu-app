/**
 * @capacitor/filesystem 测试替身。
 * 通过 globalThis.__yinliuCacheTest 共享状态——esbuild --bundle 会把本模块
 * 内联进被测产物，测试侧必须经全局对象与 bundle 内副本通信。
 * 各用例按需覆写 state.fs.<method>；调用记录在 state.calls。
 */
function state() {
  return (globalThis.__yinliuCacheTest ??= { fs: {}, calls: [] });
}

function mkDelegating(name) {
  return async (...args) => {
    state().calls.push([name, ...args]);
    const fn = state().fs[name];
    if (typeof fn !== 'function') throw new Error(`[stub] ${name} not configured`);
    return fn(...args);
  };
}

export const Directory = { Data: 'DATA', Documents: 'DOCUMENTS' };
export const Encoding = { UTF8: 'UTF8' };

export const Filesystem = {
  mkdir: mkDelegating('mkdir'),
  readFile: mkDelegating('readFile'),
  writeFile: mkDelegating('writeFile'),
  deleteFile: mkDelegating('deleteFile'),
  stat: mkDelegating('stat'),
  readdir: mkDelegating('readdir'),
  getUri: mkDelegating('getUri'),
  appendFile: mkDelegating('appendFile'),
};
