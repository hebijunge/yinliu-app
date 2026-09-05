/**
 * v29 B0/B1/B6 · 取链优先级 + QQ 音质修复 + 音质诚实性 单元测试
 * 运行：node tests/v29-priority-quality.test.mjs
 *
 * 覆盖范围：
 * B0｜PLATFORM_PRIORITY 降级顺序修正（酷我→咪咕→网易云→汽水→酷狗→QQ）+ 降级链排序语义
 * B1｜QQ GetVkeyServer filename 档位参数 + 海棠 level 映射
 * B6｜actualQuality 推算逻辑（classifyActualQuality / bitrateToQuality）+ 关键接线点存在性
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}

// ============ B0：取链优先级 ============

/** 从 platformPriority.ts 源码提取数组字面量（TS 常量表，无依赖可安全提取） */
function extractArrayLiteral(source, constName) {
  const m = source.match(new RegExp(`export const ${constName} = \\[([^\\]]+)\\]`));
  assert.ok(m, `${constName} 数组未找到`);
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
}

// ============ B1：QQ filename / level（与 src/providers/music/QqSource.ts 保持一致的纯函数副本） ============

function buildQqFilename(format, songId) {
  const dotIdx = format.indexOf('.');
  const prefix = dotIdx === -1 ? format : format.slice(0, dotIdx);
  const ext = dotIdx === -1 ? 'mp3' : format.slice(dotIdx + 1);
  return `${prefix}${songId}.${ext}`;
}

const QQ_RANK = {
  low: 1, standard: 2, higher: 3, high: 4, lossless: 5,
  hires: 6, sky: 7, jyeffect: 8, hifi: 9, zhizhen: 10, dolby: 11, master: 12,
};
function qqLevelForQuality(quality) {
  const rank = QQ_RANK[quality] || 2;
  if (rank >= 6) return 'hires';
  if (rank >= 5) return 'lossless';
  if (rank >= 3) return 'exhigh';
  return 'standard';
}

// ============ B6：音质诚实性（与 src/shared/utils/qualityProbe.ts 保持一致的纯函数副本） ============

const QUALITY_RANK = QQ_RANK;
function bitrateToQuality(kbps) {
  if (kbps >= 1400) return 'hires';
  if (kbps >= 850) return 'lossless';
  if (kbps >= 250) return 'high';
  if (kbps >= 160) return 'higher';
  if (kbps >= 96) return 'standard';
  return 'low';
}
function classifyActualQuality(sizeBytes, durationSec) {
  const out = {};
  if (!sizeBytes || sizeBytes <= 0) return out;
  out.sizeBytes = sizeBytes;
  if (!durationSec || durationSec <= 0) return out;
  const kbps = Math.round((sizeBytes * 8) / (durationSec * 1000));
  out.actualBitrate = kbps;
  out.actualQuality = bitrateToQuality(kbps);
  return out;
}

/** buildFallbackChain 副本（与 src/core/platformPriority.ts 同语义，按提取到的优先级表排序） */
function buildFallbackChain(priority, primarySourceId, availableSourceIds) {
  if (primarySourceId === 'local') return [];
  const candidates = new Set();
  if (primarySourceId && primarySourceId !== 'local') candidates.add(primarySourceId);
  for (const id of availableSourceIds) {
    if (id && id !== 'local') candidates.add(id);
  }
  for (const id of [...candidates]) {
    if (!priority.includes(id)) candidates.delete(id);
  }
  return [...candidates].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
}

// ============ 测试 ============

const prioritySource = read('src/core/platformPriority.ts');
const priority = extractArrayLiteral(prioritySource, 'PLATFORM_PRIORITY');

console.log('\nB0 · 取链降级顺序');

await test('PLATFORM_PRIORITY 顺序 = 酷我→咪咕→网易云→汽水→酷狗→QQ（+哔哩哔哩补充源）', () => {
  assert.deepEqual(priority, ['kuwo', 'migu', 'netease', 'qishui', 'kugou', 'qq', 'bilibili']);
});

await test('汽水排在 QQ 之前（旧顺序 QQ→酷狗→汽水 已废弃）', () => {
  assert.ok(priority.indexOf('qishui') < priority.indexOf('kugou'), '汽水应先于酷狗');
  assert.ok(priority.indexOf('kugou') < priority.indexOf('qq'), '酷狗应先于QQ');
});

await test('DISPLAY_PRIORITY（展示排序）不受本次修正影响', () => {
  const display = extractArrayLiteral(prioritySource, 'DISPLAY_PRIORITY');
  assert.deepEqual(display, ['qishui', 'kuwo', 'migu', 'netease', 'qq', 'kugou', 'bilibili']);
});

await test('降级链按新顺序排序：QQ 歌曲在 QQ 不可用时先降汽水/酷狗，再回 QQ 之前的源', () => {
  const chain = buildFallbackChain(priority, 'kuwo', ['kuwo', 'qq', 'kugou', 'qishui', 'netease', 'migu']);
  assert.deepEqual(chain, ['kuwo', 'migu', 'netease', 'qishui', 'kugou', 'qq']);
});

await test('降级链：全部候选按优先级表排序（不因首选源而打乱，全链路统一口径）', () => {
  // 原实现语义：候选按 PLATFORM_PRIORITY 升序全排序；首选源（如来自 QQ 歌单导入的 qq）
  // 若在表中靠后，则排在 kuwo/migu 等高优先级源之后——与用户「全链路按优先级统一」口径一致
  const chain = buildFallbackChain(priority, 'qq', ['kuwo', 'qq', 'migu']);
  assert.deepEqual(chain, ['kuwo', 'migu', 'qq']);
});

await test('降级链：本地音乐与未知平台被排除', () => {
  assert.deepEqual(buildFallbackChain(priority, 'local', ['kuwo']), []);
  assert.deepEqual(buildFallbackChain(priority, 'kuwo', ['kuwo', 'unknown_src']), ['kuwo']);
});

console.log('\nB1 · QQ 音质档位修复');

await test('buildQqFilename：Hi-Res 档 → RSM1{mid}.mflac', () => {
  assert.equal(buildQqFilename('RSM1.mflac', '003aAYrm3GE0Xg'), 'RSM1003aAYrm3GE0Xg.mflac');
});

await test('buildQqFilename：320k 档 → M800{mid}.mp3', () => {
  assert.equal(buildQqFilename('M800.mp3', 'abc'), 'M800abc.mp3');
});

await test('buildQqFilename：至臻母带档 → AIM0{mid}.mflac', () => {
  assert.equal(buildQqFilename('AIM0.mflac', 'xyz'), 'AIM0xyz.mflac');
});

await test('QQ 官方取链请求已带 filename 档位参数（B1 根因修复落地）', () => {
  const src = read('src/providers/music/QqSource.ts');
  assert.ok(src.includes('filename: [buildQqFilename(format, songId)]'), 'GetVkeyServer 缺 filename 参数');
  assert.ok(src.includes('export function buildQqFilename'), 'buildQqFilename 未导出');
});

await test('qqLevelForQuality：Hi-Res及以上→hires，无损→lossless，320k/192k→exhigh，128k以下→standard', () => {
  assert.equal(qqLevelForQuality('hires'), 'hires');
  assert.equal(qqLevelForQuality('master'), 'hires');
  assert.equal(qqLevelForQuality('lossless'), 'lossless');
  assert.equal(qqLevelForQuality('high'), 'exhigh');
  assert.equal(qqLevelForQuality('higher'), 'exhigh');
  assert.equal(qqLevelForQuality('standard'), 'standard');
  assert.equal(qqLevelForQuality('low'), 'standard');
});

await test('海棠代理候选已改为 POST + level（不再是无档位参数的 GET）', () => {
  const src = read('src/providers/music/QqSource.ts');
  assert.ok(/method: 'POST'/.test(src), '海棠 resolve-url POST 候选缺失');
  assert.ok(src.includes("level: qqLevelForQuality(quality)"), 'level 参数缺失');
  assert.ok(!src.includes("resolve-url?source=qq&id="), '旧的无档位 GET 候选仍存在');
});

console.log('\nB6 · 全源音质诚实性');

await test('bitrateToQuality：码率→档位阈值带', () => {
  assert.equal(bitrateToQuality(1800), 'hires');
  assert.equal(bitrateToQuality(1000), 'lossless');
  assert.equal(bitrateToQuality(320), 'high');
  assert.equal(bitrateToQuality(192), 'higher');
  assert.equal(bitrateToQuality(128), 'standard');
  assert.equal(bitrateToQuality(48), 'low');
});

await test('classifyActualQuality：4分钟 55MB（Hi-Res 体量，~1920kbps）→ hires', () => {
  const r = classifyActualQuality(55 * 1024 * 1024, 240);
  assert.equal(r.actualQuality, 'hires');
  assert.ok(r.actualBitrate >= 1400);
});

await test('B1 场景复现：标称 Hi-Res 实际 128k（4分钟 3.8MB）→ actualQuality=standard，暴露名实不符', () => {
  const r = classifyActualQuality(3.8 * 1024 * 1024, 240);
  assert.equal(r.actualQuality, 'standard');
});

await test('classifyActualQuality：4分钟 32MB（无损 flac 体量，~1118kbps）→ lossless', () => {
  const r = classifyActualQuality(32 * 1024 * 1024, 240);
  assert.equal(r.actualQuality, 'lossless');
});

await test('classifyActualQuality：4分钟 9.6MB（320k 体量）→ high', () => {
  const r = classifyActualQuality(9.6 * 1024 * 1024, 240);
  assert.equal(r.actualQuality, 'high');
});

await test('诚实性约束：无时长不做档位推算（只回 sizeBytes）', () => {
  const r = classifyActualQuality(3.8 * 1024 * 1024, undefined);
  assert.equal(r.sizeBytes, 3.8 * 1024 * 1024);
  assert.equal(r.actualQuality, undefined);
  assert.equal(r.actualBitrate, undefined);
});

await test('诚实性约束：无大小/非法输入返回空对象', () => {
  assert.deepEqual(classifyActualQuality(0, 240), {});
  assert.deepEqual(classifyActualQuality(null, 240), {});
  assert.deepEqual(classifyActualQuality(3.8 * 1024 * 1024, 0), { sizeBytes: 3.8 * 1024 * 1024 });
});

await test('PlayUrlResult 已扩展 sizeBytes/actualQuality/actualBitrate 字段', () => {
  const src = read('src/core/types.ts');
  assert.ok(/actualQuality\?: Quality;/.test(src));
  assert.ok(/actualBitrate\?: number;/.test(src));
  assert.ok(/sizeBytes\?: number;/.test(src));
});

await test('DownloadTask 已扩展 actualQuality/sizeBytes 字段（下载链路诚实性）', () => {
  const src = read('src/core/types.ts');
  assert.ok(src.includes('actualQuality?: Quality;'), 'DownloadTask.actualQuality 缺失');
});

await test('BaseHttpSource：取链成功后挂载真实档位（attachActualQuality 接入缓存链）', () => {
  const src = read('src/providers/music/BaseHttpSource.ts');
  assert.ok(src.includes('attachActualQuality'), 'attachActualQuality 未接入');
  assert.ok(src.includes('probeFileSize'), 'HEAD 探测未接入');
  assert.ok(src.includes('classifyActualQuality'), '档位推算未接入');
  assert.ok(src.includes("opts?: { durationSec?: number }"), 'getPlayUrl 未接收时长参数');
});

await test('doValidateContent 已从 Range 响应捕获 Content-Range 总长（免二次探测）', () => {
  const src = read('src/providers/music/BaseHttpSource.ts');
  assert.ok(src.includes("resp.headers.get('content-range')"), 'content-range 捕获缺失');
});

await test('播放引擎取链调用已传 durationSec', () => {
  const src = read('src/core/player/index.ts');
  assert.ok(src.includes('{ durationSec: track.duration || undefined }'), '播放取链未传时长');
});

await test('播放页 UI：真实档位优先于标称回写 store', () => {
  const src = read('src/App.tsx');
  assert.ok(src.includes('result.actualQuality ?? result.quality'), 'actualQuality 回写未接入');
});

await test('下载链路：实测字节复核真实档位并回写 task', () => {
  const src = read('src/core/download/index.ts');
  assert.ok(src.includes('task.actualQuality'), 'task.actualQuality 回写缺失');
  assert.ok(src.includes('{ durationSec: meta?.durationSec }'), '下载取链未传时长');
  assert.ok(src.includes('durationSec: song.duration || undefined') === false, 'download 引擎不应引用 UI 变量');
});

await test('下载页任务行已显示「标称 · 实际 X」', () => {
  const src = read('src/pages/DownloadPage.tsx');
  assert.ok(src.includes('qualityDisplayText'), '下载页真实音质展示缺失');
  assert.ok(src.includes('实际'), '「实际」字样缺失');
});

await test('下载入口已传 durationSec（搜索页 + 音质弹窗）', () => {
  assert.ok(read('src/pages/SearchPage.tsx').includes('durationSec: result.duration || undefined'));
  assert.ok(read('src/components/song/QualitySizeSheet.tsx').includes('durationSec: song.duration || undefined'));
});

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
