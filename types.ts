
export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface SplitBlock {
  id: string;
  label: string;
  box: BoundingBox; // 始终存储相对于原图的坐标 [0-1000]
  dataUrl?: string;
  source: 'pixel' | 'ai' | 'refined' | 'invalid' | 'separator';
  parentId?: string;
}

export interface AnalysisResult {
  blocks: {
    label: string;
    box: BoundingBox;
  }[];
}

export interface BackupData {
  version: string;
  timestamp: string;
  originalImage: string;
  config: {
    invalidThreshold: number;
    minBlockRatio: number;
  };
  results: {
    blocks: SplitBlock[];      // 有效内容块元数据
    invalidBlocks: SplitBlock[]; // 无效内容块元数据
    separators: SplitBlock[];    // 分割区元数据
    completeness: number;
    refinedBlocks?: SplitBlock[]; // 梳理后的块元数据
    refinementCompleteness?: number;
  };
}
