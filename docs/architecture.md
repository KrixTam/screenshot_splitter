# 架构设计说明

本文档说明截图拆分助手的整体架构与关键处理流程，覆盖物理拆解、语义梳理、图像处理、LLM 集成与并发策略等内容。描述与代码实现保持一致，便于维护和扩展。

## 总览
- 输入：一张长截图（手机 UI）。
- 输出：
  - 物理拆解后的内容块、无效块、分割区，以及拆解度（completeness）。
  - 语义梳理后的内容块，以及梳理度（refinementCompleteness）。
- 关键环境变量：
  - OPENAI_API_KEY、OPENAI_BASE_URL、MODEL
  - JSON_SCHEMA（0/1，用于控制响应格式）
  - LLM_CONCURRENCY（并发序列数）
  - LLM_BATCH（第一阶段分序列的批大小）

## 阶段一：物理拆解（像素级扫描）
- 入口：detectPixelBlocks(img, invalidThreshold, minHeightRatio)。
- 目标：基于像素的单色占比识别水平分割线，并切分为区块。
- 主要逻辑：
  - 逐行采样统计主色占比，主色占比大于阈值（separatorThreshold≈invalidThreshold-0.05）认为是分割线。
  - 分段聚合上下区块并进行有效性校验（isBlockValid），过滤高度过小或纹理单一的噪点。
  - 结果：
    - blocks：有效内容块
    - invalidBlocks：无效块
    - separators：分割区
    - coverage：拆解度（0–100）
- 坐标归一化：所有 BoundingBox 坐标统一采用 0–1000 标尺，便于后续导出与恢复。

## 阶段二：语义梳理（两阶段）
梳理逻辑在 App.tsx 的 handleRefine 中实现，分两阶段：

### 第一阶段：序列并发 + 序列内串行
- 目的：在保证局部相邻关系的前提下，提升整体 LLM 处理效率。
- 步骤：
  1. 将所有有效内容块按 LLM_BATCH 拆分为若干序列（顺序不变）。
  2. 以 LLM_CONCURRENCY 为并发度，批量启动多个序列处理。
  3. 每个序列内部，按相邻两块串行调用 checkRelevance 进行判定；若相关则物理合并为新块。
- 输出：初步合并后的结果流（MergeItem[]），包含标记 wasMerged 的信息，便于第二阶段继续优化。

### 第二阶段：串行细化
- 目的：针对第一阶段未合并的“孤立块”，再次与上下邻居进行比对，捕捉跨序列或新产生的邻接关系。
- 步骤：
  - 线性遍历最终流，对当前未合并块与其下邻/上邻分别调用 checkRelevance。
  - 若相关则合并，并原地替换为新块（splice），继续线性推进，确保稳定收敛。
- 输出：最终梳理内容块列表，并计算梳理度。

## 相关性判定（LLM 规则）
- 入口：services/openai.ts 的 checkRelevance(base64ImageA, base64ImageB)。
- 提示词规则（与业务一致）：
  - 合并：
    1. 上方为“标题”、下方为“内容”，且标题在内容上方；
    2. 上方为“工具 LOGO”、下方为“工具 Label”；
    3. 上下两块均为“工具”类区块（工具栏/导航栏/控件）。
  - 不合并：
    - 上方为“标题”、下方为“工具”的组合不合并。
- 响应解析：期望仅返回 {"related": boolean} 的 JSON。代码会清理可能出现的 Markdown 包裹并做 JSON 解析。

## 图像缩放（请求前优化）
- 入口：utils/imageProcessing.ts 的 scaleImageBase64(dataUrl, maxWidth)。
- 目的：统一上行图片宽度，降低 LLM 请求负载与带宽占用。
- 规则：
  - 若输入宽度大于 maxWidth（默认 1024），按比例缩放到 maxWidth 宽度；
  - 否则直接返回原图。
- 使用位置：checkRelevance 在提交两张相邻块的截图给 LLM 前，分别调用缩放。

## 指标设计
- 拆解度（completeness）：物理拆解阶段中，有效块、无效块与分割区覆盖的总高度占比。
- 梳理度（refinementCompleteness）：在最终梳理结果基础上，将未被包含的无效块与分割区面积计入，衡量语义合并的总体覆盖率。

## 备份与恢复
- 备份（handleBackup）：
  - 保存原始图片、配置参数、各阶段结果以及归一化坐标。
- 恢复（handleRestore）：
  - 按保存的归一化坐标对当前原图重新裁剪生成 dataUrl，确保清晰度与位置一致。

## 并发与稳定性
- 并发：
  - 第一阶段采用“序列并发 + 序列内串行”，通过 LLM_CONCURRENCY 与 LLM_BATCH 控制规模。
- 稳定性：
  - OpenAI SDK 内置 maxRetries（429/5xx 重试），日志记录每阶段耗时与调用次数，便于问题定位。

## 配置清单
- OPENAI_API_KEY：OpenAI 或本地兼容服务的密钥。
- OPENAI_BASE_URL：可选，自定义 API 地址（支持 LM Studio / Ollama）。
- MODEL：模型名称（默认 gpt-4o，可替换兼容视觉的本地模型）。
- JSON_SCHEMA：0/1，控制响应格式策略（适配不同服务要求）。
- LLM_CONCURRENCY：第一阶段并发的序列数量（默认 4）。
- LLM_BATCH：第一阶段序列的批大小（默认 5）。

## 关键文件参考
- 物理拆解与导出：utils/imageProcessing.ts
- 语义判定：services/openai.ts
- 两阶段梳理流程与 UI：App.tsx
