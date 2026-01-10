import OpenAI from "openai";
import { scaleImageBase64 } from "../utils/imageProcessing";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  dangerouslyAllowBrowser: true, // Since we are running in a client-side environment (Vite)
  maxRetries: 5 // Use SDK built-in retry logic (handles 429 and 5xx errors)
});

const model = process.env.MODEL || "gpt-4o";
const useJsonSchema = (process.env.JSON_SCHEMA || '0') === '1';

/**
 * 带有健壮指数退避的重试包装函数
 * 专门处理 429 RESOURCE_EXHAUSTED
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 5): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.code;
      const message = String(error?.message || "");
      
      const isRateLimit = status === 429 || status === "RESOURCE_EXHAUSTED" || message.includes('429') || message.includes('quota');
      const isServerError = status === 500 || status === "INTERNAL" || message.includes('500');

      if (isRateLimit || isServerError) {
        // 速率限制使用更长初始退避 (2.5s)
        const baseDelay = isRateLimit ? 2500 : 1000;
        const delay = Math.pow(2, i) * baseDelay + Math.random() * 1000;
        console.warn(`API 调用受限 (${status})，第 ${i + 1}/${maxRetries} 次重试中，等待 ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export interface RefinementMapping {
  result: {
    sn: number;
    description: string;
  }[];
  mapping: {
    sn: number;
    original_block_indices: number[]; // 1-based indices
  }[];
}

/**
 * 语义智能梳理处理过程：
 * 步骤1：分析原图逻辑结构（排除状态栏，独立应用头，合并上下文）
 * 步骤2：将像素级区块映射至逻辑结果列表
 */
export async function getSemanticRefinement(
  originalImage: string, 
  pixelBlockCount: number
): Promise<RefinementMapping> {
  const scaledImage = await scaleImageBase64(originalImage, 1024);

  console.log('pixelBlockCount:', pixelBlockCount);

  const prompt = `你是一个高级 UI/UX 分析专家。请对提供的手机截图执行以下两阶段分析：

## 步骤1：结构分析
分析原图，按内容块由上至下切割。
【要求】：
1. 手机顶部时间状态栏属于无效内容，必须忽略，作为无效内容块，不参与后续分析。
2. 顶部的应用名称（含应用右上角快捷按钮）属于单独的有效内容块，严禁与其他内容合并。
3. 存在【标题与内容】上下文关系的，统一作为一个有效内容块。
4. 存在【工具栏/导航栏】上下文关系的，统一作为一个有效内容块。
5. 存在【内容延展】上下文关系的，合并作为一个有效内容块。

## 步骤2：区块映射
目前已知该图已由像素级拆解出 ${pixelBlockCount} 个有效内容块（编号 1 至 ${pixelBlockCount}）。
请将这些像素级有效内容块按逻辑映射到步骤1的结果列表中，一个像素级有效内容块仅可以对应一个步骤1的语义有效内容块，并确保每个语义有效内容块含有至少一个像素级有效内容块。

请严格返回以下 JSON 格式：
{
  "result": [
    {"sn": 1, "description": "逻辑块具体描述"}
  ],
  "mapping": [
    {"sn": 1, "original_block_indices": [1, 2]}
  ]
}

务必确保每个语义有效内容块的描述都包含至少一个像素级有效内容块的信息，即original_block_indices中至少包含一个像素级有效内容块的编号。`;

  return withRetry(async () => {
    const start = performance.now();
    console.log(`[LLM] Starting checkRelevance analysis using model: ${model}`);
    const base: any = {
      model: model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: scaledImage },
            }
          ],
        },
      ],
    };
    const response = await openai.chat.completions.create(
      useJsonSchema ? { ...base, response_format: { type: "json_object" } } : base
    );

    let content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM 返回内容为空");

    const end = performance.now();
    console.log(`[LLM] Semantic Refinement analysis completed in ${(end - start).toFixed(3)}ms`);
    console.log("[LLM] Raw response content:", content);


    // Clean up potential markdown code blocks
    content = content.replace(/```json\n?|\n?```/g, "").trim();

    try {
      const result = JSON.parse(content) as RefinementMapping;
      console.log("[LLM] Parsed result:", result);
      return result;
    } catch (e) {
      throw new Error("LLM JSON parse error", e);
    }
  });
}
