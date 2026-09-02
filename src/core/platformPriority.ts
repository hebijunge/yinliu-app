/**
 * 平台优先级（v18 双优先级表）
 *
 * v18 起区分两套顺序（用户明确要求两套并存）：
 *
 * 1. 播放/取链优先级 PLATFORM_PRIORITY（用户原话：酷我，咪咕，网易云，QQ，酷狗，汽水）
 *    —— 同一首歌多源可播时，实际取链/下载按此平台顺序选源。
 * 2. 展示聚合排序 DISPLAY_PRIORITY（用户原话：汽水，酷我，咪咕，网易云，QQ，酷狗）
 *    —— 聚合列表（搜索/热歌榜等）在「支持源数」相同时按此顺序排序，源徽章也按此顺序展示。
 *
 * 设计约束：
 * 1. 仅对多平台可用的歌生效，单平台歌曲行为不变
 * 2. resolvePlayUrl 和下载取链共用同一份常量表
 * 3. 与 v12 本地音乐（sourceId === 'local'）完全隔离
 * 4. 当前为只读常量，后续版本如需用户自定义排序，在 settings store 中加一个 override 数组即可
 */

/** 播放/取链优先级：酷我 > 咪咕 > 网易云 > QQ > 酷狗 > 汽水 */
export const PLATFORM_PRIORITY = ['kuwo', 'migu', 'netease', 'qq', 'kugou', 'qishui'] as const;

/** 展示聚合排序优先级：汽水 > 酷我 > 咪咕 > 网易云 > QQ > 酷狗 */
export const DISPLAY_PRIORITY = ['qishui', 'kuwo', 'migu', 'netease', 'qq', 'kugou'] as const;

export type PlatformId = typeof PLATFORM_PRIORITY[number];

/** 平台中文显示名（设置页只读展示、源徽章复用） */
export const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  qishui: '汽水音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  netease: '网易云音乐',
  qq: 'QQ音乐',
  kugou: '酷狗音乐',
};

/** 平台短名（音质弹窗等空间紧张处复用；v18 用户指定缩写：咪咕=mg QQ=qq 汽水=qi 酷狗=kg 酷我=kw 网易云=wy） */
export const PLATFORM_SHORT_NAMES: Record<string, string> = {
  qishui: 'qi',
  kuwo: 'kw',
  migu: 'mg',
  netease: 'wy',
  qq: 'qq',
  kugou: 'kg',
};

/** 平台缩写别名（components/common 等处复用） */
export const PLATFORM_ABBREVS: Record<string, string> = PLATFORM_SHORT_NAMES;

/** 平台品牌色（搜索结果徽章、设置页徽标复用） */
export const PLATFORM_COLORS: Record<string, string> = {
  qishui: 'bg-zinc-800',
  kuwo: 'bg-blue-500',
  migu: 'bg-orange-500',
  netease: 'bg-red-500',
  qq: 'bg-green-500',
  kugou: 'bg-cyan-500',
};

/** 取某平台的播放优先级序号（0 = 最高；不存在于表内则返回 Number.MAX_SAFE_INTEGER） */
export function getPriorityRank(sourceId: string): number {
  const idx = PLATFORM_PRIORITY.indexOf(sourceId as PlatformId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** 取某平台的展示排序序号（汽水在前） */
export function getDisplayRank(sourceId: string): number {
  const idx = DISPLAY_PRIORITY.indexOf(sourceId as (typeof DISPLAY_PRIORITY)[number]);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** 判断一个 sourceId 是否在优先级表内 */
export function isKnownPlatform(sourceId: string): boolean {
  return PLATFORM_PRIORITY.indexOf(sourceId as PlatformId) !== -1;
}

/**
 * 在一组 sourceId 中按播放优先级挑出最高优先级的那个。
 * @param sourceIds 候选 sourceId 列表
 * @returns 优先级最高的 sourceId；空列表返回 undefined
 */
export function pickBestSource(sourceIds: string[]): string | undefined {
  if (sourceIds.length === 0) return undefined;
  const sorted = [...sourceIds].sort((a, b) => getPriorityRank(a) - getPriorityRank(b));
  return sorted[0];
}

/** 把一组带 sourceId 的对象按播放优先级升序排序（酷我在前）。不会修改入参。 */
export function sortByPriority<T extends { sourceId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => getPriorityRank(a.sourceId) - getPriorityRank(b.sourceId));
}

/** 把一组带 sourceId 的对象按展示排序优先级升序排序（汽水在前）。不会修改入参。 */
export function sortByDisplayPriority<T extends { sourceId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => getDisplayRank(a.sourceId) - getDisplayRank(b.sourceId));
}

/**
 * 构建一个多平台降级链：第一个是 track.sourceId，后续按播放优先级表升序补齐。
 * 去重并跳过未在表内的平台。
 * 用于 resolvePlayUrl / downloadEngine.startDownload 的「首选失败 → 降级」逻辑。
 *
 * @param primarySourceId 首选（通常是搜索结果按优先级挑出的最高优先级平台，或历史/歌单里已有的）
 * @param availableSourceIds 该曲已知可用的全部 sourceId（来自聚合搜索结果）
 * @returns 按播放优先级升序排列的 sourceId 列表（首选必定是第 1 个；不包含 'local'）
 */
export function buildFallbackChain(
  primarySourceId: string,
  availableSourceIds: string[]
): string[] {
  // 不处理本地音乐——本地音乐走 readLocalAudioAsUrl，不参与取链
  if (primarySourceId === 'local') return [];

  const candidates = new Set<string>();
  if (primarySourceId && primarySourceId !== 'local') {
    candidates.add(primarySourceId);
  }
  for (const id of availableSourceIds) {
    if (id && id !== 'local') {
      candidates.add(id);
    }
  }
  // 限定在优先级表内（避免未来加了 P1 源后被错误降级）
  for (const id of [...candidates]) {
    if (!isKnownPlatform(id)) candidates.delete(id);
  }

  const ranked = [...candidates].sort((a, b) => getPriorityRank(a) - getPriorityRank(b));
  return ranked;
}
