import { streamObject } from 'ai';
import { IssueDraftSchema } from './schema';
import { buildDraftPrompt, DRAFT_SYSTEM } from './prompt';
import { resolveFallbackModel, resolveModel, type ResolvedModel } from './providers';
import type { AiProvider, DraftInput, IssueDraft } from '../types';

export interface DraftResult {
  draft: IssueDraft;
  provider: AiProvider;
  modelId: string;
  fellBack: boolean;
}

/**
 * Shared draft engine — runs identically in the extension service worker and
 * directly in the page (any browser). Streams partials via callback, resolves
 * with the final validated draft. One cross-provider retry when the primary
 * fails at runtime (dead key, 429, outage). Throws NoProviderError when no key
 * is configured.
 */
export async function executeDraft(
  input: DraftInput,
  onPartial: (draft: Partial<IssueDraft>) => void,
  signal: AbortSignal,
): Promise<DraftResult> {
  const primary = await resolveModel(input.tier);
  try {
    return await streamOnce(primary, input, onPartial, signal, false);
  } catch (primaryErr) {
    if (signal.aborted) throw primaryErr;
    const fallback = await resolveFallbackModel(primary.provider, input.tier);
    if (!fallback) throw new Error(describeAiError(primaryErr));
    try {
      return await streamOnce(fallback, input, onPartial, signal, true);
    } catch (fallbackErr) {
      throw new Error(describeAiError(fallbackErr));
    }
  }
}

async function streamOnce(
  resolved: ResolvedModel,
  input: DraftInput,
  onPartial: (draft: Partial<IssueDraft>) => void,
  signal: AbortSignal,
  fellBack: boolean,
): Promise<DraftResult> {
  const result = streamObject({
    model: resolved.model,
    schema: IssueDraftSchema,
    system: DRAFT_SYSTEM,
    prompt: buildDraftPrompt(input),
    abortSignal: signal,
  });

  for await (const partial of result.partialObjectStream) {
    onPartial(partial as Partial<IssueDraft>);
  }

  const draft = (await result.object) as IssueDraft;
  return { draft, provider: resolved.provider, modelId: resolved.modelId, fellBack };
}

export function describeAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/401|unauthorized|invalid.*key/i.test(raw)) return 'AI provider rejected the API key.';
  if (/429|rate/i.test(raw)) return 'AI provider rate limit hit — try again shortly.';
  return `Draft failed: ${raw}`;
}
