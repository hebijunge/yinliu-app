import { getSqliteDb, flushDatabase } from '@shared/database';

export interface HistoryRecord {
  id: number;
  songId: string;
  title: string;
  artist?: string;
  source?: string;
  playedAt: number;
  duration?: number;
}

export interface HistoryInput {
  songId: string;
  title: string;
  artist?: string;
  source?: string;
  duration?: number;
}

class PlayHistoryService {
  /** 记录一条播放历史；同一首歌连续播放去重（更新 playedAt） */
  async addRecord(input: HistoryInput): Promise<void> {
    const sqliteDb = getSqliteDb();
    const now = Date.now();

    // 查找同一首歌最近的一条记录
    const checkStmt = sqliteDb.prepare(
      `SELECT id FROM play_history WHERE song_id = ? ORDER BY played_at DESC LIMIT 1`
    );
    checkStmt.bind([input.songId]);
    let existingId: number | null = null;
    if (checkStmt.step()) {
      existingId = Number((checkStmt.getAsObject() as Record<string, unknown>).id);
    }
    checkStmt.free();

    if (existingId != null) {
      // 更新 played_at
      sqliteDb.run(
        `UPDATE play_history SET played_at = ?, title = ?, artist = ?, source = ?, duration = ? WHERE id = ?`,
        [now, input.title, input.artist || null, input.source || null, input.duration || null, existingId]
      );
    } else {
      sqliteDb.run(
        `INSERT INTO play_history (song_id, title, artist, source, played_at, duration)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.songId, input.title, input.artist || null, input.source || null, now, input.duration || null]
      );
    }

    await flushDatabase();
  }

  /** 获取最近播放记录，按时间倒序，限制条数 */
  async getRecent(limit: number = 200): Promise<HistoryRecord[]> {
    const sqliteDb = getSqliteDb();
    const stmt = sqliteDb.prepare(
      `SELECT * FROM play_history ORDER BY played_at DESC LIMIT ?`
    );
    stmt.bind([limit]);
    const records: HistoryRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      records.push({
        id: Number(row.id),
        songId: String(row.song_id),
        title: String(row.title || ''),
        artist: row.artist ? String(row.artist) : undefined,
        source: row.source ? String(row.source) : undefined,
        playedAt: Number(row.played_at || 0),
        duration: row.duration ? Number(row.duration) : undefined,
      });
    }
    stmt.free();
    return records;
  }

  /** 清空全部播放历史 */
  async clearAll(): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(`DELETE FROM play_history`);
    await flushDatabase();
  }

  /** 删除单条记录 */
  async removeRecord(id: number): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(`DELETE FROM play_history WHERE id = ?`, [id]);
    await flushDatabase();
  }
}

export const playHistoryService = new PlayHistoryService();
