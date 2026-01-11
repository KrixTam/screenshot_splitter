import OpenAI from "openai";
import { scaleImageBase64 } from "../utils/imageProcessing";
import { BoundingBox, SplitBlock } from "../types";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  dangerouslyAllowBrowser: true, // Since we are running in a client-side environment (Vite)
  maxRetries: 5 // Use SDK built-in retry logic (handles 429 and 5xx errors)
});

const model = process.env.MODEL || "gpt-4o";
const useJsonSchema = (process.env.JSON_SCHEMA || '0') === '1';

async function callLLM(prompt: string, originalImage: string, scaleFlag: boolean = true): Promise<string> {
  const image = scaleFlag ? await scaleImageBase64(originalImage, 1024) : originalImage;

  const base: any = {
      model: model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: image },
            }
          ],
        },
      ],
    };
    const response = await openai.chat.completions.create(
      useJsonSchema ? { ...base, response_format: { type: "json_object" } } : base
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM 返回内容为空");
    return content;
}

function parseJson(content: string, asType: "StructuralResult" | "RefinedResult", errorMessage: string): any {
  // Clean up potential markdown code blocks
  let json_content = content.replace(/```json\n?|\n?```/g, "").trim();

  try {
    if (asType === "StructuralResult") {
      const result = JSON.parse(json_content) as StructuralResult;
      console.log("[LLM] Parsed result:", result);
      return result;
    } else if (asType === "RefinedResult") {
      const result = JSON.parse(json_content) as RefinedResult;
      console.log("[LLM] Parsed result:", result);
      return result;
    }
    throw new Error("LLM JSON parse error: unknown type");
  } catch (e) {
    throw new Error(errorMessage, e);
  }
}

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

export interface StructuralResult {
  result: {
    sn: number;
    description: string;
  }[];
}

export interface RefinedResult {
  result: {
    sn: number;
    description: string;
    mapping: number[]; // 1-based pixel block indices
    box: BoundingBox;
  }[];
}

/**
 * 步骤 1：分析原图结构逻辑（仅语义理解）
 */
export async function getStructuralAnalysis(originalImage: string): Promise<StructuralResult> {
  // const scaledImage = await scaleImageBase64(originalImage, 1024);

  const prompt = `你是一个高级 UI 语义分析专家。请对提供的手机截图进行语义分析，并输出有效逻辑内容块。

【核心要求】：
1. **绝对禁止**：手机顶部的时间、电量、信号等状态栏属于无效内容。**严禁**将其作为逻辑块输出。
2. **首位区块**：通常应用名称及其右上角功能键是首个逻辑块，作为一个独立的逻辑块输出，不与其他内容合并；请从这里开始分析。
3. **合并规则**：
   - 存在【标题与内容】上下文关系的，统一作为一个有效内容块。
   - 存在【工具栏/导航栏】上下文关系的，统一作为一个有效内容块。
   - 存在【敏感信息/隐私内容】上下文关系的，统一作为一个有效内容块。
   - 存在【内容延展】上下文关系的，合并作为一个有效内容块。
4. **单一主题**：确保每个逻辑块主题单一，若有多个主题，请拆分为不同逻辑块。
5. **底部导航栏**：底部导航栏是一个独立的逻辑块，作为一个独立的逻辑块输出。

请严格返回以下 JSON 格式：
{
  "result": [
    {"sn": 1, "description": "逻辑块描述"}
  ]
}`;

  return withRetry(async () => {
    const start = performance.now();
    console.log(`[LLM] Starting structural analysis using model: ${model}`);

    const content = await callLLM(prompt, originalImage);

const end = performance.now();
    console.log(`[LLM] Structural analysis completed in ${(end - start).toFixed(3)}ms`);
    console.log("[LLM] Raw response content:", content);

    return parseJson(content, "StructuralResult", "Step 1 返回内容为空");
  });
}

/**
 * 步骤 2 & 3：执行映射并构建坐标
 */
export async function getFinalMapping(
  originalImage: string,
  pixelBlocks: SplitBlock[],
  structuralResult: StructuralResult
): Promise<RefinedResult> {
  const scaledImage = await scaleImageBase64(originalImage, 1024);

  const pixelBlockData = pixelBlocks.map((b, i) => ({
    number: i + 1,
    box: b.box
  }));

  const prompt = `你是一个 UI 物理映射专家。请根据提供的“语义内容块”和“像素级内容块”，完成精确映射。

【强制约束】：
1. **排除状态栏**：
   - 请检查“像素级内容块”中的第 1 个或前几个块。如果它包含时间、电池、WiFi、信号等图标（即手机系统状态栏），**绝对禁止**将其映射到任何语义内容块中。
   - 真正的语义映射应从应用的内容区域（通常是像素块 2 或 3 之后）开始。
2. **映射关系**：依次为每个语义内容块找到其对应的物理像素块编号。每个语义块必须包含至少 1 个像素块。
3. **坐标构建**：合并后的逻辑块坐标 ymin 应等于所含像素块中最小的 ymin，ymax 等于最大的 ymax。
4. **敏感信息**：若某个像素块是敏感信息的标签（如“密码”），后续块是掩码或具体数值，必须将它们归入同一个语义逻辑块。
5. **金刚位**：若某个像素块属于金刚位，后续块是类似的样式，必须将它们归入同一个语义逻辑块。

【输入数据】：
- 语义内容块列表：${JSON.stringify(structuralResult.result)}
- 像素级内容块详情：${JSON.stringify(pixelBlockData)}

请严格按以下 JSON 格式输出最终映射结果：
{
  "result": [
    {
      "sn": 1,
      "description": "描述",
      "mapping": [2, 3],
      "box": {"ymin": 45, "xmin": 0, "ymax": 120, "xmax": 1000}
    }
  ]
}`;

  return withRetry(async () => {
    const start = performance.now();
    console.log(`[LLM] Starting mapping analysis using model: ${model}`);

    const content = await callLLM(prompt, originalImage, false);

    const end = performance.now();
    console.log(`[LLM] Mapping analysis completed in ${(end - start).toFixed(3)}ms`);
    console.log("[LLM] Raw response content:", content);

    return parseJson(content, "RefinedResult", "Mapping Step 返回内容为空");
  });
}
