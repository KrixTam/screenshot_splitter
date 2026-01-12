# 架构设计说明

本文档说明截图拆分助手的整体架构与关键处理流程，覆盖物理拆解、语义梳理、图像处理与 LLM 集成等内容。描述与代码实现保持一致，便于维护和扩展。

## 总览
- 输入：一张长截图（手机 UI）。
- 输出：
  - 物理拆解后的内容块、无效块、分割区，以及拆解度（completeness）。
  - 语义梳理后的内容块，以及梳理度（refinementCompleteness）。
- 关键环境变量：
  - API_KEY / OPENAI_API_KEY（任选其一）
  - OPENAI_BASE_URL、MODEL
  - JSON_SCHEMA（0/1，用于控制响应格式）

## 阶段一：物理拆解（像素级扫描）
- 入口：detectPixelBlocks(img, invalidThreshold, minHeightRatio)。
- 目标：基于每行主色占比识别水平分割线，并切分为区块。
- 主要逻辑：
  - 行扫描：逐行统计模糊主色占比，主色占比 ≥ 分割阈值（separatorThreshold = max(0.90, invalidThreshold - 0.05)）则判定为分割线。
  - 区块聚合与有效性判断：对非分割区进行聚合，并通过 isBlockMeaningful 做有效性判定：
    - 颜色多样性：唯一颜色计数 > 20 判定为有效；
    - 灰度方差：方差 > 100 判定为有效；
    - 连通域分析：下采样后做 8 邻域 BFS，若连通域数量 > 50 或覆盖率 < 0.95 判定为有效。
  - 输出：
    - blocks：有效内容块
    - invalidBlocks：无效块
    - separators：分割区
    - coverage：拆解度（0–100）
- 坐标归一化：所有 BoundingBox 坐标统一采用 0–1000 标尺，便于后续导出与恢复。

## 阶段二：语义梳理（三步链式）
梳理逻辑在 App.tsx 的 handleRefine 中实现，分三步：

### 步骤 1：原图语义结构分析（LLM）
- 在 services/openai.ts 的 getStructuralAnalysis 中实现。
- 输入：原始截图；输出：语义逻辑块列表（sn, description）。
- 规则：明确排除状态栏，强调标题-内容、工具栏/导航栏、敏感信息的合并准则。

### 步骤 2：标注预览映射（LLM）
- 在 services/openai.ts 的 getMappingAnalysis 中实现。
- 输入：通过 utils/exportAnnotatedImage 生成的标注预览图（带编号），以及步骤 1 的结果。
- 输出：每个语义块映射到的像素块编号数组（mapping）。
- 规则：必须依据可见编号进行映射；一个语义块通常对应多个像素块；状态栏不得映射。

### 步骤 3：坐标合并计算（本地）
- 在 App.tsx 的 handleRefine 中，依据 mapping 将对应像素块求并得到最终 BoundingBox。
- 结果排序：按 ymin 升序排列，生成 refinedBlocks 供 UI 展示与导出。
- 梳理度计算：基于映射成功的物理块数量与未映射块数量计算综合覆盖率。

## 图像缩放与稳定性
- 图像缩放：在每次 LLM 调用前通过 utils/scaleImageBase64 将图片统一缩放到宽度不超过 1024，降低带宽与时延。
- 稳定性重试：openai.ts 通过 withRetry 包装 LLM 调用，针对 429/5xx 等情况进行指数退避重试，并记录耗时与响应。

## 备份与恢复
- 备份（handleBackup）：保存原始图片、配置参数、各阶段结果以及归一化坐标，版本号当前为 5.6。
- 恢复（handleRestore）：按保存的归一化坐标对当前原图重新裁剪生成 dataUrl，确保清晰度与位置一致。

## 指标设计
- 拆解度（completeness）：物理拆解阶段中，有效块、无效块与分割区覆盖的总高度占比。
- 梳理度（refinementCompleteness）：在最终梳理结果基础上统计映射成功的物理块数量与未映射块数量的综合覆盖率。

## 配置清单
- API_KEY / OPENAI_API_KEY：OpenAI 或本地兼容服务的密钥。
- OPENAI_BASE_URL：可选，自定义 API 地址（支持 LM Studio / Ollama）。
- MODEL：模型名称（默认 gpt-4o，需支持图像）。
- JSON_SCHEMA：0/1，控制响应格式策略（适配不同服务要求）。

## 关键文件参考
- 物理拆解与导出：utils/imageProcessing.ts
- 语义分析与映射：services/openai.ts
- 三步梳理流程与 UI：App.tsx
