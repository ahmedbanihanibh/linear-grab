import type { Settings } from './types';

/**
 * Slack + Telegram announcements. Both APIs are called with form-encoded
 * bodies (simple requests — no CORS preflight; both set ACAO:*), so this
 * works straight from the browser. Best-effort by contract: failures are
 * returned, never thrown.
 */

export interface IssueAnnouncement {
  identifier: string;
  title: string;
  url: string;
  summary?: string;
  impact?: string;
  repo?: string;
  /** Public demo/recording URL when one was uploaded. */
  demoUrl?: string;
  executor: 'cursor' | 'local' | 'none';
}

function messageText(a: IssueAnnouncement, style: 'slack' | 'telegram'): string {
  const b = (s: string) => (style === 'slack' ? `*${s}*` : s);
  const lines = [
    `🛠️ ${b(`${a.identifier} — ${a.title}`)}`,
    a.summary?.trim() ? a.summary.trim().slice(0, 300) : null,
    a.impact?.trim() ? `Impact: ${a.impact.trim().slice(0, 200)}` : null,
    a.executor === 'cursor'
      ? '🤖 Delegated to the Cursor cloud agent — PR with demo video incoming.'
      : a.executor === 'local'
        ? '💻 Delegated to local Claude Code.'
        : null,
    a.repo ? `Repo: ${a.repo}` : null,
    a.demoUrl ? `Demo: ${a.demoUrl}` : null,
    `👉 Follow & review: ${a.url}`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function announceSlack(s: Settings, a: IssueAnnouncement): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    body: new URLSearchParams({
      token: s.slackToken!,
      channel: s.slackChannelId!,
      text: messageText(a, 'slack'),
      unfurl_links: 'false',
    }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(json.error ?? 'slack error');
}

async function announceTelegram(s: Settings, a: IssueAnnouncement): Promise<void> {
  const base = `https://api.telegram.org/bot${s.telegramToken}`;
  const text = messageText(a, 'telegram');
  // A public demo URL (GitHub-hosted GIF) can go as an animation with caption.
  const asAnimation = a.demoUrl && /raw\.githubusercontent\.com|\.gif($|\?)/i.test(a.demoUrl);
  const res = await fetch(`${base}/${asAnimation ? 'sendAnimation' : 'sendMessage'}`, {
    method: 'POST',
    body: new URLSearchParams(
      asAnimation
        ? { chat_id: s.telegramChatId!, animation: a.demoUrl!, caption: text.slice(0, 1000) }
        : { chat_id: s.telegramChatId!, text },
    ),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(json.description ?? 'telegram error');
}

/** Announce to every configured service; returns the names that failed. */
export async function announceIssue(settings: Settings, a: IssueAnnouncement): Promise<string[]> {
  if (settings.notifyOnCreate === false) return [];
  const failed: string[] = [];
  if (settings.slackToken && settings.slackChannelId) {
    try {
      await announceSlack(settings, a);
    } catch {
      failed.push('Slack');
    }
  }
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      await announceTelegram(settings, a);
    } catch {
      failed.push('Telegram');
    }
  }
  return failed;
}

/** Slack channels for the Settings dropdown (chat:write + channels:read). */
export async function listSlackChannels(
  token: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch('https://slack.com/api/conversations.list', {
    method: 'POST',
    body: new URLSearchParams({
      token,
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    channels?: Array<{ id: string; name: string }>;
  };
  if (!json.ok) throw new Error(json.error ?? 'slack error');
  return (json.channels ?? []).map((c) => ({ id: c.id, name: c.name }));
}
