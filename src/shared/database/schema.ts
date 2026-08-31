import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// === 音乐相关表 ===
export const songs = sqliteTable('songs', {
  id: text('id').primaryKey(),
  uri: text('uri').notNull().unique(),
  title: text('title').notNull(),
  artist: text('artist'),
  album: text('album'),
  duration: integer('duration'),
  coverUrl: text('cover_url'),
  sourceId: text('source_id'),
  sourceSongId: text('source_song_id'),
  quality: text('quality'),
  bitrate: integer('bitrate'),
  format: text('format'),
  isLocal: integer('is_local', { mode: 'boolean' }).default(false),
  localPath: text('local_path'),
  bpm: integer('bpm'),
  style: text('style'),
  mixType: text('mix_type'),
  createdAt: integer('created_at'),
});

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  coverUrl: text('cover_url'),
  type: text('type').default('normal'),
  sceneTag: text('scene_tag'),
  sortOrder: integer('sort_order').default(0),
  isSystem: integer('is_system', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at'),
  updatedAt: integer('updated_at'),
});

export const playlistSongs = sqliteTable('playlist_songs', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  playlistId: text('playlist_id').notNull(),
  songId: text('song_id').notNull(),
  sortIndex: integer('sort_index').notNull(),
  addedAt: integer('added_at'),
});

export const downloads = sqliteTable('downloads', {
  id: text('id').primaryKey(),
  songId: text('song_id').notNull(),
  sourceId: text('source_id'),
  quality: text('quality'),
  status: text('status').default('pending'),
  progress: real('progress').default(0),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  downloadedSize: integer('downloaded_size'),
  speed: integer('speed'),
  errorMessage: text('error_message'),
  isFallback: integer('is_fallback', { mode: 'boolean' }).default(false),
  retryCount: integer('retry_count').default(0),
  createdAt: integer('created_at'),
  completedAt: integer('completed_at'),
});

export const playHistory = sqliteTable('play_history', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  songId: text('song_id').notNull(),
  playedAt: integer('played_at'),
  playDuration: integer('play_duration'),
  quality: text('quality'),
  sourceId: text('source_id'),
});

export const sourceConfigs = sqliteTable('source_configs', {
  id: text('id').primaryKey(),
  name: text('name'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(0),
  maxQuality: text('max_quality'),
  authRequired: integer('auth_required', { mode: 'boolean' }).default(false),
  authParams: text('auth_params'),
  stabilityScore: integer('stability_score'),
});

// === 阅读相关表 ===
export const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  sourceId: text('source_id'),
  sourceBookId: text('source_book_id'),
  title: text('title').notNull(),
  author: text('author'),
  coverUrl: text('cover_url'),
  description: text('description'),
  rating: real('rating'),
  wordCount: integer('word_count'),
  category: text('category'),
  status: text('status'),
  totalChapters: integer('total_chapters'),
  lastUpdateTime: integer('last_update_time'),
  createdAt: integer('created_at'),
});

export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull(),
  chapterIndex: integer('chapter_index').notNull(),
  title: text('title'),
  content: text('content'),
  contentUrl: text('content_url'),
  wordCount: integer('word_count'),
  isVip: integer('is_vip', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at'),
});

export const readingProgress = sqliteTable('reading_progress', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull(),
  chapterIndex: integer('chapter_index'),
  positionOffset: integer('position_offset'),
  progressPercent: real('progress_percent'),
  lastReadAt: integer('last_read_at'),
});

export const bookBookmarks = sqliteTable('book_bookmarks', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull(),
  chapterIndex: integer('chapter_index'),
  positionOffset: integer('position_offset'),
  note: text('note'),
  createdAt: integer('created_at'),
});

export const bookSearchHistory = sqliteTable('book_search_history', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  keyword: text('keyword').notNull(),
  searchedAt: integer('searched_at'),
});

// === 全局设置表 ===
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at'),
});

export const appCache = sqliteTable('app_cache', {
  key: text('key').primaryKey(),
  value: text('value'),
  expiredAt: integer('expired_at'),
  createdAt: integer('created_at'),
});
