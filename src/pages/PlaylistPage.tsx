import { useState } from 'react';
import { Plus, Trash2, Edit3, ListMusic, Play, Link2, Loader2, CheckCircle2, AlertCircle, X, Music2, ArrowLeft, Clock, CloudDownload } from 'lucide-react';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { useSearchParams } from 'react-router-dom';
import { SkeletonPlaylistGrid } from '../components/ui/Skeleton';
import { toast } from '../shared/components/Toast';
import { playlistImporter } from '../modules/music/playlistImporter';
import type { ImportReport } from '../modules/music/playlistImporter';

export default function PlaylistPage() {
  const { playlists, addPlaylist, removePlaylist, renamePlaylist, isImporting, lastImportReport, importPlaylistFromUrl, clearLastImportReport, currentPlaylistSongs, loadPlaylistSongs } = usePlaylistStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [isLoading] = useState(false);

  // v14 歌单导入 UI 状态
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const selectedId = searchParams.get('id');
  const selectedPlaylist = playlists.find((p) => p.id === selectedId);

  const closeImport = () => {
    setShowImport(false);
    setImportUrl('');
    setImportError(null);
    clearLastImportReport();
  };

  const handleImport = async () => {
    const url = importUrl.trim();
    if (!url) {
      setImportError('请粘贴歌单链接');
      return;
    }
    if (!playlistImporter.isSupported(url)) {
      setImportError('暂不支持此歌单链接格式（目前支持：QQ音乐、网易云、酷狗、酷我、咪咕）');
      return;
    }
    setImportError(null);
    try {
      const report = await importPlaylistFromUrl(url);
      const ok = report.match.matched + report.match.fallback;
      const total = report.match.total;
      toast.success(
        `已导入「${report.sourcePlaylist.name}」`,
        `${ok}/${total} 首可播放${report.match.failed > 0 ? `，${report.match.failed} 首全平台暂无版权` : ''}`
      );
      // 不立即关闭 modal，让用户查看导入报告
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setImportError(msg);
      toast.error('导入失败', msg);
    }
  };

  // 歌单详情视图
  if (selectedPlaylist) {
    return <PlaylistDetailView playlistId={selectedPlaylist.id} playlistName={selectedPlaylist.name} onBack={() => setSearchParams({})} />;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-light text-[var(--text-primary)]">我的歌单</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)} className="yinliu-btn-secondary flex items-center gap-2">
            <Link2 className="w-4 h-4" />
            导入歌单
          </button>
          <button onClick={() => setShowCreate(true)} className="yinliu-btn flex items-center gap-2">
            <Plus className="w-4 h-4" />
            新建歌单
          </button>
        </div>
      </div>

      {/* Create Playlist Modal */}
      {showCreate && (
        <div className="yinliu-card mb-6">
          <h3 className="font-semibold mb-4 text-[var(--text-primary)]">新建歌单</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="歌单名称"
              className="yinliu-input flex-1"
              autoFocus
            />
            <button
              onClick={() => {
                if (newName.trim()) {
                  addPlaylist(newName.trim());
                  setNewName('');
                  setShowCreate(false);
                }
              }}
              className="yinliu-btn"
            >
              创建
            </button>
            <button onClick={() => setShowCreate(false)} className="yinliu-btn-secondary">
              取消
            </button>
          </div>
        </div>
      )}

      {/* v14: Import Playlist Modal */}
      {showImport && (
        <div className="yinliu-card mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-[var(--text-primary)]">导入外部歌单</h3>
            <button
              onClick={closeImport}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-[var(--text-tertiary)] block mb-1.5">
                歌单链接（支持 QQ 音乐 / 网易云 / 酷狗 / 酷我 / 咪咕）
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={importUrl}
                  onChange={(e) => { setImportUrl(e.target.value); setImportError(null); }}
                  placeholder="https://music.163.com/playlist?id=xxx"
                  className="yinliu-input flex-1"
                  disabled={isImporting}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isImporting) handleImport();
                  }}
                />
                <button
                  onClick={handleImport}
                  disabled={isImporting || !importUrl.trim()}
                  className="yinliu-btn flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      解析中…
                    </>
                  ) : (
                    <>
                      <Link2 className="w-4 h-4" />
                      导入
                    </>
                  )}
                </button>
              </div>
            </div>

            {importError && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{importError}</span>
              </div>
            )}

            {isImporting && !lastImportReport && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-sm">
                <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                <span>正在拉取歌单并匹配可播放平台，请稍候（每首曲目都要试取链）…</span>
              </div>
            )}

            {lastImportReport && <ImportReportView report={lastImportReport} onClose={closeImport} />}
          </div>
        </div>
      )}

      {/* Skeleton Loading */}
      {isLoading && (
        <SkeletonPlaylistGrid count={4} />
      )}

      {/* Playlist Grid */}
      {!isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className="group relative rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] overflow-hidden hover:border-[var(--accent)]/30 transition-all duration-200"
            >
              <a href={`/playlists?id=${pl.id}`} className="block">
                <div className="aspect-square bg-[var(--bg-tertiary)] flex items-center justify-center">
                  <ListMusic className="w-12 h-12 text-[var(--text-tertiary)]" />
                </div>
                <div className="p-4">
                  {editingId === pl.id ? (
                    <div className="flex gap-1">
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="yinliu-input text-sm py-1 px-2 flex-1"
                        autoFocus
                        onBlur={() => {
                          if (editName.trim()) renamePlaylist(pl.id, editName.trim());
                          setEditingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (editName.trim()) renamePlaylist(pl.id, editName.trim());
                            setEditingId(null);
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <h3 className="font-medium truncate text-[var(--text-primary)]">{pl.name}</h3>
                  )}
                  <p className="text-xs text-[var(--text-tertiary)] mt-1">{pl.songCount} 首歌曲</p>
                </div>
              </a>

              {/* Actions */}
              {!pl.id.startsWith('sys_') && editingId !== pl.id && (
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingId(pl.id); setEditName(pl.name); }}
                    className="p-1.5 rounded-xl bg-black/40 text-white hover:bg-black/60 backdrop-blur-sm transition-colors focus-ring"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => removePlaylist(pl.id)}
                    className="p-1.5 rounded-xl bg-black/40 text-white hover:bg-red-500/70 backdrop-blur-sm transition-colors focus-ring"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Play button */}
              <button className="absolute bottom-16 right-3 p-2.5 rounded-full bg-[var(--accent)] text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--accent-hover)] active:scale-95 focus-ring">
                <Play className="w-4 h-4 ml-0.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 导入结果报告：显示成功/降级/失败的统计
 */
function ImportReportView({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const { match, sourcePlaylist, playlistId } = report;
  const ok = match.matched + match.fallback;

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
        <CheckCircle2 className="w-4 h-4 text-green-500" />
        导入完成
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-[var(--bg-secondary)] py-2">
          <div className="text-base font-semibold text-green-600 dark:text-green-400">{match.matched}</div>
          <div className="text-[var(--text-tertiary)] mt-0.5">原平台</div>
        </div>
        <div className="rounded-lg bg-[var(--bg-secondary)] py-2">
          <div className="text-base font-semibold text-[var(--accent)]">{match.fallback}</div>
          <div className="text-[var(--text-tertiary)] mt-0.5">跨平台匹配</div>
        </div>
        <div className="rounded-lg bg-[var(--bg-secondary)] py-2">
          <div className="text-base font-semibold text-zinc-500">{match.failed}</div>
          <div className="text-[var(--text-tertiary)] mt-0.5">暂不可播放</div>
        </div>
      </div>
      <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
        共解析 <b className="text-[var(--text-primary)]">{match.total}</b> 首曲目；
        其中 <b className="text-green-600 dark:text-green-400">{ok}</b> 首已按取链优先级匹配到可播放平台并入库。
        {match.failed > 0 && (
          <span>未入库的 {match.failed} 首因全平台暂无版权或元数据缺失，UI 中将标灰显示。</span>
        )}
      </p>

      {/* 失败原因分布（最多展示 3 条） */}
      {match.failed > 0 && Object.keys(match.failureReasons).length > 0 && (
        <div className="text-xs space-y-1">
          <div className="text-[var(--text-tertiary)]">失败原因：</div>
          {Object.entries(match.failureReasons).slice(0, 3).map(([reason, count]) => (
            <div key={reason} className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <Music2 className="w-3 h-3 text-zinc-500" />
              <span>{reason}</span>
              <span className="text-[var(--text-tertiary)]">×{count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <a href={`/playlists?id=${playlistId}`} className="yinliu-btn text-xs flex-1 text-center">
          打开歌单
        </a>
        <button onClick={onClose} className="yinliu-btn-secondary text-xs">
          关闭
        </button>
      </div>
    </div>
  );
}

/**
 * 歌单详情视图：展示曲目列表，failed 标灰 + 显示原因
 */
function PlaylistDetailView({ playlistId, playlistName, onBack }: { playlistId: string; playlistName: string; onBack: () => void }) {
  const { currentPlaylistSongs, loadPlaylistSongs, removeSongFromPlaylist, addSongToPlaylist, isLoading } = usePlaylistStore();
  const [filter, setFilter] = useState<'all' | 'playable' | 'failed'>('all');

  // 加载歌单歌曲
  if (currentPlaylistSongs.length === 0 && !isLoading) {
    loadPlaylistSongs(playlistId);
  }

  const songs = currentPlaylistSongs;
  const failedCount = songs.filter((s) => s.matchStatus === 'failed').length;
  const playableCount = songs.length - failedCount;

  const visible = filter === 'playable'
    ? songs.filter((s) => s.matchStatus !== 'failed')
    : filter === 'failed'
    ? songs.filter((s) => s.matchStatus === 'failed')
    : songs;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors" aria-label="返回">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-light text-[var(--text-primary)] truncate">{playlistName}</h1>
          <p className="text-xs text-[var(--text-tertiary)] mt-1">
            共 {songs.length} 首 · 可播放 {playableCount} · 失败 {failedCount}
          </p>
        </div>
      </div>

      {/* 过滤标签 */}
      {failedCount > 0 && (
        <div className="flex gap-1.5 mb-4 text-xs">
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>全部 {songs.length}</FilterTab>
          <FilterTab active={filter === 'playable'} onClick={() => setFilter('playable')}>可播放 {playableCount}</FilterTab>
          <FilterTab active={filter === 'failed'} onClick={() => setFilter('failed')}>暂不可播放 {failedCount}</FilterTab>
        </div>
      )}

      {songs.length === 0 && isLoading && (
        <div className="text-center py-12 text-[var(--text-tertiary)] text-sm">加载中…</div>
      )}

      {songs.length === 0 && !isLoading && (
        <div className="text-center py-16 text-[var(--text-tertiary)]">
          <ListMusic className="w-12 h-12 mx-auto mb-2 opacity-40" />
          <p className="text-sm">歌单暂无曲目</p>
        </div>
      )}

      {songs.length > 0 && (
        <div className="space-y-1">
          {visible.map((s, i) => {
            const isFailed = s.matchStatus === 'failed';
            const isFallback = s.matchStatus === 'fallback';
            return (
              <div
                key={`${s.songId}_${i}`}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl group transition-colors ${
                  isFailed
                    ? 'bg-zinc-500/5 opacity-60'
                    : 'hover:bg-[var(--bg-tertiary)]'
                }`}
                title={isFailed ? s.failureReason : undefined}
              >
                <div className="w-8 h-8 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center flex-shrink-0">
                  {isFailed ? (
                    <AlertCircle className="w-4 h-4 text-zinc-500" />
                  ) : isFallback ? (
                    <CloudDownload className="w-4 h-4 text-[var(--accent)]" />
                  ) : (
                    <Music2 className="w-4 h-4 text-[var(--text-tertiary)]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate ${isFailed ? 'text-zinc-500 line-through' : 'text-[var(--text-primary)]'}`}>
                    {s.title}
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)] truncate flex items-center gap-1.5">
                    <span>{s.artist || '未知歌手'}</span>
                    {s.duration && s.duration > 0 && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-0.5">
                          <Clock className="w-2.5 h-2.5" />
                          {formatDuration(s.duration)}
                        </span>
                      </>
                    )}
                    {isFallback && (
                      <span className="text-[var(--accent)]">· 跨平台匹配</span>
                    )}
                    {isFailed && s.failureReason && (
                      <span className="text-zinc-500">· {s.failureReason}</span>
                    )}
                  </div>
                </div>
                {!isFailed && (
                  <button
                    onClick={() => addSongToPlaylist(playlistId, {
                      songId: s.songId,
                      title: s.title,
                      artist: s.artist,
                      album: s.album,
                      duration: s.duration ?? 0,
                      coverUrl: s.coverUrl,
                      source: s.source,
                      quality: s.quality,
                    })}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all"
                    aria-label="收藏"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => removeSongFromPlaylist(playlistId, s.songId)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-red-500 transition-all"
                  aria-label="移除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full transition-colors ${
        active
          ? 'bg-[var(--accent)] text-white'
          : 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
