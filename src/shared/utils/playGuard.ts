import { toast } from '../components/Toast';
import { getIsOnline } from '../hooks/useNetworkStatus';
import { downloadEngine } from '../../core/download';

interface PlayGuardTrack {
  sourceId?: string;
  sourceSongId?: string;
}

/**
 * 播放前断网守卫（E1）：
 * - 在线状态：放行；
 * - 断网状态：本地歌曲 / 已下载完成的歌曲放行（引擎走本地文件分支）；
 *   在线曲目直接拦截并给出明确提示，不再静默失败或长时间挂起。
 * 返回 false 表示已拦截，调用方不应继续发起 playTrack。
 */
export function allowPlayWhenOffline(track: PlayGuardTrack): boolean {
  if (getIsOnline()) return true;
  // 数据不全时不拦截，交由播放引擎按其既有链路处理
  if (!track.sourceId) return true;
  if (track.sourceId === 'local') return true;
  if (track.sourceSongId) {
    const downloaded = downloadEngine
      .getTasks()
      .some(
        (t) =>
          t.sourceId === track.sourceId &&
          t.songId === track.sourceSongId &&
          t.status === 'completed' &&
          !!t.filePath,
      );
    if (downloaded) return true;
  }
  toast.error('当前无网络连接', '离线状态下仅可播放本地或已下载歌曲');
  return false;
}
