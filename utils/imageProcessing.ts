
import { BoundingBox, SplitBlock } from "../types";

function getFuzzyColorKey(r: number, g: number, b: number): string {
  const bucket = 8;
  const br = Math.floor(r / bucket) * bucket;
  const bg = Math.floor(g / bucket) * bucket;
  const bb = Math.floor(b / bucket) * bucket;
  return `${br},${bg},${bb}`;
}

/**
 * 像素级拆解 - 返回完整的所有区块信息
 */
export async function detectPixelBlocks(
  img: HTMLImageElement, 
  invalidThreshold: number = 0.97,
  minHeightRatio: number = 0.002
): Promise<{ 
  blocks: SplitBlock[], 
  invalidBlocks: SplitBlock[], 
  separators: SplitBlock[], 
  coverage: number 
}> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { blocks: [], invalidBlocks: [], separators: [], coverage: 0 };

  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;

  const minHeightPx = height * minHeightRatio;
  const isSeparatorRow = new Array(height).fill(false);
  const separatorThreshold = Math.max(0.90, invalidThreshold - 0.05); 

  for (let y = 0; y < height; y++) {
    const colorCounts: Record<string, number> = {};
    let maxCount = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const key = getFuzzyColorKey(data[idx], data[idx + 1], data[idx + 2]);
      colorCounts[key] = (colorCounts[key] || 0) + 1;
      if (colorCounts[key] > maxCount) maxCount = colorCounts[key];
    }
    if (maxCount / width >= separatorThreshold) {
      isSeparatorRow[y] = true;
    }
  }

  const validBlocks: SplitBlock[] = [];
  const invalidBlocks: SplitBlock[] = [];
  const separators: SplitBlock[] = [];

  let startY = 0;
  let inSeparator = isSeparatorRow[0];

  for (let y = 1; y <= height; y++) {
    const isEnd = y === height;
    const rowIsSeparator = isEnd ? !inSeparator : isSeparatorRow[y];

    if (rowIsSeparator !== inSeparator || isEnd) {
      const blockHeight = y - startY;
      const box = {
        ymin: (startY / height) * 1000,
        xmin: 0,
        ymax: (y / height) * 1000,
        xmax: 1000
      };

      if (inSeparator) {
        separators.push({
          id: `sep-${Date.now()}-${separators.length}`,
          label: `分割区 ${separators.length + 1}`,
          source: 'separator',
          box
        });
      } else {
        if (blockHeight >= minHeightPx && isBlockValid(data, width, startY, y, invalidThreshold)) {
          validBlocks.push({
            id: `block-${Date.now()}-${validBlocks.length}`,
            label: `内容区块 ${validBlocks.length + 1}`,
            source: 'pixel',
            box
          });
        } else {
          invalidBlocks.push({
            id: `invalid-${Date.now()}-${invalidBlocks.length}`,
            label: `无效区块 ${invalidBlocks.length + 1}`,
            source: 'invalid',
            box
          });
        }
      }
      startY = y;
      inSeparator = rowIsSeparator;
    }
  }

  const totalEffectiveH = validBlocks.reduce((acc, b) => acc + (b.box.ymax - b.box.ymin), 0);
  const totalInvalidH = invalidBlocks.reduce((acc, b) => acc + (b.box.ymax - b.box.ymin), 0);
  const totalSepH = separators.reduce((acc, b) => acc + (b.box.ymax - b.box.ymin), 0);
  const coverage = Math.round(((totalEffectiveH + totalInvalidH + totalSepH) / 1000) * 100);

  return { blocks: validBlocks, invalidBlocks, separators, coverage: Math.min(coverage, 100) };
}

function isBlockValid(data: Uint8ClampedArray, width: number, y1: number, y2: number, threshold: number): boolean {
  const colorCounts: Record<string, number> = {};
  let maxCount = 0;
  let totalSamples = 0;
  const blockHeight = y2 - y1;
  const step = blockHeight < 50 ? 1 : 2;
  for (let y = y1; y < y2; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const key = getFuzzyColorKey(data[idx], data[idx + 1], data[idx + 2]);
      colorCounts[key] = (colorCounts[key] || 0) + 1;
      if (colorCounts[key] > maxCount) maxCount = colorCounts[key];
      totalSamples++;
    }
  }
  return maxCount / totalSamples < threshold;
}

export function getCropDataUrl(img: HTMLImageElement, box: BoundingBox): string {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const bx = (box.xmin / 1000) * img.width;
  const by = (box.ymin / 1000) * img.height;
  const bw = ((box.xmax - box.xmin) / 1000) * img.width;
  const bh = ((box.ymax - box.ymin) / 1000) * img.height;
  canvas.width = Math.max(1, bw);
  canvas.height = Math.max(1, bh);
  ctx.drawImage(img, bx, by, bw, bh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/**
 * 本地化实现：将标注绘制在图片上并导出
 * 替代 html2canvas-pro，不依赖 CDN
 */
export async function exportAnnotatedImage(
  originalImgUrl: string,
  blocks: SplitBlock[],
  isRefined: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject("Canvas context error");

      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const color = isRefined ? '#8B5CF6' : '#BFA5FF'; // 梳理用紫色，拆解用品牌色
      const overlayAlpha = 0.15;

      blocks.forEach((block, index) => {
        const box = block.box;
        const x = (box.xmin / 1000) * canvas.width;
        const y = (box.ymin / 1000) * canvas.height;
        const w = ((box.xmax - box.xmin) / 1000) * canvas.width;
        const h = ((box.ymax - box.ymin) / 1000) * canvas.height;

        // 绘制矩形填充
        ctx.fillStyle = `${color}${Math.floor(overlayAlpha * 255).toString(16).padStart(2, '0')}`;
        ctx.fillRect(x, y, w, h);

        // 绘制边框
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, canvas.width / 500);
        ctx.strokeRect(x, y, w, h);

        // 绘制标签背景
        const fontSize = Math.max(12, canvas.width / 40);
        const labelText = (index + 1).toString();
        ctx.font = `bold ${fontSize}px sans-serif`;
        const textMetrics = ctx.measureText(labelText);
        const padding = fontSize / 2;
        const labelW = textMetrics.width + padding * 2;
        const labelH = fontSize + padding;

        ctx.fillStyle = color;
        // 放在右上角
        const lx = x + w - labelW - padding/2;
        const ly = y + padding/2;
        
        // 绘制圆角标签背景 (简化为矩形)
        ctx.fillRect(lx, ly, labelW, labelH);

        // 绘制文字
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(labelText, lx + labelW / 2, ly + labelH / 2 + 1);
      });

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = originalImgUrl;
  });
}

export async function scaleImageBase64(dataUrl: string, maxWidth: number = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const src = dataUrl.startsWith('data:') ? dataUrl : `data:image/jpeg;base64,${dataUrl}`;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (img.width <= maxWidth) {
        resolve(src);
        return;
      }
      const scale = maxWidth / img.width;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(src);
        return;
      }
      canvas.width = Math.round(maxWidth);
      canvas.height = Math.round(img.height * scale);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const mime = src.split(';')[0].split(':')[1] || 'image/jpeg';
      const out = canvas.toDataURL(mime);
      resolve(out);
    };
    img.onerror = reject;
    img.src = src;
  });
}
