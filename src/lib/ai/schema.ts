import { z } from 'zod';

/**
 * Single source of truth for the AI draft: constrains model output (streamObject),
 * types the panel form, and shapes what feeds issueCreate.
 */
export const IssueDraftSchema = z.object({
  title: z
    .string()
    .describe('Concise, specific issue title. Imperative or descriptive, no trailing period.'),
  description: z
    .string()
    .describe(
      'Issue body in Linear markdown: a short problem summary and relevant context. Do NOT include repro steps, expected/actual, or source location — those are separate fields.',
    ),
  reproSteps: z.array(z.string()).describe('Ordered reproduction steps, each a single action.'),
  expected: z.string().describe('Expected behavior, one or two sentences.'),
  actual: z.string().describe('Actual (buggy) behavior, one or two sentences.'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(4)
    .describe('Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.'),
  suggestedLabels: z.array(z.string()).describe('0-3 suggested label names, e.g. "Bug", "UI".'),
});

export type IssueDraftShape = z.infer<typeof IssueDraftSchema>;
