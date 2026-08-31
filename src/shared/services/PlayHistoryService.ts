/**
 * 播放历史服务
 * v13: 异步持久化播放历史到数据库
 */
import { getSqliteDb } from '@shared/database';

export interface PlayHistoryRecord {
  songId: string;
  title: string;
  artist?: string;
  source: string;
  duration?: number;
}

class PlayHistoryService {
  async addRecord(record: PlayHistoryRecord): Promise<void> {
    try {
      const db = getSqliteDb();
      db.run(
        'INSERT INTO play_history (song_id, title, artist, source, duration, played_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          record.songId,
          record.title,
          record.artist || null,
          record.source,
          record.duration || 0,
          Date.now(),
        ]
      );
    } catch {
      // 表可能不存在；静默降级
    }
  }
}

export const playHistoryService = new PlayHistoryService();
