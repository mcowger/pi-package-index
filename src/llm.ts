import { igniteModel, loadModels, Message } from 'multi-llm-ts';

const SYSTEM_PROMPT = `You are a technical writer who summarizes npm packages.
Given a package's README content, write a concise summary in 3-4 sentences.
Focus on:
1. What the package does (its core purpose)
2. Key features or capabilities
3. Who would benefit from using it
Be informative but brief. Do not use bullet points or headings — write prose.`;

const MAX_README_LENGTH = 4000;

let _model: any = null;

async function getModel() {
  if (_model) return _model;

  const provider = process.env.LLM_PROVIDER || 'openai';
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL;
  const modelName = process.env.LLM_MODEL;

  if (!apiKey) {
    throw new Error('LLM_API_KEY environment variable is required');
  }

  const config: Record<string, any> = { apiKey };
  if (baseURL) config.baseURL = baseURL;

  let selectedModel: any;

  try {
    const models = await loadModels(provider, config);
    if (models?.chat?.length) {
      if (modelName) {
        selectedModel = models.chat.find(
          (m: any) => m.id === modelName || m.name === modelName,
        );
      }
      if (!selectedModel) {
        selectedModel = models.chat[0];
      }
    }
  } catch (err: any) {
    console.warn(`  ⚠️  loadModels failed: ${err.message}, falling back to default`);
  }

  // Fallback: if we couldn't load a model list, construct one manually
  if (!selectedModel) {
    selectedModel = { id: modelName || 'gpt-4o-mini', name: modelName || 'gpt-4o-mini' };
  }

  const modelId = selectedModel.id || selectedModel.name || 'unknown';
  console.log(`  LLM: Using provider "${provider}", model "${modelId}"`);

  _model = igniteModel(provider, selectedModel, config);
  return _model;
}

export async function summarizeReadme(
  readme: string,
  name: string,
): Promise<string | null> {
  try {
    const model = await getModel();

    const truncated =
      readme.length > MAX_README_LENGTH
        ? readme.slice(0, MAX_README_LENGTH) + '\n\n[... README truncated ...]'
        : readme;

    const messages = [
      new Message('system', SYSTEM_PROMPT),
      new Message('user', `Package: ${name}\n\n${truncated}`),
    ];

    const response = await model.complete(messages);
    return response.content || null;
  } catch (err) {
    console.warn(
      `  LLM summarization failed for ${name}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
