import { drizzle } from 'drizzle-orm/sql-js';
import initSqlJs from 'sql.js';
import * as schema from './schema';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqliteDb: any | null = null;
let sqlJsModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;

const DB_NAME = 'yinliu_music_db';
const DB_STORE = 'sqlite_databases';
const DB_VERSION = 1;

// === IndexedDB 持久化后端 ===
function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_STORE, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const idb = (event.target as IDBOpenDBRequest).result;
      if (!idb.objectStoreNames.contains('databases')) {
        idb.createObjectStore('databases');
      }
    };
  });
}

async function saveDbToIndexedDB(data: Uint8Array): Promise<void> {
  try {
    const idb = await openIndexedDB();
    const tx = idb.transaction('databases', 'readwrite');
    const store = tx.objectStore('databases');
    await new Promise<void>((resolve, reject) => {
      const req = store.put(data, DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    idb.close();
  } catch (err) {
    console.error('[DB Persist] Failed to save to IndexedDB:', err);
    throw err;
  }
}

async function loadDbFromIndexedDB(): Promise<Uint8Array | null> {
  try {
    const idb = await openIndexedDB();
    const tx = idb.transaction('databases', 'readonly');
    const store = tx.objectStore('databases');
    const data = await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const req = store.get(DB_NAME);
      req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
      req.onerror = () => reject(req.error);
    });
    idb.close();
    return data ?? null;
  } catch (err) {
    console.error('[DB Persist] Failed to load from IndexedDB:', err);
    return null;
  }
}

// === 显式 flush：导出内存 DB 并写入 IndexedDB ===
export async function flushDatabase(): Promise<void> {
  if (!sqliteDb || !sqlJsModule) {
    throw new Error('Database not initialized, cannot flush');
  }
  const data = sqliteDb.export();
  await saveDbToIndexedDB(data);
  console.log('[DB Persist] Database flushed to IndexedDB, size:', data.length, 'bytes');
}

// === 初始化数据库（支持从 IndexedDB 恢复）===
export async function initDatabase(): Promise<typeof db> {
  if (db) return db;

  const SQL = await initSqlJs({
    locateFile: (file) => `/${file}`,
  });
  sqlJsModule = SQL;

  // 尝试从 IndexedDB 恢复已有数据库
  const savedData = await loadDbFromIndexedDB();
  if (savedData && savedData.length > 0) {
    try {
      sqliteDb = new SQL.Database(savedData);
      console.log('[DB Persist] Restored database from IndexedDB, size:', savedData.length, 'bytes');
    } catch (err) {
      console.error('[DB Persist] Failed to restore saved DB, creating new:', err);
      sqliteDb = new SQL.Database();
    }
  } else {
    sqliteDb = new SQL.Database();
    console.log('[DB Persist] No saved DB found, creating new database');
  }

  db = drizzle(sqliteDb, { schema });

  // === 建表（IF NOT EXISTS，兼容已有数据）===
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
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER,
      cover_url TEXT,
      source TEXT NOT NULL,
      quality TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      added_at INTEGER,
      match_status TEXT DEFAULT 'matched',
      failure_reason TEXT
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
    CREATE TABLE IF NOT EXISTS favorite_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      cover_url TEXT,
      creator TEXT,
      play_count INTEGER,
      track_count INTEGER,
      created_at INTEGER
    );
  `);

  // v14 兼容迁移：playlist_songs 增量列（已建过表的旧 DB 需要补列）
  // ALTER TABLE 不支持 IF NOT EXISTS（sql.js），用 try/catch 静默吞掉"重复列"错误
  try { sqliteDb.run(`ALTER TABLE playlist_songs ADD COLUMN match_status TEXT DEFAULT 'matched'`); } catch (e) { /* 旧 DB 已有该列时忽略 */ }
  try { sqliteDb.run(`ALTER TABLE playlist_songs ADD COLUMN failure_reason TEXT`); } catch (e) { /* 旧 DB 已有该列时忽略 */ }

  // v16 兼容迁移：downloads 增量列（下载页展示歌名/歌手；老安装的 downloads 表没有这两列）
  try { sqliteDb.run(`ALTER TABLE downloads ADD COLUMN title TEXT`); } catch (e) { /* 旧 DB 已有该列时忽略 */ }
  try { sqliteDb.run(`ALTER TABLE downloads ADD COLUMN artist TEXT`); } catch (e) { /* 旧 DB 已有该列时忽略 */ }

  // 插入默认音源配置
  const defaults = [
    { id: 'netease', name: '网易云音乐', enabled: 1, priority: 100, maxQuality: 'hires' },
    { id: 'qq', name: 'QQ音乐', enabled: 1, priority: 90, maxQuality: 'hifi' },
    { id: 'kuwo', name: '酷我音乐', enabled: 1, priority: 80, maxQuality: 'master' },
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

  // 初始化「我喜欢的音乐」歌单（固定 id='favorites'，普通歌单，不做特殊分支）
  sqliteDb.run(
    `INSERT OR IGNORE INTO playlists (id, name, description, type, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['favorites', '我喜欢的音乐', '默认收藏歌单', 'normal', 0, Date.now(), Date.now()]
  );

  // 首次初始化后立刻 flush
  await flushDatabase();

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function getSqliteDb() {
  if (!sqliteDb) throw new Error('Database not initialized');
  return sqliteDb;
}

export { schema };
