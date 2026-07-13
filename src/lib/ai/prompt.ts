import type { DraftInput, GrabbedElement } from '../types';

export const DRAFT_SYSTEM = `You are an expert engineer drafting a Linear issue for a development team.
You are given a rough note from the reporter and, when available, the exact React source
location of the UI element the issue is about (captured from a running dev build).

Write a crisp, actionable issue a coding agent can execute against with zero follow-up
questions. Be specific, never invent details you were not given, and keep the tone neutral
and technical. If the note implies a bug, structure it as a bug; if it implies a change or
feature, keep reproSteps minimal and focus the description on the desired change.

The issue renders in this exact section order — fill each field for its section:
Summary (description field) → Steps to Reproduce (reproSteps) → Expected Behavior
(expected) → Actual Behavior (actual) → Impact (impact) → Analysis / Notes
(analysisNotes, markdown bullets grounded in the provided source context) →
Suggested Next Steps (suggestedNextSteps, markdown bullets with concrete fixes).
The Summary is a short plain-prose paragraph — no headings inside it, no repetition
of the other sections.`;

/**
 * Default standing directives for the delegated cloud agent — appended to every
 * issue as "### Agent instructions" unless the user sets their own template.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = `- Use computer use to execute and test the change in the running app. Record a video demonstrating the fix and attach it to the PR.
- Keep going until the code works and you're happy with the implementation.
- Put up a PR, babysit it for the first set of review comments, and address them.`;

/**
 * Final "### Agent instructions" content: the user's template (or the default)
 * plus the structured test-account credentials when configured.
 */
export function buildAgentInstructions(settings: {
  issueTemplate?: string;
  testUsername?: string;
  testPassword?: string;
}): string {
  const base = settings.issueTemplate?.trim() || DEFAULT_AGENT_INSTRUCTIONS;
  const creds: string[] = [];
  if (settings.testUsername?.trim()) {
    creds.push(`- Username / email: \`${settings.testUsername.trim()}\``);
  }
  if (settings.testPassword?.trim()) {
    creds.push(`- Password: \`${settings.testPassword.trim()}\``);
  }
  if (!creds.length) return base;
  return `${base}\n\n**Test account — log into the app with this while testing:**\n${creds.join('\n')}`;
}

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
  if (input.template?.trim()) {
    parts.push(
      `Standing agent instructions the team appends to every issue (context only — do NOT repeat them in your description, they are added automatically):\n${input.template.trim()}`,
    );
  }
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
  /** Cursor cloud agent model override → [model=…] tag. */
  model?: string;
  /** Standing instructions (demo credentials, video request, …). */
  agentInstructions?: string;
  impact?: string;
  analysisNotes?: string;
  suggestedNextSteps?: string;
}): string {
  const sections: string[] = [];
  if (args.description.trim()) sections.push(`### Summary\n${args.description.trim()}`);

  const steps = args.reproSteps.map((s) => s.trim()).filter(Boolean);
  if (steps.length) {
    sections.push(`### Steps to Reproduce\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }
  if (args.expected.trim()) sections.push(`### Expected Behavior\n${args.expected.trim()}`);
  if (args.actual.trim()) sections.push(`### Actual Behavior\n${args.actual.trim()}`);
  if (args.impact?.trim()) sections.push(`### Impact\n${args.impact.trim()}`);
  if (args.analysisNotes?.trim()) sections.push(`### Analysis / Notes\n${args.analysisNotes.trim()}`);
  if (args.suggestedNextSteps?.trim()) {
    sections.push(`### Suggested Next Steps\n${args.suggestedNextSteps.trim()}`);
  }

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

  if (args.agentInstructions?.trim()) {
    sections.push(`### Agent instructions\n${args.agentInstructions.trim()}`);
  }

  const tags = [
    args.repo?.trim() ? `[repo=${args.repo.trim()}]` : null,
    args.model?.trim() ? `[model=${args.model.trim()}]` : null,
  ].filter(Boolean);
  if (tags.length) sections.push(tags.join(' '));

  return sections.join('\n\n');
}
