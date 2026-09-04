import { getSqliteDb, flushDatabase } from '@shared/database';

export interface FavoritePlaylist {
  id: number;
  playlistId: string;
  sourceId: string;
  title: string;
  coverUrl?: string;
  creator?: string;
  playCount?: number;
  trackCount?: number;
  createdAt: number;
}

export interface FavoritePlaylistInput {
  playlistId: string;
  sourceId: string;
  title: string;
  coverUrl?: string;
  creator?: string;
  playCount?: number;
  trackCount?: number;
}

class FavoritePlaylistService {
  /** 获取全部收藏歌单 */
  async getAll(): Promise<FavoritePlaylist[]> {
    const sqliteDb = getSqliteDb();
    const stmt = sqliteDb.prepare(
      `SELECT * FROM favorite_playlists ORDER BY created_at DESC`
    );
    const items: FavoritePlaylist[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      items.push({
        id: Number(row.id),
        playlistId: String(row.playlist_id),
        sourceId: String(row.source_id),
        title: String(row.title || ''),
        coverUrl: row.cover_url ? String(row.cover_url) : undefined,
        creator: row.creator ? String(row.creator) : undefined,
        playCount: row.play_count ? Number(row.play_count) : undefined,
        trackCount: row.track_count ? Number(row.track_count) : undefined,
        createdAt: Number(row.created_at || 0),
      });
    }
    stmt.free();
    return items;
  }

  /** 添加收藏；已存在则更新信息（幂等） */
  async add(input: FavoritePlaylistInput): Promise<void> {
    const sqliteDb = getSqliteDb();
    const now = Date.now();

    // 检查是否已存在
    const checkStmt = sqliteDb.prepare(
      `SELECT id FROM favorite_playlists WHERE playlist_id = ? AND source_id = ?`
    );
    checkStmt.bind([input.playlistId, input.sourceId]);
    let existingId: number | null = null;
    if (checkStmt.step()) {
      existingId = Number((checkStmt.getAsObject() as Record<string, unknown>).id);
    }
    checkStmt.free();

    if (existingId != null) {
      sqliteDb.run(
        `UPDATE favorite_playlists SET title = ?, cover_url = ?, creator = ?, play_count = ?, track_count = ?, created_at = ? WHERE id = ?`,
        [input.title, input.coverUrl || null, input.creator || null, input.playCount || null, input.trackCount || null, now, existingId]
      );
    } else {
      sqliteDb.run(
        `INSERT INTO favorite_playlists (playlist_id, source_id, title, cover_url, creator, play_count, track_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.playlistId, input.sourceId, input.title, input.coverUrl || null, input.creator || null, input.playCount || null, input.trackCount || null, now]
      );
    }

    await flushDatabase();
  }

  /** 取消收藏 */
  async remove(playlistId: string, sourceId: string): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `DELETE FROM favorite_playlists WHERE playlist_id = ? AND source_id = ?`,
      [playlistId, sourceId]
    );
    await flushDatabase();
  }

  /** 判断是否已收藏 */
  async isFavorite(playlistId: string, sourceId: string): Promise<boolean> {
    const sqliteDb = getSqliteDb();
    const stmt = sqliteDb.prepare(
      `SELECT COUNT(*) as cnt FROM favorite_playlists WHERE playlist_id = ? AND source_id = ?`
    );
    stmt.bind([playlistId, sourceId]);
    let exists = false;
    if (stmt.step()) {
      exists = Number((stmt.getAsObject() as Record<string, unknown>).cnt || 0) > 0;
    }
    stmt.free();
    return exists;
  }
}

export const favoritePlaylistService = new FavoritePlaylistService();
