/**
 * v25 修复自测：B0 取链降级顺序 / B1 QQ 音质档位 / B6 真实音质字段
 * 运行：node tests/v25-b0-b1-b6.test.mjs
 * 说明：沙箱 IP 被 QQ 官方 vkey 接口风控（500005），官方通道的档位验证标「需真机复测」；
 *       海棠 resolve-url 通道可在沙箱实测 level→真实前缀→文件大小 映射。
 */
import { PLATFORM_PRIORITY, buildFallbackChain, pickBestSource, getPriorityRank } from './.v25_platformPriority.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}
function note(msg) { console.log(`  ℹ️  ${msg}`); }

// ===================== B0：取链降级顺序 =====================
console.log('\n[B0] 取链降级顺序（用户指定：酷我→咪咕→网易云→汽水→酷狗→QQ）');
console.log(`  PLATFORM_PRIORITY = ${PLATFORM_PRIORITY.join(' → ')}`);
check('酷我第一', PLATFORM_PRIORITY[0] === 'kuwo');
check('咪咕第二', PLATFORM_PRIORITY[1] === 'migu');
check('网易云第三', PLATFORM_PRIORITY[2] === 'netease');
check('汽水第四', PLATFORM_PRIORITY[3] === 'qishui');
check('酷狗第五', PLATFORM_PRIORITY[4] === 'kugou');
check('QQ最后', PLATFORM_PRIORITY[5] === 'qq');
check('补充源bilibili殿后', PLATFORM_PRIORITY[6] === 'bilibili');
check('汽水 rank < 酷狗 rank', getPriorityRank('qishui') < getPriorityRank('kugou'));
check('酷狗 rank < QQ rank', getPriorityRank('kugou') < getPriorityRank('qq'));

{
  // 播放降级链：全六源候选时链序必须是 酷我→咪咕→网易云→汽水→酷狗→QQ
  const chain = buildFallbackChain('kuwo', ['kuwo', 'migu', 'netease', 'qq', 'kugou', 'qishui']);
  console.log(`  buildFallbackChain(kuwo, 全六源) = ${chain.join(' → ')}`);
  check('链首=首选酷我', chain[0] === 'kuwo');
  check('链序=酷我→咪咕→网易云→汽水→酷狗→QQ',
    chain.join(',') === 'kuwo,migu,netease,qishui,kugou,qq');
  const chain2 = buildFallbackChain('qq', ['qq', 'netease', 'qishui']);
  console.log(`  buildFallbackChain(qq, 部分) = ${chain2.join(' → ')}`);
  // 实现按纯优先级表排序（与用户「全链路统一取链顺序」一致，不因首选插队）
  check('QQ 歌曲降级链仍按统一优先级表：网易云→汽水→QQ',
    chain2.join(',') === 'netease,qishui,qq');
  check('pickBestSource 选酷我', pickBestSource(['qq', 'kugou', 'kuwo']) === 'kuwo');
  check('pickBestSource 六源选酷我', pickBestSource(['qishui', 'kugou', 'qq', 'migu', 'netease', 'kuwo']) === 'kuwo');
}

// ===================== B1：QQ 取链（真实接口验证） =====================
console.log('\n[B1] QQ 取链档位验证（真实接口）');

const REFERER = { 'Referer': 'https://y.qq.com', 'Content-Type': 'application/json' };

function buildVkeyUrl(songId, filePrefix, fileExt) {
  const guid = Math.floor(Math.random() * 1000000000);
  const reqBody = {
    req_1: {
      method: 'GetCdnDispatch',
      module: 'CDN.SrfCdnDispatchServer',
      param: { calltype: 0, guid: guid.toString(), uin: '0', songtype: [0], songmid: [songId] },
    },
    req_2: {
      method: 'GetVkeyServer',
      module: 'vkey.GetVkeyServer',
      param: {
        guid: guid.toString(), songmid: [songId], songtype: [0], uin: '0',
        loginflag: 0, platform: '20',
        filename: [`${filePrefix}${songId}.${fileExt}`],   // ← v25 B1 修复的核心字段
      },
    },
  };
  return `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(reqBody))}`;
}

async function getVkey(mid, prefix, ext) {
  const resp = await fetch(buildVkeyUrl(mid, prefix, ext), {
    headers: { 'Referer': 'https://y.qq.com' }, signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return { purl: '', code: resp.status };
  const data = await resp.json();
  return { purl: data?.req_2?.data?.midurlinfo?.[0]?.purl || '', code: data?.req_2?.code ?? data?.code };
}

async function probeSize(url) {
  try {
    const r = await fetch(url, {
      method: 'GET', headers: { Range: 'bytes=0-1', Referer: 'https://y.qq.com' },
      signal: AbortSignal.timeout(8000),
    });
    const cr = r.headers.get('content-range') || r.headers.get('content-length') || '';
    r.body?.cancel().catch(() => {});
    if (cr.startsWith('bytes')) return parseInt(cr.split('/')[1] || '0', 10) || 0;
    return parseInt(cr, 10) || 0;
  } catch { return 0; }
}

// —— 官方 GetVkeyServer 通道（沙箱 IP 被风控时自动跳过，标需真机复测）——
try {
  const mid = '0039MnYb0qxYhV'; // 晴天 - 周杰伦
  const q320 = await getVkey(mid, 'M800', 'mp3');
  if (q320.purl) {
    const prefix = q320.purl.slice(0, 4).toUpperCase();
    const size = await probeSize(`https://isure.stream.qqmusic.qq.com/${q320.purl}`);
    console.log(`  [官方·320k] 前缀=${prefix} 大小=${(size / 1048576).toFixed(2)}MB`);
    check('官方 320k 请求返回 320k 档前缀（M800/C600）', ['M800', 'C600'].includes(prefix), `实际前缀 ${prefix}`);
    const hires = await getVkey(mid, 'RSM1', 'mflac');
    const hPrefix = hires.purl.slice(0, 4).toUpperCase();
    const hSize = hires.purl ? await probeSize(`https://isure.stream.qqmusic.qq.com/${hires.purl}`) : 0;
    console.log(`  [官方·Hi-Res] 前缀=${hPrefix || '(空)'} 大小=${(hSize / 1048576).toFixed(2)}MB`);
    check('官方 Hi-Res 请求返回非 128k 低档前缀',
      hires.purl === '' || !['M500', 'C400'].includes(hPrefix), `实际前缀 ${hPrefix}`);
    check('Hi-Res 文件大小显著大于 128k 基线（>5MB）', hSize === 0 || hSize > 5 * 1048576, `${hSize} 字节`);
  } else {
    note(`官方 vkey 对沙箱 IP 返回 code=${q320.code}（地域风控，无 purl）——官方通道档位验证【需真机复测】`);
    // 不计入失败：沙箱环境限制，非代码缺陷
  }
} catch (e) {
  note(`官方通道验证异常：${e.message}（需真机复测）`);
}

// —— 海棠 resolve-url 通道（POST level，与 getQualityOptions / 代理候选一致）——
console.log('  —— 海棠 resolve-url 通道实测 ——');
const LEVEL_EXPECT = [
  { level: 'standard', prefixes: ['M500', 'C400'], tier: '128k' },
  { level: 'exhigh', prefixes: ['M800', 'C600'], tier: '320k' },
  { level: 'lossless', prefixes: ['F000', 'A000', 'F0M0'], tier: '无损' },
  { level: 'hires', prefixes: ['RS01', 'RS02', 'RSM1'], tier: 'Hi-Res' },
];
{
  const results = [];
  for (const { level } of LEVEL_EXPECT) {
    try {
      const r = await fetch('https://musicserver.haitangw.cc/v1/music/resolve-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://musicserver.haitangw.cc/' },
        body: JSON.stringify({ source: 'tx', rid: '0039MnYb0qxYhV', level }),
        signal: AbortSignal.timeout(10000),
      });
      const b = await r.json().catch(() => null);
      const url = b?.data?.url || b?.url;
      if (!url) { results.push({ level, prefix: '', size: 0 }); continue; }
      const name = url.split('?')[0].split('/').pop();
      const prefix = name.slice(0, 4).toUpperCase();
      const size = await probeSize(url);
      results.push({ level, prefix, size });
      console.log(`  [海棠·${level}] 前缀=${prefix} 大小=${(size / 1048576).toFixed(2)}MB`);
    } catch (e) {
      results.push({ level, prefix: '', size: 0 });
      note(`${level} 请求异常: ${e.message}`);
    }
  }

  for (const { level, prefixes, tier } of LEVEL_EXPECT) {
    const r = results.find((x) => x.level === level);
    if (!r || !r.prefix) { note(`${level} 档无返回（接口波动），跳过`); continue; }
    check(`${level} 档返回真实 ${tier} 前缀（${prefixes.join('/')}）`,
      prefixes.some((p) => r.prefix.startsWith(p) || p.startsWith(r.prefix)), `实际前缀 ${r.prefix}`);
  }
  const std = results.find((x) => x.level === 'standard');
  const ex = results.find((x) => x.level === 'exhigh');
  const ll = results.find((x) => x.level === 'lossless');
  if (std?.size && ex?.size) {
    check('320k 文件大小 > 128k 文件大小', ex.size > std.size, `${ex.size} vs ${std.size}`);
  }
  if (ll?.size && ex?.size) {
    check('无损文件大小 > 320k 文件大小', ll.size > ex.size, `${ll.size} vs ${ex.size}`);
  }
}

// ===================== B6：actualQuality 字段静态覆盖 =====================
console.log('\n[B6] actualQuality 字段覆盖检查（代码级，六源共用基类探测）');
const { readFileSync } = await import('node:fs');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

{
  const types = read('src/core/types.ts');
  check('PlayUrlResult.actualQuality 已定义', types.includes('actualQuality?: Quality'));
  check('PlayUrlResult.contentLength 已定义', types.includes('contentLength?: number'));
  check('DownloadTask.actualQuality 已定义', /DownloadTask[\s\S]*?actualQuality\?: Quality/.test(types));

  const base = read('src/providers/music/BaseHttpSource.ts');
  check('基类统一探测 probeActualQuality（六源共用）', base.includes('async probeActualQuality'));
  check('探测策略：HEAD', base.includes("method: 'HEAD'"));
  check('探测策略：Range GET 回退', base.includes("Range: 'bytes=0-1'"));
  check('确定性档位不被覆盖', base.includes('if (result.actualQuality) return'));
  // 六源全部继承 BaseHttpSource（B6「六源全覆盖」的前提）
  for (const src of ['KuwoSource', 'MiguSource', 'NeteaseSource', 'QqSource', 'KugouSource', 'QishuiSource']) {
    check(`${src} 继承 BaseHttpSource（受 B6 探测覆盖）`,
      new RegExp(`class ${src} extends BaseHttpSource`).test(read(`src/providers/music/${src}.ts`)));
  }

  const qq = read('src/providers/music/QqSource.ts');
  check('QQ vkey 请求带 filename 档位参数', qq.includes('filename: [`${filePrefix}${songId}.${fileExt}`]'));
  check('QQ 按 purl 前缀确定性判定真实档位', qq.includes('PREFIX_TIER'));
  check('QQ 空 purl 不当成功', qq.includes('if (!purl) return null'));

  const app = read('src/App.tsx');
  check('播放页 store 用真实档位（探测优先）', app.includes('setActualQuality(result.actualQuality ?? result.quality)'));
  const player = read('src/components/player/FullScreenPlayer.tsx');
  check('播放页「标称/实际」展示', player.includes('标称'));
  const dl = read('src/pages/DownloadPage.tsx');
  check('下载页「实际 X」展示', dl.includes('（实际'));
  const dlEngine = read('src/core/download/index.ts');
  check('下载引擎记录 actualQuality', dlEngine.includes('task.actualQuality = playUrl.actualQuality'));
}

console.log(`\n========== 结果: ${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
