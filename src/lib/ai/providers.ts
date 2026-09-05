import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { isExtensionContext } from '../env';
import { getSettings } from '../storage';
import type { AiProvider, AiTier, Settings } from '../types';

export const MODELS: Record<AiProvider, Record<AiTier, string>> = {
  openai: { fast: 'gpt-5.6-luna', best: 'gpt-5.2' },
  anthropic: { fast: 'claude-haiku-4-5', best: 'claude-opus-4-8' },
};

/** A user-set model id overrides the tier table for BOTH tiers of its provider. */
export function modelIdFor(settings: Settings, provider: AiProvider, tier: AiTier): string {
  const override = provider === 'openai' ? settings.openaiModel : settings.anthropicModel;
  return override?.trim() || MODELS[provider][tier];
}

export class NoProviderError extends Error {
  constructor() {
    super('No AI provider configured. Add an OpenAI or Anthropic API key in Settings.');
    this.name = 'NoProviderError';
  }
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: AiProvider;
  modelId: string;
}

function keyFor(settings: Settings, provider: AiProvider): string | undefined {
  return provider === 'openai' ? settings.openaiKey : settings.anthropicKey;
}

function buildModel(provider: AiProvider, apiKey: string, modelId: string): ResolvedModel {
  const model =
    provider === 'openai'
      ? createOpenAI({ apiKey })(modelId)
      : createAnthropic({
          apiKey,
          // Page mode calls Anthropic straight from the browser (Safari/Firefox/…);
          // Anthropic requires this opt-in header for direct browser access.
          // The extension's service worker doesn't need it.
          headers: isExtensionContext
            ? undefined
            : { 'anthropic-dangerous-direct-browser-access': 'true' },
        })(modelId);
  return { model, provider, modelId };
}

/** Resolution order: explicit user preference (if its key exists) → OpenAI → Anthropic. */
export function resolveProvider(settings: Settings): AiProvider | null {
  const preferred = settings.preferredProvider;
  if (preferred && keyFor(settings, preferred)) return preferred;
  if (settings.openaiKey) return 'openai';
  if (settings.anthropicKey) return 'anthropic';
  return null;
}

export async function resolveModel(tier: AiTier): Promise<ResolvedModel> {
  const settings = await getSettings();
  const provider = resolveProvider(settings);
  if (!provider) throw new NoProviderError();
  return buildModel(provider, keyFor(settings, provider)!, modelIdFor(settings, provider, tier));
}

/** The cross-provider fallback when the primary fails at runtime (dead key, 429, outage). */
export async function resolveFallbackModel(
  failed: AiProvider,
  tier: AiTier,
): Promise<ResolvedModel | null> {
  const settings = await getSettings();
  const other: AiProvider = failed === 'openai' ? 'anthropic' : 'openai';
  const key = keyFor(settings, other);
  return key ? buildModel(other, key, modelIdFor(settings, other, tier)) : null;
}
