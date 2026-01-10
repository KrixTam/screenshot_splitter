
import { BoundingBox, SplitBlock } from "../types";

function getFuzzyColorKey(r: number, g: number, b: number): string {
  const bucket = 8;
  const br = Math.floor(r / bucket) * bucket;
  const bg = Math.floor(g / bucket) * bucket;
  const bb = Math.floor(b / bucket) * bucket;
  return `${br},${bg},${bb}`;
}

/**
 * 缩放 Base64 图片
 */
export async function scaleImageBase64(dataUrl: string, maxWidth: number = 1024): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxWidth) {
        resolve(dataUrl);
        return;
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      const scale = maxWidth / img.width;
      canvas.width = maxWidth;
      canvas.height = img.height * scale;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = dataUrl;
  });
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

  // 第一步：初步识别水平分割区
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
        // 第二步：使用增强逻辑判定区块是否包含有效内容
        if (blockHeight >= minHeightPx && isBlockMeaningful(ctx, width, startY, y, invalidThreshold)) {
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

/**
 * 核心逻辑：判定区块是否具有“意义”
 * 参考了用户提供的灰度方差、颜色数量及连通域分析
 */
function isBlockMeaningful(
  parentCtx: CanvasRenderingContext2D, 
  width: number, 
  y1: number, 
  y2: number, 
  threshold: number
): boolean {
  const blockHeight = y2 - y1;
  const blockData = parentCtx.getImageData(0, y1, width, blockHeight);
  const data = blockData.data;

  // 1. 唯一颜色计数
  const colorSet = new Set<string>();
  const pixelValues: number[] = [];
  const colorThresh = 20; // 颜色数阈值

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
    if (a === 0) continue;
    
    colorSet.add(`${r},${g},${b}`);
    const gray = Math.round((r + g + b) / 3);
    pixelValues.push(gray);
  }

  if (colorSet.size > colorThresh) return true;

  // 2. 灰度方差分析 (反映像素散布程度)
  const variance = calculateVariance(pixelValues);
  const varThresh = 100; // 方差阈值
  if (variance > varThresh) return true;

  // 3. 简化版连通通域分析 (CCA)
  // 为了性能，在大区块上执行 CCA 前先进行下采样
  const targetSize = 128; // 下采样目标尺寸
  const scale = Math.min(targetSize / width, targetSize / blockHeight);
  if (scale < 1) {
    const miniCanvas = document.createElement('canvas');
    miniCanvas.width = Math.floor(width * scale);
    miniCanvas.height = Math.floor(blockHeight * scale);
    const miniCtx = miniCanvas.getContext('2d');
    if (miniCtx) {
      // 临时绘制下采样图像
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = width;
      tmpCanvas.height = blockHeight;
      tmpCanvas.getContext('2d')?.putImageData(blockData, 0, 0);
      miniCtx.drawImage(tmpCanvas, 0, 0, miniCanvas.width, miniCanvas.height);
      const miniData = miniCtx.getImageData(0, 0, miniCanvas.width, miniCanvas.height);
      
      const { connCount, totalConnPixels } = calculateConnectedComponents(miniData);
      const areaRatio = totalConnPixels / (miniCanvas.width * miniCanvas.height);
      const connThresh = 50;
      const areaRatioThresh = 0.95;

      if (connCount > connThresh || areaRatio < areaRatioThresh) return true;
    }
  }

  return false; // 经过所有测试均通过（即：颜色单一、方差小、连通域单一），判定为无意义
}

function calculateVariance(arr: number[]): number {
  const len = arr.length;
  if (len === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / len;
  const squareDiffs = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0);
  return squareDiffs / len;
}

/**
 * 8邻域连通域算法 (BFS 实现)
 */
function calculateConnectedComponents(pixelData: ImageData) {
  const { width, height, data } = pixelData;
  const visited = new Uint8Array(width * height);
  let connCount = 0;
  let totalConnPixels = 0;

  const neighbors = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1]
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (data[idx * 4 + 3] === 0 || visited[idx]) continue;

      // 发现新通域，开始 BFS
      connCount++;
      let currentConnPixels = 0;
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift()!;
        currentConnPixels++;
        
        const cIdx = (cy * width + cx) * 4;
        const curGray = (data[cIdx] + data[cIdx+1] + data[cIdx+2]) / 3;

        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && data[nIdx * 4 + 3] > 0) {
              const nDataIdx = nIdx * 4;
              const neighGray = (data[nDataIdx] + data[nDataIdx+1] + data[nDataIdx+2]) / 3;
              // 灰度差 <= 5 视为同色块（容忍轻微色差）
              if (Math.abs(curGray - neighGray) <= 5) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }
      }
      totalConnPixels += currentConnPixels;
    }
  }

  return { connCount, totalConnPixels };
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
 * 将标注绘制在图片上并导出
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


