import { describe, test, expect } from 'bun:test';
import { createGuardedAction } from '../src/shared/utils/guardedAction';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createGuardedAction（E4 守卫状态机）', () => {
  test('进行中禁用：上一次未结束时再次触发被忽略', async () => {
    let calls = 0;
    const guard = createGuardedAction(async () => {
      calls++;
      await sleep(50);
    }, 0);

    expect(guard.run()).toBe(true);
    expect(guard.run()).toBe(false); // 进行中
    expect(guard.getPending()).toBe(true);
    await sleep(70);
    expect(guard.getPending()).toBe(false);
    expect(calls).toBe(1);
  });

  test('300ms 防抖：结束后立即再触发被忽略，跨过窗口后放行', async () => {
    let calls = 0;
    const guard = createGuardedAction(() => {
      calls++;
    }, 300);

    expect(guard.run()).toBe(true);
    expect(guard.run()).toBe(false); // 防抖窗口内
    await sleep(320);
    expect(guard.run()).toBe(true); // 窗口外放行
    expect(calls).toBe(2);
  });

  test('同步动作异常时守卫状态复位，不吞异常', () => {
    const guard = createGuardedAction(() => {
      throw new Error('boom');
    }, 0);

    expect(() => guard.run()).toThrow('boom');
    expect(guard.getPending()).toBe(false);
    // 复位后可再次触发
    expect(() => guard.run()).toThrow('boom');
  });

  test('异步动作失败后守卫状态复位', async () => {
    const guard = createGuardedAction(async () => {
      await sleep(10);
      throw new Error('async boom');
    }, 0);

    expect(guard.run()).toBe(true);
    await sleep(30);
    expect(guard.getPending()).toBe(false);
  });

  test('reset：清空防抖窗口与进行中标记', async () => {
    let calls = 0;
    const guard = createGuardedAction(async () => {
      calls++;
      await sleep(30);
    }, 5000);

    expect(guard.run()).toBe(true);
    guard.reset();
    expect(guard.getPending()).toBe(false);
    expect(guard.run()).toBe(true); // reset 后不被防抖拦
    expect(calls).toBe(2);
  });
});
