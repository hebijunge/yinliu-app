/**
 * v27 取链/播放核心链路 · resolve + 裁决单元测试
 * 运行：node tests/v27-linkchain-resolve.test.mjs
 *
 * 覆盖范围（对应走查 F1/F3）：
 * F1｜QQ resolveOfficialVkey — 9 项
 * F3｜raceWithAccuratePriority — 5 项
 */

import assert from 'node:assert/strict';

// ============ 测试框架 ============
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

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      msg ? `${msg}: expected ${String(expected)}, got ${String(actual)}` :
      `Expected ${String(expected)}, got ${String(actual)}`
    );
  }
}

// ============ 辅助：构造模拟 Response ============
function mockJsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockErrorResponse() {
  return new Response('not json', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ 被测函数副本（与 src/providers/music/QqSource.ts 保持一致） ============

/**
 * F1(v27 P0-1a)：官方 GetVkeyServer 响应解析。
 * musicu.fcg 返回 JSON 协议体——提取 req_2.data.midurlinfo[0].purl 拼 CDN 域名
 */
async function resolveOfficialVkey(response, targetQuality, fmt) {
  try {
    const data = await response.json();
    const midurlinfo = data?.req_2?.data?.midurlinfo?.[0];
    const purl = typeof midurlinfo?.purl === 'string' ? midurlinfo.purl : '';
    if (!purl) return null;

    let url;
    if (/^https?:\/\//i.test(purl)) {
      url = purl;
    } else {
      const sip = Array.isArray(data?.req_2?.data?.sip)
        ? data.req_2.data.sip.find((s) => typeof s === 'string' && /^https?:\/\//i.test(s))
        : '';
      if (!sip) return null;
      url = `${sip}${purl}`;
    }
    if (!/^https?:\/\//i.test(url)) return null;

    const actualExt = url.split('?')[0].split('.').pop()?.toLowerCase() || fmt.format.split('.').pop() || 'mp3';
    const requestedPrefix = fmt.format.split('.')[0];
    const accurate = url.includes(requestedPrefix);

    return {
      url,
      quality: targetQuality,
      bitrate: fmt.bitrate,
      format: actualExt,
      headers: { 'Referer': 'https://y.qq.com' },
      accurate,
    };
  } catch {
    return null;
  }
}

/**
 * F1(v27)：从任意 JSON/文本响应中提取第一条音频直链。
 */
function extractFirstAudioUrl(text) {
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+/g);
  if (!matches) return null;
  for (const raw of matches) {
    const url = raw.replace(/[),.;!]+$/, '');
    if (/\.(mp3|flac|m4a|aac|ape|ogg|wav|mgg|mflac|mflac0|mgg1)(\?|#|$)/i.test(url)) {
      return url;
    }
  }
  return null;
}

/**
 * F3(v27 P0-2) accurate-aware 竞速：优先返回 accurate 候选，保留"一成功即返回"性能。
 */
async function raceWithAccuratePriority(promises, onWinner) {
  if (promises.length === 0) return null;
  if (promises.length === 1) return await promises[0];

  return new Promise((resolve) => {
    let resolved = false;
    let firstInaccurate = null;
    let remaining = promises.length;

    const win = (result) => {
      if (resolved) return;
      resolved = true;
      try { onWinner?.(); } catch { /* abort 回调不阻塞裁决 */ }
      resolve(result);
    };

    const tryResolve = () => {
      if (!resolved && remaining === 0 && firstInaccurate) {
        win(firstInaccurate);
      } else if (!resolved && remaining === 0) {
        resolved = true;
        resolve(null);
      }
    };

    promises.forEach((p) => {
      p.then((result) => {
        remaining--;
        if (resolved) return;
        if (!result) { tryResolve(); return; }
        if (result._validated) { win(result); return; }
        if (result.accurate !== false) { win(result); return; }
        if (!firstInaccurate) firstInaccurate = result;
        tryResolve();
      }).catch(() => {
        remaining--;
        tryResolve();
      });
    });
  });
}

// ============ F1｜QQ resolveOfficialVkey（9 项） ============
console.log('\n📦 F1｜QQ resolveOfficialVkey');

const fmt = { format: 'M800.mp3', bitrate: 320 };
const quality = 'HIGH';

await test('① purl 为路径时拼 sip 成完整 CDN 直链', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['http://dl.stream.qqmusic.qq.com/', 'https://other.example.com/'],
        midurlinfo: [{ purl: '/M800001AbCdEf.mp3' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  assert.ok(result);
  eq(result.url, 'http://dl.stream.qqmusic.qq.com//M800001AbCdEf.mp3');
});

await test('② purl 为绝对 URL 时直接使用', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['http://dl.stream.qqmusic.qq.com/'],
        midurlinfo: [{ purl: 'https://cdn.example.com/M800001AbCdEf.mp3' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  assert.ok(result);
  eq(result.url, 'https://cdn.example.com/M800001AbCdEf.mp3');
});

await test('③ purl 为空字符串时判候选失败', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['http://dl.stream.qqmusic.qq.com/'],
        midurlinfo: [{ purl: '' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  eq(result, null);
});

await test('④ midurlinfo 字段缺失时判候选失败', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['http://dl.stream.qqmusic.qq.com/'],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  eq(result, null);
});

await test('⑤ req_2 缺失时判候选失败', async () => {
  const res = mockJsonResponse({
    req_1: { data: {} },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  eq(result, null);
});

await test('⑥ JSON 解析失败时判候选失败', async () => {
  const res = mockErrorResponse();
  const result = await resolveOfficialVkey(res, quality, fmt);
  eq(result, null);
});

await test('⑦ sip 数组无有效 http 项时判候选失败', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['ftp://invalid.example.com/'],
        midurlinfo: [{ purl: '/M800001AbCdEf.mp3' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  eq(result, null);
});

await test('⑧ sip 混合时取第一个有效 http 项', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['ftp://bad.example.com/', 'https://good.example.com/', 'http://second.example.com/'],
        midurlinfo: [{ purl: '/M800001AbCdEf.mp3' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  assert.ok(result);
  eq(result.url, 'https://good.example.com//M800001AbCdEf.mp3');
});

await test('⑨ purl 前缀与请求格式不符时 accurate=false', async () => {
  const res = mockJsonResponse({
    req_2: {
      data: {
        sip: ['http://dl.stream.qqmusic.qq.com/'],
        midurlinfo: [{ purl: '/C400001AbCdEf.mp3' }],
      },
    },
  });
  const result = await resolveOfficialVkey(res, quality, fmt);
  assert.ok(result);
  eq(result.accurate, false);
});

// ============ F3｜raceWithAccuratePriority（5 项） ============
console.log('\n📦 F3｜raceWithAccuratePriority');

await test('① _validated 候选立即胜出，不等其他候选 settle', async () => {
  let slowResolved = false;
  const p1 = Promise.resolve({ url: 'a', _candidateKey: 'k1', _validated: true, accurate: false });
  const p2 = new Promise((resolve) => {
    setTimeout(() => {
      slowResolved = true;
      resolve({ url: 'b', _candidateKey: 'k2', accurate: true });
    }, 50);
  });

  const result = await raceWithAccuratePriority([p1, p2]);
  assert.ok(result);
  eq(result.url, 'a');
  eq(result._candidateKey, 'k1');
  await new Promise((r) => setTimeout(r, 10));
  eq(slowResolved, false, 'slow candidate should not have resolved yet');
});

await test('② accurate 候选先完成仍立即返回', async () => {
  const p1 = Promise.resolve({ url: 'a', _candidateKey: 'k1', accurate: true });
  const p2 = new Promise((resolve) => {
    setTimeout(() => resolve({ url: 'b', _candidateKey: 'k2', accurate: false }), 50);
  });

  const result = await raceWithAccuratePriority([p1, p2]);
  assert.ok(result);
  eq(result.url, 'a');
});

await test('③ 无 accurate 无 validated 时，firstInaccurate 等 settle 后兜底', async () => {
  const p1 = Promise.resolve({ url: 'a', _candidateKey: 'k1', accurate: false });
  const p2 = new Promise((resolve) => {
    setTimeout(() => resolve({ url: 'b', _candidateKey: 'k2', accurate: false }), 30);
  });

  const result = await raceWithAccuratePriority([p1, p2]);
  assert.ok(result);
  eq(result.url, 'a');
});

await test('④ 全部失败返回 null', async () => {
  const p1 = Promise.resolve(null);
  const p2 = Promise.resolve(null);

  const result = await raceWithAccuratePriority([p1, p2]);
  eq(result, null);
});

await test('⑤ _validated 晚到（其他候选先完成但非 accurate）仍定案', async () => {
  const p1 = new Promise((resolve) => {
    setTimeout(() => resolve({ url: 'a', _candidateKey: 'k1', accurate: false }), 20);
  });
  const p2 = new Promise((resolve) => {
    setTimeout(() => resolve({ url: 'b', _candidateKey: 'k2', _validated: true, accurate: false }), 40);
  });

  const result = await raceWithAccuratePriority([p1, p2]);
  assert.ok(result);
  eq(result.url, 'b');
  eq(result._candidateKey, 'k2');
});

// ============ 汇总 ============
console.log(`\n📊 结果：通过 ${pass} / 失败 ${fail} / 总计 ${pass + fail}`);
if (fail > 0) {
  process.exit(1);
}
console.log('✅ 全部通过');
