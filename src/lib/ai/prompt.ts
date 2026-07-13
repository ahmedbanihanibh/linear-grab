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
export const DEFAULT_AGENT_INSTRUCTIONS = `- FIRST, self-orient in the repo checkout (skip any path that doesn't exist):
  1. Read \`CLAUDE.md\` and \`AGENTS.md\` at the repo root — the master map of product rules, architecture, and memory/skill pointers.
  2. Skim \`.claude/memory/MEMORY.md\` (the index) to learn what project memory exists; load the specific \`.claude/memory/*.md\` files the map names for the surface you're touching.
  3. Load the matching \`.claude/skills/<name>/SKILL.md\` files before designing, building UI, or animating (if skills are symlinked, follow them into \`.agents/skills/\`).
  Treat all of this as authoritative — it overrides your defaults.
- Use computer use to execute and test the change in the running app. Record a video demonstrating the fix and attach it to the PR.
- Keep going until the code works and you're happy with the implementation.
- Put up a PR, babysit it for the first set of review comments, and address them.
- When the fix is verified: UPDATE THE LINEAR ISSUE — post a completion comment with a one-line fix summary + the PR link, attach the demo video to the issue itself (not only the PR), and move the issue to its review/done state.`;

/**
 * Final "### Agent instructions" content: the user's template (or the default)
 * plus the structured test-account credentials when configured.
 */
export function buildAgentInstructions(settings: {
  issueTemplate?: string;
  testUsername?: string;
  testPassword?: string;
  skillPaths?: string;
  slackToken?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  telegramToken?: string;
  telegramChatId?: string;
  githubAssetsRepo?: string;
}): string {
  const parts: string[] = [settings.issueTemplate?.trim() || DEFAULT_AGENT_INSTRUCTIONS];

  // Skills & memory: the cloud agent works in a full repo checkout, so
  // committed skill/memory files just need authoritative POINTERS — the same
  // mechanism Claude Code uses via CLAUDE.md. Also travels with the markdown
  // when the issue is copied into any other agent.
  const paths = (settings.skillPaths ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length) {
    parts.push(
      `**Project skills & memory — MANDATORY reading before implementing.** This repo ships maintained skills/memory files. Read each of these paths in your checkout and treat their guidance as authoritative for design, style, and architectural decisions:\n${paths
        .map((p) => `- \`${p}\``)
        .join('\n')}`,
    );
  }

  if (settings.githubAssetsRepo?.trim()) {
    parts.push(
      `**Demo media hosting:** commit demo GIFs/videos to the PUBLIC assets repo \`${settings.githubAssetsRepo.trim()}\` under \`linear-grab/\` (clone it or use \`gh api\`), and embed the raw.githubusercontent.com URL in BOTH the Linear comment and the PR body. Prefer GIF for short demos — it renders inline everywhere (Linear, GitHub, the panel); Linear-hosted uploads do NOT render on GitHub.`,
    );
  }

  const creds: string[] = [];
  if (settings.testUsername?.trim()) {
    creds.push(`- Username / email: \`${settings.testUsername.trim()}\``);
  }
  if (settings.testPassword?.trim()) {
    creds.push(`- Password: \`${settings.testPassword.trim()}\``);
  }
  if (creds.length) {
    parts.push(`**Test account — log into the app with this while testing:**\n${creds.join('\n')}`);
  }

  // Notification directive: the agent announces its FINISHED fix (with the
  // demo video) to the team's channels itself, using these tokens.
  const notify: string[] = [];
  if (settings.slackToken && settings.slackChannelId) {
    notify.push(
      `- Slack: bot token \`${settings.slackToken}\`, channel \`${settings.slackChannelId}\`${settings.slackChannelName ? ` (#${settings.slackChannelName})` : ''}. Use \`chat.postMessage\` for the message and \`files.uploadV2\` (or getUploadURLExternal + completeUploadExternal) to upload the demo video into the channel.`,
    );
  }
  if (settings.telegramToken && settings.telegramChatId) {
    notify.push(
      `- Telegram: bot token \`${settings.telegramToken}\`, chat id \`${settings.telegramChatId}\`. Use \`sendMessage\` and \`sendVideo\` (multipart upload of the demo file).`,
    );
  }
  if (notify.length) {
    parts.push(
      `**When the fix is complete and the PR is open, announce it yourself:**\n${notify.join('\n')}\n\nMessage format — keep it short: what was broken → what you changed (one-line fix summary) → links to the Linear issue, the PR, and your agent run → attach/upload the demo video → end with the CTA "👉 Review the PR". You may also use these tokens to send yourself intermediate test notifications while verifying the integration works.`,
    );
  }

  return parts.join('\n\n');
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
  const grabList = input.grabbedList?.length ? input.grabbedList : input.grabbed ? [input.grabbed] : [];
  grabList.slice(0, 3).forEach((el, i) => {
    parts.push(
      `Captured element ${grabList.length > 1 ? `${i + 1}/${Math.min(grabList.length, 3)} ` : ''}(via the Linear Grab picker):\n${formatGrabbed(el)}`,
    );
  });
  if (input.teamName) parts.push(`Target team: ${input.teamName}`);
  if (input.template?.trim()) {
    parts.push(
      `Standing agent instructions the team appends to every issue (context only — do NOT repeat them in your description, they are added automatically):\n${input.template.trim()}`,
    );
  }
  if (input.logs?.trim()) {
    parts.push(
      `Recent dev server logs (tail — use for Analysis/Notes when relevant, do not paste wholesale):\n\`\`\`\n${input.logs.trim()}\n\`\`\``,
    );
  }
  parts.push('Draft the issue now.');
  return parts.join('\n\n');
}

/**
 * react-grab-style context block for LOCAL agents (Claude Code, Cursor chat):
 * everything a local session needs to jump to the element and honor the
 * project's skills/memory — paste-ready.
 */
export function buildLocalContext(
  el: GrabbedElement,
  settings: { skillPaths?: string },
  note?: string,
): string {
  const lines: string[] = ['## UI element context (Linear Grab)'];
  if (el.componentName) lines.push(`Component: \`<${el.componentName}>\``);
  if (el.source?.filePath) {
    const loc = el.source.lineNumber != null ? `:${el.source.lineNumber}` : '';
    lines.push(`Source: \`${el.source.filePath}${loc}\``);
  }
  if (el.tagName) lines.push(`DOM element: \`<${el.tagName}>\``);
  lines.push(`Page: ${el.pageUrl}`);
  if (el.stackContext) lines.push(`\nComponent stack:\n\`\`\`\n${el.stackContext}\n\`\`\``);

  const paths = (settings.skillPaths ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length) {
    lines.push(
      `\nRead these project skills/memory files first and treat them as authoritative:\n${paths
        .map((p) => `- \`${p}\``)
        .join('\n')}`,
    );
  }
  if (note?.trim()) lines.push(`\nTask:\n${note.trim()}`);
  return lines.join('\n');
}

/** Compose the final Linear markdown body from the (possibly edited) draft fields. */
export function composeIssueBody(args: {
  description: string;
  reproSteps: string[];
  expected: string;
  actual: string;
  grabs?: GrabbedElement[];
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

  const grabs = (args.grabs ?? []).filter((g) => g.source?.filePath || g.componentName);
  if (grabs.length) {
    const lines = grabs.map((el) => {
      const loc = el.source?.filePath
        ? `\`${el.source.filePath}${el.source.lineNumber != null ? `:${el.source.lineNumber}` : ''}\``
        : null;
      return `- ${[el.componentName ? `\`<${el.componentName}>\`` : null, loc]
        .filter(Boolean)
        .join(' — ')}`;
    });
    const first = grabs[0];
    if (first.stackContext) lines.push(`\n\`\`\`\n${first.stackContext}\n\`\`\``);
    lines.push(`\nCaptured on ${first.pageUrl}`);
    sections.push(
      `### Source${grabs.length > 1 ? ` (${grabs.length} elements)` : ''}\n${lines.join('\n')}`,
    );
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
