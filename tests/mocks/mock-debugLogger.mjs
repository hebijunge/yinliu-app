/**
 * @shared/utils/debugLogger 测试替身：静默丢弃日志（保留调用形状）。
 */
function noop() {}

export const debugLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => debugLogger,
};
