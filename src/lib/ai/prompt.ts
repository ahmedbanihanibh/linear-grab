import type { DraftInput, GrabbedElement } from '../types';

export const DRAFT_SYSTEM = `You are an expert engineer drafting a Linear issue for a development team.
You are given a rough note from the reporter and, when available, the exact React source
location of the UI element the issue is about (captured from a running dev build).

Write a crisp, actionable issue a coding agent can execute against with zero follow-up
questions. Be specific, never invent details you were not given, and keep the tone neutral
and technical. If the note implies a bug, structure it as a bug; if it implies a change or
feature, keep reproSteps minimal and focus the description on the desired change.`;

function formatGrabbed(el: GrabbedElement): string {
  const lines: string[] = [];
  if (el.componentName) lines.push(`Component: <${el.componentName}>`);
  if (el.tagName) lines.push(`DOM element: <${el.tagName}>`);
  if (el.source?.filePath) {
    const loc = el.source.lineNumber != null ? `:${el.source.lineNumber}` : '';
    lines.push(`Source: ${el.source.filePath}${loc}`);
  }
  if (el.stackContext) lines.push(`Component stack:\n${el.stackContext}`);
  if (el.content) lines.push(`Element context:\n${el.content}`);
  lines.push(`Page URL: ${el.pageUrl}`);
  return lines.join('\n');
}

export function buildDraftPrompt(input: DraftInput): string {
  const parts: string[] = [];
  parts.push(`Reporter note:\n${input.note.trim() || '(none — infer from the element context)'}`);
  if (input.grabbed) {
    parts.push(`Captured element (via the Linear Grab picker):\n${formatGrabbed(input.grabbed)}`);
  }
  if (input.teamName) parts.push(`Target team: ${input.teamName}`);
  parts.push('Draft the issue now.');
  return parts.join('\n\n');
}

/** Compose the final Linear markdown body from the (possibly edited) draft fields. */
export function composeIssueBody(args: {
  description: string;
  reproSteps: string[];
  expected: string;
  actual: string;
  grabbed: GrabbedElement | null;
  repo?: string;
}): string {
  const sections: string[] = [args.description.trim()];

  const steps = args.reproSteps.map((s) => s.trim()).filter(Boolean);
  if (steps.length) {
    sections.push(`### Reproduction\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }
  if (args.expected.trim()) sections.push(`### Expected\n${args.expected.trim()}`);
  if (args.actual.trim()) sections.push(`### Actual\n${args.actual.trim()}`);

  const el = args.grabbed;
  if (el && (el.source?.filePath || el.componentName)) {
    const lines: string[] = [];
    const loc = el.source?.filePath
      ? `\`${el.source.filePath}${el.source.lineNumber != null ? `:${el.source.lineNumber}` : ''}\``
      : null;
    lines.push([el.componentName ? `\`<${el.componentName}>\`` : null, loc].filter(Boolean).join(' — '));
    if (el.stackContext) lines.push(`\n\`\`\`\n${el.stackContext}\n\`\`\``);
    lines.push(`\nCaptured on ${el.pageUrl}`);
    sections.push(`### Source\n${lines.join('\n')}`);
  }

  if (args.repo?.trim()) sections.push(`[repo=${args.repo.trim()}]`);

  return sections.join('\n\n');
}
