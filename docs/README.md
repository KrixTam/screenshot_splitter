# 手机截图拆解工具 (Screenshot Splitter)

这是一个专为手机截图设计的自动化拆解工具。它利用像素级单色扫描技术与 LLM 视觉模型，自动识别截图中的水平分割区域，并将截图精准切割成独立的逻辑 UI 模块。

## 快速开始 (Quick Start)

### 1. 环境准备
确保本地已安装 Node.js (推荐 v18+)。

### 2. 安装依赖
```bash
npm install
```

### 3. 配置环境变量
在项目根目录创建 `.env` 文件，并填入你的 OpenAI API 配置（支持 LM Studio / Ollama 等本地兼容服务）：
```env
# 密钥（任选其一）
API_KEY=your_sk_key_here
OPENAI_API_KEY=your_sk_key_here
# 可选：自定义接口地址
OPENAI_BASE_URL=https://api.openai.com/v1
# 可选：自定义模型名称（需支持图像）
MODEL=gpt-4o
# 可选：是否启用 JSON Schema 响应格式（0/1）
JSON_SCHEMA=0
```

### 4. 启动项目
```bash
npm run dev
```
启动后访问 http://localhost:3000 即可使用。

## 核心功能逻辑

### 1. 像素级初拆 (Pixel-based Split)
- 行扫描识别分割线：统计每行主色占比，若主色占比 ≥ 分割阈值则判定为分割区；分割阈值为 `max(0.90, invalidThreshold - 0.05)`。
- 区块有效性判定：对非分割区进行聚合后，采用增强的“有意义性”判断：
  - 唯一颜色计数阈值：颜色种类数 > 20 判定为有效；
  - 灰度方差阈值：方差 > 100 判定为有效；
  - 连通域分析：下采样至不超过 128 的尺寸做 8 邻域 BFS，若连通域数量 > 50 或覆盖率 < 0.95 判定为有效。
- 最小高度占比：过滤过小区块（默认最小高度比 0.2%）。

### 2. 三步语义梳理 (Semantic Refinement)
- 步骤 1：原图语义结构分析（LLM）
  - 输入：原始截图
  - 输出：语义逻辑块列表（只包含序号与描述）
- 步骤 2：标注预览映射（LLM）
  - 输入：物理拆解的标注预览图（带数字标注）+ 步骤 1 结果
  - 输出：每个语义逻辑块映射到的物理块编号列表
- 步骤 3：坐标合并计算（本地）
  - 根据映射到的物理块，按 ymin/xmin/ymax/xmax 求并，生成最终语义块坐标并排序。
- 图像缩放：在每次 LLM 调用前自动将图片统一缩放到宽度不超过 1024，提高调用效率。
- 梳理度：基于映射成功的物理块数量与未映射块数量计算综合覆盖率。

### 3. 数据持久化 (Backup & Restore)
- 支持完整工作流备份，包含有效块、无效块、分割区、语义梳理结果的元数据。
- 备份坐标均为原图的归一化坐标 (0–1000)，恢复时按原图重新裁剪生成最高清晰度素材。

## 备份文件数据结构 (JSON)

```json
{
  "version": "5.6",
  "timestamp": "ISO_DATE",
  "originalImage": "base64",
  "config": {
    "invalidThreshold": 97,
    "minBlockRatio": 0.2
  },
  "results": {
    "blocks": [],
    "invalidBlocks": [],
    "separators": [],
    "completeness": 95,
    "refinedBlocks": [],
    "refinementCompleteness": 98
  }
}
```

## 使用场景
*   UI 组件库构建：快速将长截图拆解为组件级图片素材。
*   页面逻辑分析：可视化分析页面组件的垂直堆叠逻辑与语义关系。
*   快速恢复与共享：导出完整分析状态，便于跨设备继续梳理。
