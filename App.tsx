
import React, { useState, useRef } from 'react';
import { 
  Upload, Scissors, RefreshCw, Download, Image as ImageIcon, 
  FileStack, LayoutDashboard, Layers, Settings2, Percent, Save, FolderOpen, 
  Sparkles, ListTree, CheckCircle2
} from 'lucide-react';
import { SplitBlock, BackupData, BoundingBox } from './types';
import { detectPixelBlocks, getCropDataUrl, exportAnnotatedImage } from './utils/imageProcessing';
import { checkRelevance } from './services/openai';

type Tab = 'split' | 'refined';

interface MergeItem {
  block: SplitBlock;
  wasMerged: boolean;
}

export default function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [exportingPreview, setExportingPreview] = useState(false);
  
  const [blocks, setBlocks] = useState<SplitBlock[]>([]);
  const [invalidBlocks, setInvalidBlocks] = useState<SplitBlock[]>([]);
  const [separators, setSeparators] = useState<SplitBlock[]>([]);
  const [refinedBlocks, setRefinedBlocks] = useState<SplitBlock[]>([]);
  
  const [completeness, setCompleteness] = useState<number>(0);
  const [refinementCompleteness, setRefinementCompleteness] = useState<number>(0);
  
  const [activeTab, setActiveTab] = useState<Tab>('split');
  const [error, setError] = useState<string | null>(null);
  
  const [invalidThreshold, setInvalidThreshold] = useState<number>(97);
  const [minBlockRatio, setMinBlockRatio] = useState<number>(0.2);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setOriginalImage(event.target?.result as string);
      resetInternalState();
      setError(null);
    };
    reader.readAsDataURL(file);
  };

  const resetInternalState = () => {
    setBlocks([]);
    setInvalidBlocks([]);
    setSeparators([]);
    setRefinedBlocks([]);
    setCompleteness(0);
    setRefinementCompleteness(0);
    setActiveTab('split');
  };

  const reset = () => {
    setOriginalImage(null);
    resetInternalState();
    setError(null);
  };

  const processImage = async () => {
    if (!originalImage) return;
    setAnalyzing(true);
    setError(null);
    try {
      const img = new Image();
      img.src = originalImage;
      await new Promise((resolve) => { img.onload = resolve; });
      
      const { blocks: b, invalidBlocks: ib, separators: s, coverage } = await detectPixelBlocks(img, invalidThreshold / 100, minBlockRatio / 100);
      
      const bWithImg = b.map(blk => ({ ...blk, dataUrl: getCropDataUrl(img, blk.box) }));
      setBlocks(bWithImg);
      setInvalidBlocks(ib);
      setSeparators(s);
      setCompleteness(coverage);
      setActiveTab('split');
      
      if (bWithImg.length === 0) setError("未发现明显的有效内容块。");
    } catch (err: any) {
      setError("物理拆解失败，请尝试调低阈值。");
    } finally {
      setAnalyzing(false);
    }
  };

  const mergeBoxes = (b1: BoundingBox, b2: BoundingBox): BoundingBox => ({
    ymin: Math.min(b1.ymin, b2.ymin),
    xmin: 0,
    ymax: Math.max(b1.ymax, b2.ymax),
    xmax: 1000
  });

  const handleRefine = async () => {
    if (blocks.length < 1 || !originalImage) return;
    setRefining(true);
    setError(null);
    try {
      const img = new Image();
      img.src = originalImage;
      await new Promise((resolve) => { img.onload = resolve; });

      // 第一阶段梳理：两两比对
      let resultsP1: MergeItem[] = [];
      let i = 0;
      while (i < blocks.length) {
        if (i < blocks.length - 1) {
          await new Promise(r => setTimeout(r, 100));
          const isRelated = await checkRelevance(blocks[i].dataUrl!, blocks[i + 1].dataUrl!);
          if (isRelated) {
            // 合并当前对，跳至下下个 (i+2)
            const mBox = mergeBoxes(blocks[i].box, blocks[i + 1].box);
            resultsP1.push({
              block: {
                id: `refined-p1-${i}-${Date.now()}`,
                label: `合并块`,
                box: mBox,
                dataUrl: getCropDataUrl(img, mBox),
                source: 'refined',
              },
              wasMerged: true
            });
            i += 2;
          } else {
            // 不相关，保留当前块，下一次比对 (i+1) 和 (i+2)
            resultsP1.push({ block: blocks[i], wasMerged: false });
            i += 1;
          }
        } else {
          // 最后一个孤立块
          resultsP1.push({ block: blocks[i], wasMerged: false });
          i += 1;
        }
      }

      // 第二阶段梳理：对孤立块尝试再次合并
      let finalStream: MergeItem[] = [...resultsP1];
      let k = 0;
      while (k < finalStream.length) {
        if (!finalStream[k].wasMerged) {
          await new Promise(r => setTimeout(r, 100));
          let mergedThisK = false;
          
          // 优先比对下方邻居
          if (k < finalStream.length - 1) {
            const isRelatedDown = await checkRelevance(finalStream[k].block.dataUrl!, finalStream[k+1].block.dataUrl!);
            if (isRelatedDown) {
              const mBox = mergeBoxes(finalStream[k].block.box, finalStream[k+1].block.box);
              const newBlock: SplitBlock = {
                id: `refined-p2-d-${k}-${Date.now()}`,
                label: `合并块`,
                box: mBox,
                dataUrl: getCropDataUrl(img, mBox),
                source: 'refined',
              };
              finalStream.splice(k, 2, { block: newBlock, wasMerged: true });
              mergedThisK = true;
            }
          }

          // 若下方没合上，再比对上方邻居
          if (!mergedThisK && k > 0) {
            const isRelatedUp = await checkRelevance(finalStream[k-1].block.dataUrl!, finalStream[k].block.dataUrl!);
            if (isRelatedUp) {
              const mBox = mergeBoxes(finalStream[k-1].block.box, finalStream[k].block.box);
              const newBlock: SplitBlock = {
                id: `refined-p2-u-${k}-${Date.now()}`,
                label: `合并块`,
                box: mBox,
                dataUrl: getCropDataUrl(img, mBox),
                source: 'refined',
              };
              finalStream.splice(k - 1, 2, { block: newBlock, wasMerged: true });
              k--; // 回退一步重新检查合并后的块
              mergedThisK = true;
            }
          }
          if (mergedThisK) continue;
        }
        k++;
      }

      const finalResult = finalStream.map((item, idx) => ({
        ...item.block,
        label: `梳理区块 ${idx + 1}`
      }));

      setRefinedBlocks(finalResult);
      setActiveTab('refined');
      
      // 指标计算：梳理度 = (梳理后的有效面积 + 剩余无效/分割面积) / 总面积
      const totalArea = 1000;
      const refinedValidArea = finalResult.reduce((sum, b) => sum + (b.box.ymax - b.box.ymin), 0);
      
      const getUntouchedArea = (sourceList: SplitBlock[]) => {
        return sourceList.reduce((sum, s) => {
          // 如果该原始块被包含在任何一个最终梳理块的范围内，则面积已被计算过
          const isSwallowed = finalResult.some(r => s.box.ymin >= r.box.ymin && s.box.ymax <= r.box.ymax);
          return isSwallowed ? sum : sum + (s.box.ymax - s.box.ymin);
        }, 0);
      };

      const remainingInvalidArea = getUntouchedArea(invalidBlocks);
      const remainingSepArea = getUntouchedArea(separators);
      const rc = Math.min(100, Math.round(((refinedValidArea + remainingInvalidArea + remainingSepArea) / totalArea) * 100));
      setRefinementCompleteness(rc);

    } catch (err: any) {
      console.error(err);
      setError("梳理拆解过程失败，请重试。");
    } finally {
      setRefining(false);
    }
  };

  const downloadAll = (targetBlocks: SplitBlock[]) => {
    targetBlocks.forEach((block, index) => {
      const link = document.createElement('a');
      link.href = block.dataUrl!;
      link.download = `${activeTab}_${index + 1}.png`;
      link.click();
    });
  };

  const handleExportAnnotated = async () => {
    if (!originalImage || currentList.length === 0) return;
    setExportingPreview(true);
    try {
      const dataUrl = await exportAnnotatedImage(originalImage, currentList, activeTab === 'refined');
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `preview_${activeTab}.png`;
      link.click();
    } catch (err) {
      setError("预览图导出失败。");
    } finally {
      setExportingPreview(false);
    }
  };

  const handleBackup = () => {
    if (!originalImage) return;
    const backupData: BackupData = {
      version: "4.5",
      timestamp: new Date().toISOString(),
      originalImage,
      config: { invalidThreshold, minBlockRatio },
      results: {
        blocks: blocks.map(({ dataUrl, ...rest }) => rest),
        invalidBlocks: invalidBlocks.map(({ dataUrl, ...rest }) => rest),
        separators: separators.map(({ dataUrl, ...rest }) => rest),
        completeness,
        refinedBlocks: refinedBlocks.map(({ dataUrl, ...rest }) => rest),
        refinementCompleteness
      }
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `splitter_backup_${new Date().getTime()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data: BackupData = JSON.parse(event.target?.result as string);
        const img = new Image();
        img.src = data.originalImage;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject("无法加载备份中的原始图片");
        });
        setInvalidThreshold(data.config.invalidThreshold);
        setMinBlockRatio(data.config.minBlockRatio);
        setOriginalImage(data.originalImage);
        const restoreWithCrops = (list: SplitBlock[]) => 
          list.map(b => ({ ...b, dataUrl: getCropDataUrl(img, b.box) }));
        setBlocks(restoreWithCrops(data.results.blocks));
        setInvalidBlocks(restoreWithCrops(data.results.invalidBlocks));
        setSeparators(restoreWithCrops(data.results.separators));
        setCompleteness(data.results.completeness);
        if (data.results.refinedBlocks) {
          setRefinedBlocks(restoreWithCrops(data.results.refinedBlocks));
          setRefinementCompleteness(data.results.refinementCompleteness || 0);
          setActiveTab('refined');
        } else {
          setRefinedBlocks([]);
          setRefinementCompleteness(0);
          setActiveTab('split');
        }
        setError(null);
      } catch (err: any) {
        console.error("Restore failed:", err);
        setError("从备份恢复失败：文件格式可能不兼容或已损坏。");
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const currentList = activeTab === 'split' ? blocks : refinedBlocks;

  return (
    <div className="min-h-screen font-sans pb-20">
      <input type="file" ref={restoreInputRef} onChange={handleRestore} className="hidden" accept=".json" />
      
      <header className="bg-white/90 backdrop-blur-md border-b sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-brand p-2 rounded-xl shadow-brand/30">
              <Scissors className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-black text-slate-800 tracking-tight">截图拆分助手</h1>
          </div>
          <div className="flex items-center gap-4">
            {originalImage && (
              <button onClick={reset} className="text-sm font-bold text-slate-400 hover:text-brand transition-all flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-brand-light">
                <RefreshCw className="w-4 h-4" /> <span className="hidden sm:inline">重新上传</span>
              </button>
            )}
            <button onClick={() => restoreInputRef.current?.click()} className={`text-sm font-bold text-slate-400 hover:text-brand transition-all flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-brand-light ${originalImage ? 'border-l pl-4' : ''}`}>
              <FolderOpen className="w-4 h-4" /> <span className="hidden sm:inline">从备份恢复</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        {!originalImage ? (
          <div className="flex flex-col items-center justify-center min-h-[70vh] text-center gap-8">
            <div 
              onClick={() => fileInputRef.current?.click()} 
              className="w-full max-w-2xl aspect-[16/9] border-4 border-dashed border-slate-200 rounded-[3rem] flex flex-col items-center justify-center bg-white hover:border-brand hover:bg-brand-light cursor-pointer transition-all group shadow-xl"
            >
              <div className="w-20 h-20 bg-brand-light rounded-3xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                <Upload className="w-10 h-10 text-brand" />
              </div>
              <h3 className="text-2xl font-black text-slate-700 mb-2">拖拽或点击上传长截图</h3>
              <p className="text-slate-400 font-medium">智能识别边界，多阶段语义合并</p>
              <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*" />
            </div>
          </div>
        ) : (
          <div className="space-y-10">
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <div className="xl:col-span-2 bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col justify-between gap-8">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-black text-slate-800">智能分析工作流</h2>
                    <p className="text-sm font-medium text-slate-400">结合像素扫描与多轮 AI 语义判定</p>
                  </div>
                  <div className="flex items-center gap-8 bg-slate-50 px-6 py-4 rounded-3xl border border-slate-100">
                    <div className="text-center">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">拆解度</p>
                      <p className={`text-2xl font-black ${completeness > 0 ? 'text-slate-700' : 'text-slate-200'}`}>{completeness}%</p>
                    </div>
                    {refinementCompleteness > 0 && (
                      <div className="text-center border-l pl-8 border-slate-200">
                        <p className="text-[10px] font-black text-purple-600 uppercase tracking-widest mb-1">梳理度</p>
                        <p className="text-2xl font-black text-purple-600">{refinementCompleteness}%</p>
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="flex flex-col sm:flex-row gap-4">
                  <button 
                    onClick={processImage} 
                    disabled={analyzing} 
                    className="flex-1 py-5 bg-violet-600 hover:bg-violet-700 text-white rounded-2xl font-black flex items-center justify-center gap-3 shadow-lg active:scale-95 transition-all"
                  >
                    {analyzing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
                    {analyzing ? "扫描中..." : "执行物理拆解"}
                  </button>
                  
                  {blocks.length >= 1 && (
                    <button 
                      onClick={handleRefine} 
                      disabled={refining} 
                      className="flex-1 py-5 bg-brand hover:bg-brand-dark text-white rounded-2xl font-black flex items-center justify-center gap-3 shadow-lg active:scale-95 transition-all"
                    >
                      {refining ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                      {refining ? "AI 梳理中..." : "语义智能梳理"}
                    </button>
                  )}

                  {blocks.length > 0 && (
                    <button 
                      onClick={handleBackup} 
                      className="px-8 py-5 bg-white border-2 border-slate-100 text-slate-600 hover:bg-slate-50 rounded-2xl font-black flex items-center justify-center gap-3 active:scale-95 transition-all"
                    >
                      <Save className="w-5 h-5 text-brand" /> 备份
                    </button>
                  )}
                </div>
              </div>

              <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col gap-6">
                <div className="flex items-center gap-3 text-slate-800 font-black">
                  <Settings2 className="w-5 h-5 text-brand" />
                  <span>分析参数</span>
                </div>
                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex justify-between text-xs font-black text-slate-500 uppercase">
                      <span>无效判定阈值</span>
                      <span className="text-brand-dark">{invalidThreshold}%</span>
                    </div>
                    <input 
                      type="range" 
                      min="80" 
                      max="99" 
                      step="1" 
                      value={invalidThreshold} 
                      onChange={(e) => setInvalidThreshold(parseInt(e.target.value))} 
                      className="accent-brand" 
                      style={{ '--range-progress': `${((invalidThreshold - 80) / (99 - 80)) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-xs font-black text-slate-500 uppercase">
                      <span>最小高度比例</span>
                      <span className="text-brand-dark">{minBlockRatio.toFixed(1)}%</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.1" 
                      max="5.0" 
                      step="0.1" 
                      value={minBlockRatio} 
                      onChange={(e) => setMinBlockRatio(parseFloat(e.target.value))} 
                      className="accent-brand" 
                      style={{ '--range-progress': `${((minBlockRatio - 0.1) / (5.0 - 0.1)) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border-2 border-red-100 p-6 rounded-[2rem] flex items-center gap-4 text-red-600 font-bold">
                <LayoutDashboard className="w-6 h-6 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
              <div className="lg:col-span-5">
                <div className="bg-white p-6 rounded-[2.5rem] shadow-xl border border-slate-100 sticky top-28">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                      <ImageIcon className="w-4 h-4" /> 预览分析图
                    </h3>
                    {currentList.length > 0 && (
                      <button onClick={handleExportAnnotated} className="text-[10px] font-black bg-slate-100 px-3 py-1.5 rounded-lg hover:bg-brand-light transition-all">
                        {exportingPreview ? <RefreshCw className="w-3 h-3 animate-spin" /> : "导出带标注图"}
                      </button>
                    )}
                  </div>
                  <div className="relative rounded-3xl overflow-hidden bg-slate-100 ring-8 ring-slate-50">
                    <img src={originalImage} alt="Original" className="w-full h-auto" />
                    {currentList.map((block, i) => (
                      <div 
                        key={block.id} 
                        className={`absolute border-2 flex items-start justify-end p-1 pointer-events-none transition-all duration-500 ${activeTab === 'split' ? 'border-brand/50 bg-brand/5' : 'border-purple-500/50 bg-purple-500/5'}`} 
                        style={{ 
                          top: `${block.box.ymin/10}%`, 
                          left: `${block.box.xmin/10}%`, 
                          width: `${(block.box.xmax - block.box.xmin)/10}%`, 
                          height: `${(block.box.ymax - block.box.ymin)/10}%` 
                        }}
                      >
                        <span className={`text-white text-[10px] px-2 py-0.5 rounded-lg font-black shadow-lg ${activeTab === 'split' ? 'bg-brand' : 'bg-purple-500'}`}>{i + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 space-y-8">
                <div className="flex items-center p-2 bg-slate-200/40 rounded-[2rem] border border-slate-200">
                  <button 
                    onClick={() => setActiveTab('split')} 
                    className={`flex-1 py-4 rounded-[1.5rem] text-sm font-black flex items-center justify-center gap-3 transition-all ${activeTab === 'split' ? 'bg-white text-slate-800 shadow-xl' : 'text-slate-400 hover:text-slate-600'}`}
                  >
                    <FileStack className="w-5 h-5" /> 拆解结果 ({blocks.length})
                  </button>
                  <button 
                    onClick={() => setActiveTab('refined')} 
                    disabled={refinedBlocks.length === 0} 
                    className={`flex-1 py-4 rounded-[1.5rem] text-sm font-black flex items-center justify-center gap-3 transition-all ${activeTab === 'refined' ? 'bg-white text-purple-600 shadow-xl' : 'text-slate-400 hover:text-slate-600 disabled:opacity-30'}`}
                  >
                    <Sparkles className="w-5 h-5" /> 梳理结果 ({refinedBlocks.length})
                  </button>
                </div>

                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                    {activeTab === 'split' ? '物理区块序列' : '语义梳理序列'}
                  </h3>
                  {currentList.length > 0 && (
                    <button onClick={() => downloadAll(currentList)} className="text-xs font-black text-brand bg-brand-light px-4 py-2 rounded-xl flex items-center gap-2">
                      <Download className="w-4 h-4" /> 批量下载
                    </button>
                  )}
                </div>

                {currentList.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-10">
                    {currentList.map((block, index) => (
                      <div key={block.id} className="bg-white rounded-[2rem] border border-slate-100 shadow-lg overflow-hidden flex flex-col hover:-translate-y-1 transition-all">
                        <div className="p-4 bg-slate-50 border-b flex items-center justify-between">
                          <span className="text-xs font-black text-slate-600 flex items-center gap-3">
                            <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] text-white ${activeTab === 'split' ? 'bg-brand' : 'bg-purple-500'}`}>{index + 1}</span>
                            {block.label}
                          </span>
                          <a href={block.dataUrl} download={`${activeTab}_${index+1}.png`} className="p-2 text-slate-400 hover:text-brand bg-white rounded-xl shadow-sm">
                            <Download className="w-4 h-4" />
                          </a>
                        </div>
                        <div className="p-6 flex-1 flex items-center justify-center bg-white min-h-[160px]">
                          <img src={block.dataUrl} alt={block.label} className="max-w-full max-h-[350px] object-contain rounded-xl border border-slate-50" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-80 rounded-[3rem] border-4 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-300 bg-white">
                    <ListTree className="w-16 h-16 mb-4 opacity-10" />
                    <p className="text-lg font-black opacity-30">等待分析指令</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
