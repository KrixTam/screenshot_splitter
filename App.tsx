
import React, { useState, useRef } from 'react';
import { 
  Upload, Scissors, RefreshCw, Download, Image as ImageIcon, 
  FileStack, LayoutDashboard, Layers, Settings2, Percent, Save, FolderOpen, 
  Sparkles, ListTree, CheckCircle2, FileJson, X, Archive
} from 'lucide-react';
import { SplitBlock, BackupData, BoundingBox } from './types';
import { detectPixelBlocks, getCropDataUrl, exportAnnotatedImage } from './utils/imageProcessing';
import { getSemanticRefinement, RefinementMapping } from './services/openai';

type Tab = 'split' | 'refined';

const LLM_BATCH = parseInt(process.env.LLM_BATCH || '5');
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '4');

export default function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [exportingPreview, setExportingPreview] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  
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

  // 日志查看状态
  const [showLogs, setShowLogs] = useState(false);
  const [semanticLog, setSemanticLog] = useState<any>(null);
  
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
    setSemanticLog(null);
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

  const handleRefine = async () => {
    if (blocks.length === 0 || !originalImage) return;
    setRefining(true);
    setError(null);
    try {
      const img = new Image();
      img.src = originalImage;
      await new Promise((resolve) => { img.onload = resolve; });

      // Step 1: 调用 AI 分析逻辑与映射
      const refinementData: RefinementMapping = await getSemanticRefinement(originalImage, blocks.length);
      setSemanticLog(refinementData); // 保存日志

      // Step 2: 根据映射合并内容块（自动合并期间的无效部分）
      const newRefinedBlocks: SplitBlock[] = [];
      const usedPixelIndices = new Set<number>();

      refinementData.mapping.forEach(mapItem => {
        const indices = mapItem.original_block_indices
          .map(idx => idx - 1)
          .filter(idx => idx >= 0 && idx < blocks.length);
        
        if (indices.length === 0) return;

        indices.forEach(idx => usedPixelIndices.add(idx));

        const sortedIndices = [...indices].sort((a, b) => a - b);
        const startIdx = sortedIndices[0];
        const endIdx = sortedIndices[sortedIndices.length - 1];

        // 合并边界
        const ymin = blocks[startIdx].box.ymin;
        const ymax = blocks[endIdx].box.ymax;

        const mergedBox: BoundingBox = {
          ymin,
          xmin: 0,
          ymax,
          xmax: 1000
        };

        const desc = refinementData.result.find(r => r.sn === mapItem.sn)?.description || `逻辑块 ${mapItem.sn}`;

        newRefinedBlocks.push({
          id: `refined-${Date.now()}-${mapItem.sn}`,
          label: desc,
          box: mergedBox,
          dataUrl: getCropDataUrl(img, mergedBox),
          source: 'refined'
        });
      });

      // 未被映射的原始像素块原样保留
      blocks.forEach((block, idx) => {
        if (!usedPixelIndices.has(idx)) {
          newRefinedBlocks.push({
            ...block,
            id: `refined-raw-${idx}`,
            label: `内容块 ${idx + 1} (未映射)`,
            source: 'refined'
          });
        }
      });

      newRefinedBlocks.sort((a, b) => a.box.ymin - b.box.ymin);
      setRefinedBlocks(newRefinedBlocks);
      setActiveTab('refined');

      // 计算梳理度
      const totalArea = 1000;
      const refinedValidArea = newRefinedBlocks.reduce((sum, b) => sum + (b.box.ymax - b.box.ymin), 0);
      const getUntouchedArea = (list: SplitBlock[]) => {
        return list.reduce((sum, s) => {
          const isSwallowed = newRefinedBlocks.some(r => s.box.ymin >= r.box.ymin - 0.1 && s.box.ymax <= r.box.ymax + 0.1);
          return isSwallowed ? sum : sum + (s.box.ymax - s.box.ymin);
        }, 0);
      };
      const rc = Math.min(100, Math.round(((refinedValidArea + getUntouchedArea(invalidBlocks) + getUntouchedArea(separators)) / totalArea) * 100));
      setRefinementCompleteness(rc);

    } catch (err: any) {
      console.error(err);
      setError("语义梳理失败，请检查网络重试。");
    } finally {
      setRefining(false);
    }
  };

  const downloadAsZip = async (targetBlocks: SplitBlock[]) => {
    if (targetBlocks.length === 0) return;
    setIsZipping(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const prefix = activeTab === 'split' ? 'pixel_block' : 'semantic_block';
      
      for (let i = 0; i < targetBlocks.length; i++) {
        const block = targetBlocks[i];
        if (block.dataUrl) {
          const base64Data = block.dataUrl.split(',')[1];
          zip.file(`${prefix}_${i + 1}.png`, base64Data, { base64: true });
        }
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}_results.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("ZIP creation failed:", err);
      setError("打包下载失败。");
    } finally {
      setIsZipping(false);
    }
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
      version: "4.7",
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
    link.download = `backup_${new Date().getTime()}.json`;
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
        }
        setError(null);
      } catch (err) {
        setError("从备份恢复失败：文件格式可能不兼容或已损坏。");
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
            {semanticLog && (
              <button 
                onClick={() => setShowLogs(true)}
                className="text-sm font-bold text-slate-400 hover:text-brand flex items-center gap-1.5 px-3 py-2 rounded-lg transition-all"
              >
                <FileJson className="w-4 h-4" /> 日志查看
              </button>
            )}
            {originalImage && (
              <button onClick={reset} className="text-sm font-bold text-slate-400 hover:text-brand flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-brand-light transition-all">
                <RefreshCw className="w-4 h-4" /> <span className="hidden sm:inline">重新上传</span>
              </button>
            )}
            <button onClick={() => restoreInputRef.current?.click()} className="text-sm font-bold text-slate-400 hover:text-brand flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-brand-light transition-all">
              <FolderOpen className="w-4 h-4" /> <span className="hidden sm:inline">恢复备份</span>
            </button>
          </div>
        </div>
      </header>

      {showLogs && (
        <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
            <div className="p-8 border-b flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <FileJson className="w-6 h-6 text-brand" />
                <h3 className="text-xl font-black text-slate-800">语义梳理日志 (Step 1 输出)</h3>
              </div>
              <button onClick={() => setShowLogs(false)} className="p-2 hover:bg-slate-200 rounded-full transition-all">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <div className="p-8 overflow-y-auto no-scrollbar font-mono text-sm">
              <pre className="bg-slate-900 text-brand-light p-6 rounded-2xl overflow-x-auto">
                {JSON.stringify(semanticLog, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}

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
              <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="image/*" />
            </div>
          </div>
        ) : (
          <div className="space-y-10">
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <div className="xl:col-span-2 bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col justify-between gap-8">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-black text-slate-800">结构分析工作流</h2>
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
                  <button onClick={processImage} disabled={analyzing} className="flex-1 py-5 bg-violet-600 hover:bg-violet-700 text-white rounded-2xl font-black flex items-center justify-center gap-3 shadow-lg transition-all">
                    {analyzing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
                    {analyzing ? "处理中..." : "像素级拆解"}
                  </button>
                  {blocks.length > 0 && (
                    <button onClick={handleRefine} disabled={refining} className="flex-1 py-5 bg-brand hover:bg-brand-dark text-white rounded-2xl font-black flex items-center justify-center gap-3 shadow-lg transition-all">
                      {refining ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                      {refining ? "AI 分析中..." : "语义智能梳理"}
                    </button>
                  )}
                  {blocks.length > 0 && (
                    <button onClick={handleBackup} className="px-8 py-5 bg-white border-2 border-slate-100 text-slate-600 hover:bg-slate-50 rounded-2xl font-black flex items-center justify-center gap-3 transition-all">
                      <Save className="w-5 h-5 text-brand" /> 备份
                    </button>
                  )}
                </div>
              </div>

              <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 flex flex-col gap-6">
                <div className="flex items-center gap-3 text-slate-800 font-black">
                  <Settings2 className="w-5 h-5 text-brand" />
                  <span>参数设置</span>
                </div>
                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex justify-between text-xs font-black text-slate-500 uppercase">
                      <span>无效判定阈值</span>
                      <span className="text-brand-dark">{invalidThreshold}%</span>
                    </div>
                    <input 
                      type="range" min="80" max="99" step="1" value={invalidThreshold} 
                      onChange={(e) => setInvalidThreshold(parseInt(e.target.value))} 
                      onInput={(e) => setInvalidThreshold(parseInt((e.target as HTMLInputElement).value))}
                      style={{ '--range-progress': `${((invalidThreshold - 80) / (99 - 80)) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-xs font-black text-slate-500 uppercase">
                      <span>最小高度比例</span>
                      <span className="text-brand-dark">{minBlockRatio.toFixed(1)}%</span>
                    </div>
                    <input 
                      type="range" min="0.1" max="5.0" step="0.1" value={minBlockRatio}
                      onChange={(e) => setMinBlockRatio(parseFloat(e.target.value))} 
                      onInput={(e) => setMinBlockRatio(parseFloat((e.target as HTMLInputElement).value))}
                      style={{ '--range-progress': `${((minBlockRatio - 0.1) / (5.0 - 0.1)) * 100}%` } as React.CSSProperties}
                    />
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border-2 border-red-100 p-6 rounded-[2rem] text-red-600 font-bold flex items-center gap-3">
                <LayoutDashboard className="w-5 h-5" /> {error}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
              <div className="lg:col-span-5">
                <div className="bg-white p-6 rounded-[2.5rem] shadow-xl border border-slate-100 sticky top-28">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2">
                      <ImageIcon className="w-4 h-4" /> 预览分析图
                    </h3>
                    {currentList.length > 0 && (
                      <button onClick={handleExportAnnotated} className="text-[10px] font-black bg-slate-100 px-3 py-1.5 rounded-lg transition-all">
                        {exportingPreview ? <RefreshCw className="w-3 h-3 animate-spin" /> : "导出标注图"}
                      </button>
                    )}
                  </div>
                  <div className="relative rounded-3xl overflow-hidden bg-slate-100 ring-8 ring-slate-50">
                    <img src={originalImage} alt="Original" className="w-full h-auto" />
                    {currentList.map((block, i) => (
                      <div key={block.id} className={`absolute border-2 flex items-start justify-end p-1 pointer-events-none transition-all ${activeTab === 'split' ? 'border-brand/50 bg-brand/5' : 'border-purple-500/50 bg-purple-500/5'}`} 
                        style={{ 
                          top: `${block.box.ymin/10}%`, left: `${block.box.xmin/10}%`, 
                          width: `${(block.box.xmax - block.box.xmin)/10}%`, 
                          height: `${(block.box.ymax - block.box.ymin)/10}%` 
                        }}>
                        <span className={`text-white text-[10px] px-2 py-0.5 rounded-lg font-black shadow-lg ${activeTab === 'split' ? 'bg-brand' : 'bg-purple-500'}`}>{i + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 space-y-8">
                <div className="flex items-center p-2 bg-slate-200/40 rounded-[2rem] border border-slate-200">
                  <button onClick={() => setActiveTab('split')} className={`flex-1 py-4 rounded-[1.5rem] text-sm font-black flex items-center justify-center gap-3 transition-all ${activeTab === 'split' ? 'bg-white text-slate-800 shadow-xl' : 'text-slate-400'}`}>
                    <FileStack className="w-5 h-5" /> 拆解结果 ({blocks.length})
                  </button>
                  <button onClick={() => setActiveTab('refined')} disabled={refinedBlocks.length === 0} className={`flex-1 py-4 rounded-[1.5rem] text-sm font-black flex items-center justify-center gap-3 transition-all ${activeTab === 'refined' ? 'bg-white text-purple-600 shadow-xl' : 'text-slate-400 disabled:opacity-30'}`}>
                    <Sparkles className="w-5 h-5" /> 梳理结果 ({refinedBlocks.length})
                  </button>
                </div>

                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                    {activeTab === 'split' ? '物理区块序列' : '语义梳理序列'}
                  </h3>
                  {currentList.length > 0 && (
                    <button 
                      onClick={() => downloadAsZip(currentList)} 
                      disabled={isZipping}
                      className="text-xs font-black text-brand bg-brand-light px-4 py-2 rounded-xl flex items-center gap-2 hover:bg-brand hover:text-white transition-all shadow-sm"
                    >
                      {isZipping ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                      {isZipping ? "打包中..." : "打包下载 ZIP"}
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
                            <span className="truncate max-w-[150px]">{block.label}</span>
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
                    <p className="text-lg font-black opacity-30">等待指令</p>
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
