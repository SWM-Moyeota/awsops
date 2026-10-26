// Code step — generate Python with Bedrock, run it in the Code Interpreter
// 코드 단계 — Bedrock으로 Python 생성 후 Code Interpreter에서 실행
import { ROUTE_REGISTRY } from '../registry';
import { CODE_PROMPT_SUFFIX } from '../prompts';
import { extractPythonCode, executeCodeInterpreter } from '../code-interpreter';
import { recentMessages, lastMessageOf, type StepCtx, type StepResult, type StepVariant } from './types';

export interface CodeStepOpts {
  variant: StepVariant;   // via without code: stream 'Bedrock (code request)', JSON 'Bedrock (code)'
  modelId: string;        // resolveModelId(modelKey)
}

export async function codeStep(ctx: StepCtx, opts: CodeStepOpts): Promise<StepResult> {
  const config = ROUTE_REGISTRY[ctx.route];
  ctx.emit('status', { step: 'generating', message: ctx.status.codeGenerating });
  const gen = await ctx.llm({
    modelId: opts.modelId, system: ctx.systemPrompt + CODE_PROMPT_SUFFIX, messages: recentMessages(ctx.messages),
  });
  const aiText = gen.content || '';
  const tokens = { inputTokens: gen.inputTokens, outputTokens: gen.outputTokens };
  const pythonCode = extractPythonCode(aiText) || extractPythonCode(lastMessageOf(ctx.messages));

  if (pythonCode) {
    ctx.emit('status', { step: 'executing', message: ctx.status.codeExecuting });
    const codeResult = await executeCodeInterpreter(pythonCode);
    const executionBlock = `\n\n---\n**Code Execution Result** (exit code: ${codeResult.exitCode}):\n\`\`\`\n${codeResult.output}\n\`\`\``;
    // Stream: the execution block goes out as one more chunk / 스트림: 실행 결과를 chunk 하나로 전송
    ctx.emit('chunk', { delta: executionBlock });
    return { content: aiText + executionBlock, via: `Bedrock + ${config.display}`, queriedResources: ['code-interpreter'], route: ctx.route, ...tokens };
  }
  return {
    content: aiText, via: opts.variant === 'stream' ? 'Bedrock (code request)' : 'Bedrock (code)',
    queriedResources: [], route: ctx.route, ...tokens,
  };
}
