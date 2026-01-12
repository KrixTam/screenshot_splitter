import OpenAI from "openai";
import { scaleImageBase64 } from "../utils/imageProcessing";
import { MappingResult, StructuralResult } from "../types";

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

  console.log("[LLM] Sending prompt to model:", prompt);

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

function parseJson(content: string, asType: "StructuralResult" | "MappingResult", errorMessage: string): any {
  // Clean up potential markdown code blocks
  let json_content = content.replace(/```json\n?|\n?```/g, "").trim();

  try {
    if (asType === "StructuralResult") {
      const result = JSON.parse(json_content) as StructuralResult;
      console.log("[LLM] Parsed result:", result);
      return result;
    } else if (asType === "MappingResult") {
      const result = JSON.parse(json_content) as MappingResult;
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

/**
 * 步骤 1：分析原图结构逻辑（语义内容块输出）
 * 输入：原始截图
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
   - 存在【敏感信息/隐私内容】上下文关系的，统一作为一个有效内容块，不与其他内容合并，注意要包含敏感信息的掩码展示方式。
   - 存在【内容延展】上下文关系的，合并作为一个有效内容块。
4. **底部导航栏**：底部导航栏是一个独立的逻辑块，作为一个独立的逻辑块输出。

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

// 语义转换函数
function convertToSemanticBlocks(jsonData: StructuralResult) {
  return jsonData.result.map(item => {
    return `语义逻辑块${item.sn}：${item.description}`;
  });
}

/**
 * 步骤 2：建立语义到像素的映射关系
 * 输入：物理拆解后的【标注预览图】 + 步骤 1 的【语义结果定义】
 */
export async function getMappingAnalysis(
  annotatedPreviewImage: string,
  structuralResult: StructuralResult
): Promise<MappingResult> {
  // const scaledImage = await scaleImageBase64(annotatedPreviewImage, 1024);

  const prompt = `你是一个高精度的 UI 物理映射机器人。

【任务内容】：
你需要观察提供的“标注预览图”，图中已经通过紫色边框标记出了所有的物理像素内容块，并附带了白色的数字编号（如 1, 2, 3...）。
请根据步骤 1 定义的“语义逻辑块”，识别预览图中哪些编号的物理块属于该语义块，建立映射关系。

【强制规则】：
1. **视觉识别**：你必须根据预览图中可见的编号进行映射。
2. **一对多映射**：一个语义内容块（sn）通常会包含多个预览图中的像素块（如金刚位可能包含编号 6 和 7，或者更多）。请将所有相关的物理块编号填入 mapping 数组。
3. **排除状态栏**：通常编号 1 或 2 对应系统状态栏，如果步骤 1 未定义状态栏，请不要将其映射到任何语义块中。
4. **敏感信息的掩码**：如果存在敏感信息的掩码展示方式（比如以“****”展示的内容），请将其映射到对应的语义块中。
5. **完整性**：每个语义块必须至少映射 1 个像素块。

【参考语义定义（步骤1结果）】：
${JSON.stringify(structuralResult.result)}

请以 JSON 格式输出映射结果：{"result": [{"sn": 序号, "description": "描述", "mapping": [像素块编号列表]}]}`;

  return withRetry(async () => {
    const start = performance.now();
    console.log(`[LLM] Starting mapping analysis using model: ${model}`);

    const content = await callLLM(prompt, annotatedPreviewImage);
    
    const end = performance.now();
    console.log(`[LLM] Mapping analysis completed in ${(end - start).toFixed(3)}ms`);
    console.log("[LLM] Raw response content:", content);

    return parseJson(content, "MappingResult", "Step 2 返回内容为空");
  });
}
