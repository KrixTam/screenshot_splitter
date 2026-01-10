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

/**
 * 分析两个相邻区块是否具有语义相关性
 * 逻辑：标题+内容(标题在上) 或 均为工具栏
 */
export async function checkRelevance(base64ImageA: string, base64ImageB: string): Promise<boolean> {
  // 请求前统一缩放图片宽度
  const [scaledA, scaledB] = await Promise.all([
    scaleImageBase64(base64ImageA, 1024),
    scaleImageBase64(base64ImageB, 1024)
  ]);

  const prompt = `你是一个 UI 设计专家，正在协助分析手机界面区块的相关性。
请比对以下两张按垂直顺序排列的截图（第一张在上方，第二张在下方）：

判断它们是否满足以下任一【合并条件】：
1. 存在【标题与内容】的上下文关系：第一张图是标题或引导文字，第二张图是其对应的详细内容（如：列表项的标题与描述、设置项的名称与说明）。注意：标题必须在内容的上方。
2. 均为【工具栏/导航栏】区块：两张图都是某个底部导航、顶栏或工具条的一部分。
3. 存在【工具栏/导航栏】的上下文关系：第一张图是以工具栏/导航栏的LOGO，第二张图是其对应的Label。

如果是，请返回 true，否则返回 false。
只返回 JSON 格式结果：{"related": boolean}`;

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
              image_url: { url: scaledA },
            },
            {
              type: "image_url",
              image_url: { url: scaledB },
            },
          ],
        },
      ],
    };
    const response = await openai.chat.completions.create(
      useJsonSchema ? { ...base, response_format: { type: "json_object" } } : base
    );

    let content = response.choices[0]?.message?.content;
    if (!content) return false;

    // Clean up potential markdown code blocks
    content = content.replace(/```json\n?|\n?```/g, "").trim();

    const end = performance.now();
    console.log(`[LLM] checkRelevance analysis completed in ${(end - start).toFixed(3)}ms`);
    console.log("[LLM] Raw response content:", content);
    
    // Clean up potential markdown code blocks
    content = content.replace(/```json\n?|\n?```/g, "").trim();

    try {
      const result = JSON.parse(content);
      console.log("[LLM] Parsed result:", result);
      return result.related === true;
    } catch (e) {
      console.error("[LLM] JSON parse error:", e);
      return false;
    }
  });
}
