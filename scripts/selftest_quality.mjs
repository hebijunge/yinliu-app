// 音质/大小按源实测（复刻 getQualityOptions 逻辑，v19.1）
const UA = 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36';

async function j(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// —— 酷我 ——（musicpay MINFO/N_MINFO：分号分段逗号kv，bitrate 归档、size(Mb)→字节）
function parseMinfo(minfo) {
  const sizes = {};
  for (const seg of (minfo || '').split(';')) {
    const kv = {};
    for (const part of seg.split(',')) {
      const i = part.indexOf(':');
      if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const br = parseInt((kv.bitrate || '').replace(/[^\d]/g, ''), 10) || 0;
    const szMb = parseFloat((kv.size || '').replace(/[^\d.]/g, '')) || 0;
    if (br <= 0 || szMb <= 0) continue;
    let tier = br >= 10000 ? 'hires' : br >= 900 ? 'lossless' : br >= 320 ? '320k' : br >= 192 ? '192k' : '128k';
    if (!sizes[tier]) sizes[tier] = Math.round(szMb * 1048576);
  }
  return sizes;
}
async function kuwo(rid) {
  const d = await j(`https://musicpay.kuwo.cn/music.pay?src=kwplayer_ar_11.3.0.0_40.apk&op=query&action=play&ids=${rid}`);
  const m = d?.songs?.[0]?.N_MINFO || d?.songs?.[0]?.MINFO || '';
  return parseMinfo(m);
}

// —— 网易云 ——（v3/song/detail：hr/sq/h/m/l 各带 br+size）
function brToTier(br) {
  if (!br) return null;
  if (br >= 1000000) return 'hires';
  if (br >= 900000) return 'lossless';
  if (br >= 320000) return '320k';
  if (br >= 192000) return '192k';
  return '128k';
}
async function netease(id) {
  const d = await j(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(`[{"id":${id}}]`)}`, { headers: { Referer: 'https://music.163.com/' } });
  const s = d?.songs?.[0];
  if (!s) return {};
  const sizes = {};
  for (const m of [s.hr, s.sq, s.h, s.m, s.l]) {
    const sz = parseInt(m?.size || 0, 10) || 0;
    if (!sz) continue;
    const t = brToTier(parseInt(m?.br || 0, 10));
    if (t && !sizes[t]) sizes[t] = sz;
  }
  return sizes;
}

// —— QQ ——（海棠 resolve-url 只回 data.data.url 无 size：直链前缀判档 + Range 探测真实大小）
function qqUrlTier(url) {
  const m = /\/([A-Z]?\d{4}|RS01|AIM0|Q0M1|Q0M0)[A-Za-z0-9]*\.(mp3|flac|m4a|ape|ogg|mgg|mflac)/i.exec(url || '');
  if (!m) return null;
  const p = m[1].toUpperCase();
  if (/^(RS01|AIM0)/.test(p)) return 'hires';
  if (/^(F000|A000)/.test(p)) return 'lossless';
  if (/^M800/.test(p)) return '320k';
  if (/^M500/.test(p)) return '128k';
  return null;
}
async function qq(mid) {
  const levels = [['standard', '128k'], ['exhigh', '320k'], ['lossless', 'lossless'], ['hires', 'hires']];
  const settled = await Promise.allSettled(levels.map(async ([level, hintTier]) => {
    const r = await fetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://musicserver.haitangw.cc/' },
      body: JSON.stringify({ source: 'tx', rid: mid, level }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const url = d?.data?.url || d?.url;
    if (!url) return null;
    const tier = qqUrlTier(url) || hintTier;
    let size = 0;
    try {
      const pr = await fetch(url, { headers: { Range: 'bytes=0-1', Referer: 'https://y.qq.com' }, signal: AbortSignal.timeout(15000) });
      const valid = pr.status === 206 || pr.status === 200;
      const cr = pr.headers.get('content-range');
      if (valid && cr && cr.includes('/')) size = parseInt(cr.split('/')[1], 10) || 0;
      else if (valid) size = parseInt(pr.headers.get('content-length') || 0, 10) || 0;
    } catch {}
    if (size <= 65536) return null; // 错误体（如 404 content-length=64）不采信
    return [tier, size, (url.split('/').pop() || '').slice(0, 36)];
  }));
  const sizes = {};
  const urls = {};
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value) continue;
    const [t, sz, u] = s.value;
    if (!sizes[t]) { sizes[t] = sz; urls[t] = u; }
  }
  return { sizes, urls };
}

// —— 咪咕 ——（resourceinfo.do resourceType=2：newRateFormats/rateFormats→androidSize||size，audioFormats→isize）
async function migu(contentId) {
  const d = await j(`https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceId=${contentId}&resourceType=2`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://y.migu.cn/' },
  });
  const res = d?.resource?.[0];
  if (!res) return {};
  const sizes = {};
  const put = (ft, bytes) => {
    ft = (ft || '').toString();
    let tier = /ZQ24|ZQ(?!2)|hires/i.test(ft) ? 'hires' : ft === 'SQ' ? 'lossless' : ft === 'HQ' ? '320k' : ft === 'PQ' ? '128k' : null;
    if (tier && bytes > 0 && !sizes[tier]) sizes[tier] = bytes;
  };
  for (const f of res.newRateFormats || []) put(f?.formatType, parseInt(f?.androidSize || f?.size || 0, 10) || 0);
  for (const f of res.rateFormats || []) put(f?.formatType, parseInt(f?.androidSize || f?.size || 0, 10) || 0);
  for (const f of res.audioFormats || []) put(f?.formatType, parseInt(f?.isize || 0, 10) || 0);
  return sizes;
}

// —— 酷狗 ——（song/info 对单 hash 只回该档 filesize：按搜索结果的 hash/320hash/sqhash 分别查询）
async function kugou() {
  const s = await j(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent('晴天 周杰伦')}&page=1&pagesize=3`);
  const first = s?.data?.info?.[0];
  if (!first) return {};
  const tierHashes = [
    ['128k', first.hash],
    ['320k', first['320hash'] || ''],
    ['lossless', first.sqhash || ''],
  ].filter(([, h]) => h);
  const settled = await Promise.allSettled(tierHashes.map(async ([tier, hash]) => {
    const d = await j(`http://mobilecdn.kugou.com/api/v3/song/info?format=json&hash=${encodeURIComponent(hash)}`);
    const sz = parseInt(d?.data?.filesize || 0, 10) || 0;
    return sz > 0 ? [tier, sz] : null;
  }));
  const sizes = {};
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value) continue;
    const [t, sz] = s.value;
    if (!sizes[t]) sizes[t] = sz;
  }
  return sizes;
}

const fmt = (s) => Object.entries(s).map(([t, b]) => `${t}=${(b / 1048576).toFixed(1)}MB`).join(' ') || '(空)';

const results = {};
const qqExtra = {};
await Promise.allSettled([
  kuwo('228908').then((s) => { results['酷我'] = s; }),
  netease('186016').then((s) => { results['网易云'] = s; }),
  qq('0039MnYb0qxYhV').then((r) => { results['QQ'] = r.sizes; qqExtra.urls = r.urls; }),
  migu('600902000006889366').then((s) => { results['咪咕'] = s; }),
  kugou().then((s) => { results['酷狗'] = s; }),
]);

for (const [k, v] of Object.entries(results)) {
  console.log(`${k}: ${fmt(v)}`);
}
if (Object.keys(qqExtra.urls || {}).length) {
  for (const [t, u] of Object.entries(qqExtra.urls)) console.log(`QQ直链[${t}]: ${u}`);
}
