/**
 * C5 搜索聚合修复自测（node 原生运行，无框架依赖）
 * 前置：npx esbuild src/core/search/index.ts --bundle --format=esm --platform=node --outfile=tests/.out/search-c5.mjs
 * 运行：node tests/searchC5Aggregation.test.mjs
 * 被测代码：src/core/search/index.ts
 *
 * 覆盖场景：
 * 1. normalizeArtist 词边界：'Daft Punk' 不再被旧正则的 ft 子串误切
 * 2. normalizeArtist feat/ft/featuring 分隔与中英文分隔符
 * 3. makeKey 不再编入 duration：同曲任何时长都映射到同一 base key
 * 4. isSameSong ±10s 容差：≤10s 合并、>10s 判不同版本、缺时长只按 title+artist
 * 5. 跨桶同曲合并契约：旧分桶（19/20 桶）拆两条 → 新方案同一 key 且判定同曲
 */
import assert from 'node:assert/strict';
import {
  normalizeArtist,
  normalizeTitle,
  makeKey,
  isSameSong,
} from './.out/search-c5.mjs';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(`PASS ${name}`);
  } catch (e) {
    checks.push(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// —— 1. 词边界（旧实现先去空格，'daftpunk' 会在 ft 子串处被切成 'da'）——
check('normalizeArtist: Daft Punk 不被 ft 子串误切', () => {
  assert.equal(normalizeArtist('Daft Punk'), 'daft punk');
});
check('normalizeArtist: Hot Chip feat. José González → hot chip', () => {
  assert.equal(normalizeArtist('Hot Chip feat. José González'), 'hot chip');
});
check('normalizeArtist: A ft. B → a', () => {
  assert.equal(normalizeArtist('Jay Chou ft. banda'), 'jay chou');
});
check('normalizeArtist: A featuring B → a', () => {
  assert.equal(normalizeArtist('Coldplay featuring BTS'), 'coldplay');
});
check('normalizeArtist: 中文分隔符 、/&,', () => {
  assert.equal(normalizeArtist('周杰伦、费玉清'), '周杰伦');
  assert.equal(normalizeArtist('A/B & C, D'), 'a');
});

// —— 2. makeKey 不再编入 duration ——
check('makeKey: 同曲不同时长同一 base key', () => {
  const a = makeKey('One More Time', 'Daft Punk');
  const b = makeKey('One More Time', 'Daft Punk');
  assert.equal(a, b);
  assert.equal(a, `${normalizeTitle('One More Time')}|${normalizeArtist('Daft Punk')}`);
});

// —— 3. isSameSong ±10s 容差 ——
check('isSameSong: 时长差 9s → 同曲', () => {
  assert.equal(isSameSong(
    { title: 'X', artist: 'Y', duration: 205, type: 'song', id: 'a', sourceId: 's1', sourceSongId: 'a1' },
    { title: 'X', artist: 'Y', duration: 214, type: 'song', id: 'b', sourceId: 's2', sourceSongId: 'b1' }
  ), true);
});
check('isSameSong: 时长差 11s → 不同版本', () => {
  assert.equal(isSameSong(
    { title: 'X', artist: 'Y', duration: 205, type: 'song', id: 'a', sourceId: 's1', sourceSongId: 'a1' },
    { title: 'X', artist: 'Y', duration: 216, type: 'song', id: 'b', sourceId: 's2', sourceSongId: 'b1' }
  ), false);
});
check('isSameSong: 任一方缺时长 → 按 title+artist 判同', () => {
  assert.equal(isSameSong(
    { title: 'X', artist: 'Y', type: 'song', id: 'a', sourceId: 's1', sourceSongId: 'a1' },
    { title: 'X', artist: 'Y', duration: 300, type: 'song', id: 'b', sourceId: 's2', sourceSongId: 'b1' }
  ), true);
});
check('isSameSong: 歌手不同 → 不同曲', () => {
  assert.equal(isSameSong(
    { title: 'X', artist: 'Y1', duration: 200, type: 'song', id: 'a', sourceId: 's1', sourceSongId: 'a1' },
    { title: 'X', artist: 'Y2', duration: 200, type: 'song', id: 'b', sourceId: 's2', sourceSongId: 'b1' }
  ), false);
});

// —— 4. 跨桶合并契约 ——
check('聚合契约：跨桶同曲（199s vs 208s）收敛为同一 key 且判定同曲', () => {
  // 旧分桶：floor(199/10)=19 vs floor(208/10)=20 → 两条；新方案 key 相同 + isSameSong=true → 合并
  assert.equal(makeKey('Digital Love', 'Daft Punk'), makeKey('Digital Love', 'Daft Punk'));
  assert.equal(isSameSong(
    { title: 'Digital Love', artist: 'Daft Punk', duration: 199, type: 'song', id: 'a', sourceId: 'kuwo', sourceSongId: 'k1' },
    { title: 'Digital Love', artist: 'Daft Punk', duration: 208, type: 'song', id: 'b', sourceId: 'kugou', sourceSongId: 'g1' }
  ), true);
});

console.log(checks.join('\n'));
console.log(process.exitCode ? '\n存在失败用例' : `\n全部通过（${checks.length} 项）`);
