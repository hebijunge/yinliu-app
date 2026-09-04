import { getDb, getSqliteDb, flushDatabase } from '@shared/database';
import { normalizeTitle, normalizeArtist } from '@core/search';

export interface PlaylistSong {
  id: number;
  playlistId: string;
  songId: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  source: string;
  quality: string;
  addedAt: number;
  sortOrder: number;
  /** v14: 匹配状态：matched / fallback / failed */
  matchStatus?: string;
  /** v14: 失败原因（仅 failed 时有） */
  failureReason?: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  createdAt: number;
  updatedAt: number;
  songCount: number;
}

/** 跨源归一化收藏键：基于歌名+歌手归一化 */
function makeFavoriteKey(title: string, artist?: string): string {
  return `${normalizeTitle(title)}|${normalizeArtist(artist || '')}`;
}

class PlaylistService {
  // === 歌单 CRUD ===

  async getAllPlaylists(): Promise<Playlist[]> {
    const sqliteDb = getSqliteDb();
    const stmt = sqliteDb.prepare(
      `SELECT p.*, COUNT(ps.id) as song_count
       FROM playlists p
       LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`
    );
    const playlists: Playlist[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      playlists.push({
        id: String(row.id),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        coverUrl: row.cover_url ? String(row.cover_url) : undefined,
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
        songCount: Number(row.song_count || 0),
      });
    }
    stmt.free();
    return playlists;
  }

  async createPlaylist(name: string, description?: string): Promise<Playlist> {
    const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `INSERT INTO playlists (id, name, description, type, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, description || null, 'normal', 0, now, now]
    );
    await flushDatabase();
    return {
      id,
      name,
      description,
      createdAt: now,
      updatedAt: now,
      songCount: 0,
    };
  }

  async renamePlaylist(id: string, name: string): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?`,
      [name, Date.now(), id]
    );
    await flushDatabase();
  }

  /** 写入歌单封面（歌单有歌曲时取第一首歌封面作为歌单封面） */
  async setPlaylistCover(id: string, coverUrl: string): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `UPDATE playlists SET cover_url = ?, updated_at = ? WHERE id = ?`,
      [coverUrl, Date.now(), id]
    );
    await flushDatabase();
  }

  async deletePlaylist(id: string): Promise<void> {
    const sqliteDb = getSqliteDb();
    // 先删关联歌曲
    sqliteDb.run(`DELETE FROM playlist_songs WHERE playlist_id = ?`, [id]);
    // 再删歌单（但保留 favorites，因为「我喜欢的音乐」是固定歌单）
    sqliteDb.run(`DELETE FROM playlists WHERE id = ? AND id != 'favorites'`, [id]);
    await flushDatabase();
  }

  // === 歌曲操作 ===

  async getPlaylistSongs(playlistId: string): Promise<PlaylistSong[]> {
    const sqliteDb = getSqliteDb();
    const stmt = sqliteDb.prepare(
      `SELECT * FROM playlist_songs WHERE playlist_id = ? ORDER BY sort_index ASC, added_at DESC`
    );
    stmt.bind([playlistId]);
    const songs: PlaylistSong[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      songs.push({
        id: Number(row.id),
        playlistId: String(row.playlist_id),
        songId: String(row.song_id),
        title: String(row.title || ''),
        artist: row.artist ? String(row.artist) : undefined,
        album: row.album ? String(row.album) : undefined,
        duration: row.duration ? Number(row.duration) : undefined,
        coverUrl: row.cover_url ? String(row.cover_url) : undefined,
        source: String(row.source || ''),
        quality: String(row.quality || 'standard'),
        addedAt: Number(row.added_at || 0),
        sortOrder: Number(row.sort_index || 0),
        matchStatus: row.match_status ? String(row.match_status) : 'matched',
        failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
      });
    }
    stmt.free();
    return songs;
  }

  async addSongToPlaylist(
    playlistId: string,
    song: {
      songId: string;
      title: string;
      artist?: string;
      album?: string;
      duration?: number;
      coverUrl?: string;
      source: string;
      quality: string;
      matchStatus?: string;
      failureReason?: string;
    }
  ): Promise<boolean> {
    const sqliteDb = getSqliteDb();
    const now = Date.now();

    // P1: 去重前移数据层 —— 同歌单 + 同平台 + 同 songId 唯一（DB 层另有唯一索引兜底）。
    // 不再依赖 store 中「当前打开歌单」的渲染态判断，给任何歌单（含未打开的）加歌都能正确去重
    const existStmt = sqliteDb.prepare(
      `SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ? AND source = ? LIMIT 1`
    );
    existStmt.bind([playlistId, song.songId, song.source]);
    const exists = existStmt.step();
    existStmt.free();
    if (exists) {
      // 重复添加：直接跳过，调用方据 false 返回值省去强制重取（列表稳定无闪烁）
      return false;
    }

    // 获取当前最大 sort_index
    const countStmt = sqliteDb.prepare(
      `SELECT COUNT(*) as cnt FROM playlist_songs WHERE playlist_id = ?`
    );
    countStmt.bind([playlistId]);
    let maxIndex = 0;
    if (countStmt.step()) {
      maxIndex = Number((countStmt.getAsObject() as Record<string, unknown>).cnt || 0);
    }
    countStmt.free();

    sqliteDb.run(
      `INSERT INTO playlist_songs
       (playlist_id, song_id, title, artist, album, duration, cover_url, source, quality, sort_index, added_at, match_status, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        playlistId,
        song.songId,
        song.title,
        song.artist || null,
        song.album || null,
        song.duration || null,
        song.coverUrl || null,
        song.source,
        song.quality,
        maxIndex,
        now,
        song.matchStatus || 'matched',
        song.failureReason || null,
      ]
    );

    // 更新歌单的 updated_at
    sqliteDb.run(
      `UPDATE playlists SET updated_at = ? WHERE id = ?`,
      [now, playlistId]
    );

    await flushDatabase();
    return true;
  }

  async removeSongFromPlaylist(playlistId: string, songId: string): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?`,
      [playlistId, songId]
    );
    sqliteDb.run(
      `UPDATE playlists SET updated_at = ? WHERE id = ?`,
      [Date.now(), playlistId]
    );
    await flushDatabase();
  }

  async moveSongOrder(playlistId: string, songId: string, newIndex: number): Promise<void> {
    const sqliteDb = getSqliteDb();
    sqliteDb.run(
      `UPDATE playlist_songs SET sort_index = ? WHERE playlist_id = ? AND song_id = ?`,
      [newIndex, playlistId, songId]
    );
    sqliteDb.run(
      `UPDATE playlists SET updated_at = ? WHERE id = ?`,
      [Date.now(), playlistId]
    );
    await flushDatabase();
  }

  // === 收藏：加入「我喜欢的音乐」（id='favorites' 的普通歌单）===
  async addToFavorites(song: {
    songId: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
    coverUrl?: string;
    source: string;
    quality: string;
  }): Promise<void> {
    // 跨源去重：基于归一化歌名+歌手判断是否已收藏
    const existing = await this.getPlaylistSongs('favorites');
    const normKey = makeFavoriteKey(song.title, song.artist);
    const alreadyExists = existing.some((s) => makeFavoriteKey(s.title, s.artist) === normKey);
    if (alreadyExists) {
      return;
    }

    await this.addSongToPlaylist('favorites', song);
  }

  async removeFromFavorites(songId: string): Promise<void> {
    await this.removeSongFromPlaylist('favorites', songId);
  }

  /** 按归一化键移除收藏（跨源：移除同一首歌的所有平台版本） */
  async removeFromFavoritesByNormKey(title: string, artist?: string): Promise<void> {
    const existing = await this.getPlaylistSongs('favorites');
    const normKey = makeFavoriteKey(title, artist);
    for (const s of existing) {
      if (makeFavoriteKey(s.title, s.artist) === normKey) {
        await this.removeSongFromPlaylist('favorites', s.songId);
      }
    }
  }

  async isFavorite(title: string, artist?: string): Promise<boolean> {
    const existing = await this.getPlaylistSongs('favorites');
    const normKey = makeFavoriteKey(title, artist);
    return existing.some((s) => makeFavoriteKey(s.title, s.artist) === normKey);
  }
}

export const playlistService = new PlaylistService();
