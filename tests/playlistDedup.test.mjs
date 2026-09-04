/**
 * P1 歌单详情去重前移数据层 —— SQL 语义单元测试（node 原生运行，无测试框架依赖）
 * 运行：node tests/playlistDedup.test.mjs
 *
 * 验证（与 src/shared/database/index.ts 迁移、src/shared/services/PlaylistService.ts
 * 存在性检查完全同一 SQL）：
 * 1. 历史重复行清理：同 (playlist_id, song_id, source) 重复组收敛为最早一条
 * 2. 唯一索引生效：重复插入被 DB 拒绝（数据层硬约束，不依赖任何 UI/渲染状态）
 * 3. 跨源/跨歌单不受影响：同 song 不同 source、同 song 不同 playlist 均可插入
 */
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();

function makeDb() {
  const db = new SQL.Database();
  db.run(`
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
  `);
  return db;
}

function countAll(db) {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM playlist_songs`);
  let n = 0;
  if (stmt.step()) n = Number(stmt.getAsObject().cnt || 0);
  stmt.free();
  return n;
}

// === 与 src/shared/database/index.ts 中迁移完全同一组 SQL ===
function runMigration(db) {
  const dupStmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM (
       SELECT playlist_id, song_id, source FROM playlist_songs
       GROUP BY playlist_id, song_id, source HAVING COUNT(*) > 1
     )`
  );
  let dupGroupCount = 0;
  if (dupStmt.step()) dupGroupCount = Number(dupStmt.getAsObject().cnt || 0);
  dupStmt.free();
  if (dupGroupCount > 0) {
    db.run(`DELETE FROM playlist_songs WHERE id NOT IN (
       SELECT MIN(id) FROM playlist_songs GROUP BY playlist_id, song_id, source
     )`);
  }
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_songs_unique ON playlist_songs(playlist_id, song_id, source)`);
  return dupGroupCount;
}

// === 与 PlaylistService.addSongToPlaylist 存在性检查同一 SQL ===
function existsInPlaylist(db, playlistId, songId, source) {
  const stmt = db.prepare(
    `SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ? AND source = ? LIMIT 1`
  );
  stmt.bind([playlistId, songId, source]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function insertSong(db, playlistId, songId, source, title = '歌') {
  db.run(
    `INSERT INTO playlist_songs (playlist_id, song_id, title, source, quality, sort_index, added_at)
     VALUES (?, ?, ?, ?, 'standard', 0, 0)`,
    [playlistId, songId, title, source]
  );
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('== P1 歌单去重数据层测试 ==');

check('迁移清理：3 条同键重复行收敛为最早 1 条', () => {
  const db = makeDb();
  insertSong(db, 'pl_1', 's_1', 'netease', 'v1');
  insertSong(db, 'pl_1', 's_1', 'netease', 'v2');
  insertSong(db, 'pl_1', 's_1', 'netease', 'v3');
  assert.equal(countAll(db), 3);
  const dupGroups = runMigration(db);
  assert.equal(dupGroups, 1);
  assert.equal(countAll(db), 1);
  const stmt = db.prepare(`SELECT title FROM playlist_songs`);
  stmt.step();
  assert.equal(stmt.getAsObject().title, 'v1', '应保留最早（MIN(id)）一条');
  stmt.free();
});

check('唯一索引生效：重复插入被 DB 拒绝（渲染层零依赖）', () => {
  const db = makeDb();
  runMigration(db);
  insertSong(db, 'pl_1', 's_1', 'netease');
  assert.equal(existsInPlaylist(db, 'pl_1', 's_1', 'netease'), true, '存在性检查命中');
  assert.throws(() => insertSong(db, 'pl_1', 's_1', 'netease'), '绕过存在性检查时唯一索引也应兜底拒绝');
  assert.equal(countAll(db), 1);
});

check('跨源不受影响：同曲不同平台可共存', () => {
  const db = makeDb();
  runMigration(db);
  insertSong(db, 'pl_1', 's_1', 'netease');
  insertSong(db, 'pl_1', 's_1', 'qq');
  insertSong(db, 'pl_1', 's_1', 'kuwo');
  assert.equal(countAll(db), 3);
});

check('跨歌单不受影响：同曲加入其他歌单可插入（旧渲染态判重的失效场景）', () => {
  const db = makeDb();
  runMigration(db);
  insertSong(db, 'pl_1', 's_1', 'netease');
  // 旧逻辑：store 判重基于「当前打开歌单」的列表，pl_2 未打开时判重失效；
  // 新逻辑：数据层按 playlist_id 维度判重/约束，各自歌单内唯一
  assert.equal(existsInPlaylist(db, 'pl_2', 's_1', 'netease'), false, 'pl_2 中不存在，允许插入');
  insertSong(db, 'pl_2', 's_1', 'netease');
  assert.equal(countAll(db), 2);
});

check('同歌单不同歌曲不受影响', () => {
  const db = makeDb();
  runMigration(db);
  insertSong(db, 'pl_1', 's_1', 'netease');
  insertSong(db, 'pl_1', 's_2', 'netease');
  assert.equal(countAll(db), 2);
});

check('无重复时迁移幂等：不删任何行、索引不重复创建报错', () => {
  const db = makeDb();
  insertSong(db, 'pl_1', 's_1', 'netease');
  insertSong(db, 'pl_1', 's_2', 'netease');
  assert.equal(runMigration(db), 0);
  assert.equal(countAll(db), 2);
  runMigration(db); // 再次执行不抛错
  assert.equal(countAll(db), 2);
});

console.log(process.exitCode ? '\n存在失败用例' : `\n全部通过：${passed} 项`);
