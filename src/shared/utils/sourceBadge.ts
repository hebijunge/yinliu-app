/**
 * D9 合一：音源徽标配色与相对时间格式化。
 * 此前 SOURCE_BADGE_COLORS 在 4 个页面各持一份（内容漂移：有的含 qishui/bilibili，
 * 有的没有）、formatRelativeTime 在 2 个页面重复——统一收编到此，单一真值。
 */

/** 音源 → 徽标底色（tailwind bg-*） */
export const SOURCE_BADGE_COLORS: Record<string, string> = {
  netease: 'bg-red-500',
  kugou: 'bg-blue-500',
  qq: 'bg-yellow-500',
  kuwo: 'bg-orange-500',
  migu: 'bg-teal-500',
  qishui: 'bg-purple-500',
  bilibili: 'bg-pink-500',
};

/** 未收录音源的兜底徽标底色 */
export const SOURCE_BADGE_FALLBACK = 'bg-gray-500';

/** 相对时间格式化：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD */
export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
