/**
 * C1 超时取消语义验证（node 原生运行，无测试框架依赖）
 * 运行：node tests/requestSignalTimeout.test.mjs
 *
 * 验收目标：
 * - platformFetch 浏览器路径：超时后 AbortController.abort() 真正终止底层请求
 *   （服务端 socket 随之断开），而不是仅标记错误后让连接继续挂着
 * - 超时错误类型为 DOMException TimeoutError，且错误按时抛出
 * - 外部 signal 取消：立即以 AbortError 抛出
 * - createRequestSignal：超时触发 abort；外部 abort 传播；外部信号为空时仅剩超时语义
 */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(here, '.build');
mkdirSync(outDir, { recursive: true });

execSync(
  'npx esbuild src/shared/utils/platformFetch.ts --bundle --platform=node --format=esm --outfile=' +
    path.join(outDir, 'platformFetch.mjs') +
    ' --alias:@capacitor/core=./tests/stubs/capacitor-core.mjs' +
    ' --alias:@capacitor/filesystem=./tests/stubs/capacitor-filesystem.mjs' +
    ' --alias:@capacitor/share=./tests/stubs/capacitor-share.mjs' +
    ' --alias:@shared/utils/debugLogger=./tests/stubs/debug-logger.mjs' +
    ' --alias:@shared/components/Toast=./tests/stubs/toast.mjs',
  { cwd: repoRoot, stdio: 'inherit' }
);

const { platformFetch } = await import(path.join(outDir, 'platformFetch.mjs'));

execSync(
  'npx esbuild src/shared/utils/requestSignal.ts --bundle --platform=node --format=esm --outfile=' +
    path.join(outDir, 'requestSignal.mjs'),
  { cwd: repoRoot, stdio: 'inherit' }
);
const { createRequestSignal } = await import(path.join(outDir, 'requestSignal.mjs'));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
}

/** 挂起不响应的 HTTP 服务：记录请求与 socket 断开时刻 */
function startHangingServer() {
  const events = { requests: 0, closed: 0, firstCloseAt: 0 };
  const server = http.createServer((req, res) => {
    events.requests++;
    req.socket.on('close', () => {
      if (!events.firstCloseAt) events.firstCloseAt = Date.now();
      events.closed++;
    });
    // 故意不响应，模拟弱网下服务器无响应
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, events, port: server.address().port }));
  });
}

function startEchoServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // ===== 场景 1：超时真正取消底层请求（POST 避开 GET 自动重试）=====
  {
    const { server, events, port } = await startHangingServer();
    const startedAt = Date.now();
    let err = null;
    try {
      await platformFetch(`http://127.0.0.1:${port}/hang`, { method: 'POST', timeout: 400 });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - startedAt;
    record('超时请求按时失败', !!err && elapsed >= 350 && elapsed < 2000, `耗时 ${elapsed}ms`);
    record(
      '超时错误类型为 TimeoutError',
      err instanceof DOMException && err.name === 'TimeoutError',
      err ? `实际 ${err.name}: ${err.message}` : '无错误'
    );
    // 服务端 socket 应在超时后很快断开（真取消），而非长时间保持
    await new Promise((r) => setTimeout(r, 300));
    record(
      '服务端连接已被终止（真取消）',
      events.closed > 0 && events.firstCloseAt - startedAt < 2000,
      `首个断开距发起 ${events.firstCloseAt ? events.firstCloseAt - startedAt : 'N/A'}ms`
    );
    server.close();
  }

  // ===== 场景 2：正常请求不受影响 =====
  {
    const { server, port } = await startEchoServer();
    const resp = await platformFetch(`http://127.0.0.1:${port}/echo`, { method: 'GET' });
    const body = await resp.json();
    record('正常请求成功返回', resp.status === 200 && body.ok === true);
    server.close();
  }

  // ===== 场景 3：外部 signal 取消 → AbortError =====
  {
    const { server, port } = await startHangingServer();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    let err = null;
    const startedAt = Date.now();
    try {
      await platformFetch(`http://127.0.0.1:${port}/hang`, { method: 'POST', signal: ac.signal });
    } catch (e) {
      err = e;
    }
    record(
      '外部取消立即以 AbortError 抛出',
      !!err && err.name === 'AbortError' && Date.now() - startedAt < 1200,
      err ? `实际 ${err.name}` : '无错误'
    );
    server.close();
  }

  // ===== 场景 4：createRequestSignal 组合语义 =====
  {
    // 4a 超时触发
    const s1 = createRequestSignal(150);
    await new Promise((r) => setTimeout(r, 300));
    record('createRequestSignal 超时触发 abort', s1.aborted && s1.reason?.name === 'TimeoutError');

    // 4b 外部 abort 传播
    const ac = new AbortController();
    const s2 = createRequestSignal(60000, ac.signal);
    ac.abort();
    record('createRequestSignal 外部 abort 立即传播', s2.aborted);

    // 4c 外部已 abort 的信号直接短路
    const ac2 = new AbortController();
    ac2.abort();
    const s3 = createRequestSignal(60000, ac2.signal);
    record('createRequestSignal 对已取消的外部信号立即 abort', s3.aborted);

    // 4d 外部信号正常完成（未超时未取消）时保持非 abort
    const s4 = createRequestSignal(300);
    await new Promise((r) => setTimeout(r, 50));
    record('超时未到时信号保持未取消', !s4.aborted);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
