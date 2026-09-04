/**
 * v22 B5: 酷狗存量 legacy id（kg_1、kg_2…会话自增）一次性映射迁移。
 *
 * 背景：KugouSource 旧版用会话自增 id（kg_N）作 sourceSongId 落库，
 * 重启后 hashCache 为空，getHashFromId 只能剥前缀得到 "N"，取链必然失败（酷狗源失忆）。
 * 新版 sourceSongId 直接用 hash（kg_<32hex>）。
 *
 * 本模块在启动后台执行：
 * 1. 扫 playlist_songs / play_history / downloads 三表中 source='kugou' 且 song_id 形如 kg_数字 的行；
 * 2. 以 title+artist 调酷狗搜索反查 hash，标题归一化匹配后回填新 id；
 * 3. 逐行 UPDATE，最后统一 flush；localStorage 标记保证只跑一次。
 */
import { getSqliteDb, flushDatabase } from '@shared/database';
import { sourceRegistry } from '@providers/music/registry';
import type { KugouSource } from '@providers/music/KugouSource';
import { debugLogger } from '@shared/utils/debugLogger';

const MIGRATION_FLAG = 'kugou_legacy_id_migrated_v1';

/** legacy 自增 id：kg_ 后跟纯数字（新 id 是 kg_<32位hex>，天然不匹配） */
function isLegacyKugouId(id: string): boolean {
  return /^kg_[0-9]+$/.test(id);
}

/** 标题归一化：去空白、全角括号内容、大小写 */
function normalizeTitle(t: string): string {
  return (t || '')
    .toLowerCase()
    .replace(/[\(\s\uFF08\uFF09]+/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function normalizeArtist(a: string): string {
  return (a || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 反查单个 legacy 歌曲的新 hash id。搜索结果按标题归一化精确匹配优先，
 * 其次取首条（酷狗搜索对 title+artist 的首位命中率高）。查不到返回 null。
 */
async function resolveNewId(
  kugou: KugouSource,
  title: string,
  artist: string
): Promise<string | null> {
  const kw = artist ? `${title} ${artist}` : title;
  if (!kw.trim()) return null;
  try {
    const results = await kugou.search({ keyword: kw, page: 0 });
    if (!results || results.length === 0) return null;
    const nTitle = normalizeTitle(title);
    const nArtist = normalizeArtist(artist);
    // 优先：标题精确归一匹配 +（若能比较）歌手有交集
    const exact = results.find((r) => {
      if (normalizeTitle(r.title) !== nTitle) return false;
      if (!nArtist) return true;
      return normalizeArtist(r.artist ?? '').includes(nArtist) || nArtist.includes(normalizeArtist(r.artist ?? ''));
    });
    const picked = exact || results[0];
    return picked?.sourceSongId && picked.sourceSongId.startsWith('kg_') ? picked.sourceSongId : null;
  } catch {
    return null;
  }
}

export interface KugouMigrationResult {
  scanned: number;
  migrated: number;
  failed: number;
  skipped: boolean;
}

/** 启动后台执行的一次性迁移入口（幂等：已完成则直接返回） */
export async function runKugouLegacyIdMigration(): Promise<KugouMigrationResult> {
  const empty: KugouMigrationResult = { scanned: 0, migrated: 0, failed: 0, skipped: true };
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return empty;
  } catch {
    /* localStorage 不可用时每次启动都会尝试，无害 */
  }

  const source = sourceRegistry.get('kugou');
  if (!source) return empty;
  const kugou = source as KugouSource;

  let sqliteDb;
  try {
    sqliteDb = getSqliteDb();
  } catch {
    return empty; // DB 未就绪
  }

  // 收集三表 legacy 行（title+artist → 反查；按 (title,artist) 去重减少搜索次数）
  interface LegacyRow { table: 'playlist_songs' | 'play_history' | 'downloads'; rowId: string; songId: string; title: string; artist: string }
  const rows: LegacyRow[] = [];

  const collect = (sql: string, table: LegacyRow['table']) => {
    try {
      const stmt = sqliteDb.prepare(sql);
      stmt.bind(['kugou']);
      while (stmt.step()) {
        const r = stmt.getAsObject() as Record<string, unknown>;
        const songId = String(r.song_id ?? '');
        if (!isLegacyKugouId(songId)) continue;
        rows.push({
          table,
          rowId: String(r.id ?? r.rowid ?? ''),
          songId,
          title: String(r.title ?? ''),
          artist: String(r.artist ?? ''),
        });
      }
      stmt.free();
    } catch (e) {
      debugLogger.warn('init', `扫描 ${table} 失败`, { error: String(e) });
    }
  };

  collect(`SELECT id, song_id, title, artist FROM playlist_songs WHERE source = ?`, 'playlist_songs');
  collect(`SELECT id, song_id, title, artist FROM play_history WHERE source = ?`, 'play_history');
  collect(`SELECT id, song_id, title, artist FROM downloads WHERE source_id = ?`, 'downloads');

  const scanned = rows.length;
  if (scanned === 0) {
    try { localStorage.setItem(MIGRATION_FLAG, String(Date.now())); } catch { /* ignore */ }
    return { scanned: 0, migrated: 0, failed: 0, skipped: false };
  }

  // (title,artist) → 新id 的解析缓存
  const resolveCache = new Map<string, string | null>();
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    const cacheKey = `${normalizeTitle(row.title)}::${normalizeArtist(row.artist)}`;
    if (!resolveCache.has(cacheKey)) {
      resolveCache.set(cacheKey, await resolveNewId(kugou, row.title, row.artist));
    }
    const newId = resolveCache.get(cacheKey) || null;
    if (!newId || newId === row.songId) {
      failed++;
      continue;
    }
    try {
      const tbl = row.table === 'downloads' ? 'downloads' : row.table;
      sqliteDb.run(`UPDATE ${tbl} SET song_id = ? WHERE id = ? AND song_id = ?`, [newId, row.rowId, row.songId]);
      migrated++;
    } catch (e) {
      debugLogger.warn('init', `回填 ${row.table} 行失败`, { error: String(e) });
      failed++;
    }
  }

  try { await flushDatabase(); } catch { /* flush 失败不阻塞标记 */ }
  try { localStorage.setItem(MIGRATION_FLAG, String(Date.now())); } catch { /* ignore */ }

  debugLogger.info('init', '酷狗 legacy id 一次性迁移完成', { scanned, migrated, failed });
  return { scanned, migrated, failed, skipped: false };
}
