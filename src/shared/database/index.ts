import { drizzle } from 'drizzle-orm/sql-js';
import initSqlJs from 'sql.js';
import * as schema from './schema';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function initDatabase(): Promise<typeof db> {
  if (db) return db;
  
  const SQL = await initSqlJs({
    locateFile: (file) => {
      // Try local bundled WASM first, fallback to CDN only in dev
      if (import.meta.env?.DEV) {
        return `https://sql.js.org/dist/${file}`;
      }
      return `./${file}`;
    },
  });
  
  const sqliteDb = new SQL.Database();
  db = drizzle(sqliteDb, { schema });
  
  // Create tables
  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      uri TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      cover_url TEXT,
      source_id TEXT,
      source_song_id TEXT,
      quality TEXT,
      bitrate INTEGER,
      format TEXT,
      is_local INTEGER DEFAULT 0,
      local_path TEXT,
      bpm INTEGER,
      style TEXT,
      mix_type TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      cover_url TEXT,
      type TEXT DEFAULT 'normal',
      scene_tag TEXT,
      sort_order INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      added_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      source_id TEXT,
      quality TEXT,
      status TEXT DEFAULT 'pending',
      progress REAL DEFAULT 0,
      local_path TEXT,
      file_size INTEGER,
      downloaded_size INTEGER,
      speed INTEGER,
      error_message TEXT,
      is_fallback INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      created_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id TEXT NOT NULL,
      played_at INTEGER,
      play_duration INTEGER,
      quality TEXT,
      source_id TEXT
    );
    CREATE TABLE IF NOT EXISTS source_configs (
      id TEXT PRIMARY KEY,
      name TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      max_quality TEXT,
      auth_required INTEGER DEFAULT 0,
      auth_params TEXT,
      stability_score INTEGER
    );
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_book_id TEXT,
      title TEXT NOT NULL,
      author TEXT,
      cover_url TEXT,
      description TEXT,
      rating REAL,
      word_count INTEGER,
      category TEXT,
      status TEXT,
      total_chapters INTEGER,
      last_update_time INTEGER,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      title TEXT,
      content TEXT,
      content_url TEXT,
      word_count INTEGER,
      is_vip INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS reading_progress (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter_index INTEGER,
      position_offset INTEGER,
      progress_percent REAL,
      last_read_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_bookmarks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter_index INTEGER,
      position_offset INTEGER,
      note TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      searched_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_cache (
      key TEXT PRIMARY KEY,
      value BLOB,
      expired_at INTEGER,
      created_at INTEGER
    );
  `);
  
  // Insert default source configs
  const defaults = [
    { id: 'netease', name: '网易云音乐', enabled: 1, priority: 100, maxQuality: 'hires' },
    { id: 'qq', name: 'QQ音乐', enabled: 1, priority: 90, maxQuality: 'hifi' },
    { id: 'kuwo', name: '酷我音乐', enabled: 1, priority: 80, maxQuality: 'hifi' },
    { id: 'kugou', name: '酷狗音乐', enabled: 1, priority: 70, maxQuality: 'hires' },
    { id: 'migu', name: '咪咕音乐', enabled: 1, priority: 60, maxQuality: 'hires' },
    { id: 'qishui', name: '汽水音乐', enabled: 0, priority: 50, maxQuality: 'standard' },
    { id: 'qianqian', name: '千千音乐', enabled: 0, priority: 40, maxQuality: 'high' },
  ];
  
  for (const s of defaults) {
    sqliteDb.run(
      `INSERT OR IGNORE INTO source_configs (id, name, enabled, priority, max_quality) VALUES (?, ?, ?, ?, ?)`,
      [s.id, s.name, s.enabled, s.priority, s.maxQuality]
    );
  }
  
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export { schema };
