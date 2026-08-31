import { useState } from 'react';
import { Plus, Trash2, Edit3, ListMusic, Play } from 'lucide-react';
import { usePlaylistStore } from '../shared/store/playlistStore';
import { useSearchParams } from 'react-router-dom';
import { SkeletonPlaylistGrid } from '../components/ui/Skeleton';

export default function PlaylistPage() {
  const { playlists, addPlaylist, removePlaylist, renamePlaylist } = usePlaylistStore();
  const [searchParams] = useSearchParams();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [isLoading] = useState(false);

  const selectedId = searchParams.get('id');
  const selectedPlaylist = playlists.find((p) => p.id === selectedId);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-light text-[var(--text-primary)]">{selectedPlaylist ? selectedPlaylist.name : '我的歌单'}</h1>
        <button onClick={() => setShowCreate(true)} className="yinliu-btn flex items-center gap-2">
          <Plus className="w-4 h-4" />
          新建歌单
        </button>
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
