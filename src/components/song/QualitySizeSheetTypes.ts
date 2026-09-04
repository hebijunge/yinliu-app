import type { QualityTier } from '../../core/types';

/** 下载弹窗内单个可选项（平台 × 音质档位） */
export interface OptionBlock {
  key: string; // sourceId:tier
  sourceId: string;
  sourceName: string;
  tier: QualityTier;
  sizeBytes?: number;
}
