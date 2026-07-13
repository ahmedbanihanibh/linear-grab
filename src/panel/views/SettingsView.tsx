import { createSignal, createMemo, Show, For } from 'solid-js';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { getSettings, saveSettings } from '@/lib/storage';
import { isExtensionContext } from '@/lib/env';
import { fetchViewer, fetchTeams, fetchAgents, fetchProjects, fetchLabels } from '@/lib/linear/api';
import { oauthLogin, disconnectLinear } from '@/lib/linear/auth';
import { MODELS, resolveProvider } from '@/lib/ai/providers';
import { listSlackChannels } from '@/lib/notify';
import {
  Button,
  Input,
  Select,
  Field,
  Section,
  Textarea,
  ErrorNote,
} from '../components/ui';
import { DEFAULT_AGENT_INSTRUCTIONS } from '@/lib/ai/prompt';
import type { Settings, AiProvider } from '@/lib/types';

export default function SettingsView() {
  const qc = useQueryClient();

  // ── Settings query ──────────────────────────────────────────────────────────
  const settingsQ = createQuery(() => ({
    queryKey: ['settings'],
    queryFn: getSettings,
    staleTime: 0,
  }));

  const s = createMemo<Settings>(() => settingsQ.data ?? {});

  async function update(patch: Partial<Settings>, invalidateAuth = false) {
    await saveSettings(patch);
    await qc.invalidateQueries({ queryKey: ['settings'] });
    if (invalidateAuth) {
      await qc.invalidateQueries({ queryKey: ['viewer'] });
      await qc.invalidateQueries({ queryKey: ['teams'] });
      await qc.invalidateQueries({ queryKey: ['agents'] });
      await qc.invalidateQueries({ queryKey: ['my-issues'] });
    }
  }

  // ── Connected state ─────────────────────────────────────────────────────────
  const connected = createMemo(() => !!(s().linearApiKey || s().linearAccessToken));

  // ── Viewer query (only when connected) ──────────────────────────────────────
  const viewerQ = createQuery(() => ({
    queryKey: ['viewer'],
    queryFn: fetchViewer,
    enabled: connected(),
    retry: 0,
  }));

  // ── Teams + agents (only when connected) ────────────────────────────────────
  const teamsQ = createQuery(() => ({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: connected(),
  }));

  const projectsQ = createQuery(() => ({
    queryKey: ['linear-projects'],
    queryFn: fetchProjects,
    enabled: connected(),
  }));
  const labelsQ = createQuery(() => ({
    queryKey: ['linear-labels'],
    queryFn: fetchLabels,
    enabled: connected(),
  }));

  const agentsQ = createQuery(() => ({
    queryKey: ['agents'],
    queryFn: fetchAgents,
    enabled: connected(),
  }));

  // ── Linear personal API key connect ─────────────────────────────────────────
  const [apiKeyDraft, setApiKeyDraft] = createSignal('');
  const [connectingKey, setConnectingKey] = createSignal(false);
  const [keyError, setKeyError] = createSignal('');

  async function connectWithKey() {
    const key = apiKeyDraft().trim();
    if (!key) return;
    setConnectingKey(true);
    setKeyError('');
    try {
      await update({ linearApiKey: key }, true);
      // Verify the key by attempting to fetch viewer
      await fetchViewer();
      setApiKeyDraft('');
    } catch {
      setKeyError('Key rejected — could not verify. Check the key and try again.');
      await update({ linearApiKey: undefined }, true);
    } finally {
      setConnectingKey(false);
    }
  }

  // ── OAuth connect ────────────────────────────────────────────────────────────
  const [oauthClientIdDraft, setOauthClientIdDraft] = createSignal('');
  const [connectingOauth, setConnectingOauth] = createSignal(false);
  const [oauthError, setOauthError] = createSignal('');

  async function connectWithOauth() {
    const clientId = (oauthClientIdDraft() || s().linearOauthClientId || '').trim();
    if (!clientId) {
      setOauthError('Enter an OAuth client ID first.');
      return;
    }
    setConnectingOauth(true);
    setOauthError('');
    try {
      await oauthLogin(clientId);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['viewer'] });
      await qc.invalidateQueries({ queryKey: ['teams'] });
      await qc.invalidateQueries({ queryKey: ['agents'] });
      await qc.invalidateQueries({ queryKey: ['my-issues'] });
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'OAuth flow failed.');
    } finally {
      setConnectingOauth(false);
    }
  }

  // ── Disconnect ───────────────────────────────────────────────────────────────
  const [disconnecting, setDisconnecting] = createSignal(false);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectLinear();
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['viewer'] });
      await qc.invalidateQueries({ queryKey: ['teams'] });
      await qc.invalidateQueries({ queryKey: ['agents'] });
      await qc.invalidateQueries({ queryKey: ['my-issues'] });
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Redirect URL — OAuth is extension-only (chrome.identity); page mode
  // (Safari/Firefox/any browser) uses personal API keys. ──────────────────────
  const redirectUrl = isExtensionContext ? chrome.identity.getRedirectURL() : null;

  // ── Slack channels (for the notifications dropdown) ─────────────────────────
  const slackChannelsQ = createQuery(() => ({
    queryKey: ['slack-channels', s().slackToken],
    queryFn: () => listSlackChannels(s().slackToken!),
    enabled: !!s().slackToken,
    retry: 0,
    staleTime: 60_000,
  }));

  // ── AI provider ──────────────────────────────────────────────────────────────
  const activeProvider = createMemo(() => resolveProvider(s()));

  const providerSummary = createMemo(() => {
    const p = activeProvider();
    if (!p) return null;
    return `Drafting with ${p} — ${MODELS[p].fast} (fast) / ${MODELS[p].best} (best)`;
  });

  return (
    <div class="flex h-full flex-col gap-5 overflow-y-auto pt-3 pb-6 pl-3 pr-4">
      {/* ── 0. WORKFLOW ───────────────────────────────────────────────────────── */}
      <Section title="Workflow">
        <div class="bg-surface-2 border-border flex rounded-md border p-0.5">
          <For
            each={[
              { id: 'cloud', label: 'Cloud · Linear + Cursor' },
              { id: 'local', label: 'Local · clipboard' },
            ] as const}
          >
            {(mode) => (
              <button
                class={`flex-1 rounded-[5px] px-2 py-1 text-[11.5px] font-medium transition-colors ${
                  (s().workflowMode ?? 'cloud') === mode.id
                    ? 'bg-surface-3 text-text'
                    : 'text-text-dim hover:text-text cursor-pointer'
                }`}
                onClick={() => void update({ workflowMode: mode.id })}
              >
                {mode.label}
              </button>
            )}
          </For>
        </div>
        <span class="text-text-faint text-[10.5px] leading-snug">
          Cloud: picking an element opens the panel to draft &amp; delegate to the Cursor agent.
          Local (react-grab style): picking auto-copies the element's context — source,
          stack, and your skills/memory paths — straight to the clipboard for a local
          Claude Code or Cursor session; the panel stays out of the way. Both share the
          same picker; switch anytime.
        </span>
      </Section>

      {/* ── 0.5 CAPTURE ───────────────────────────────────────────────────────── */}
      <Section title="Capture">
        <label class="flex cursor-pointer items-center gap-2 select-none">
          <input
            type="checkbox"
            checked={!!s().captureShots}
            onChange={(e) => void update({ captureShots: e.currentTarget.checked || undefined })}
            class="accent-accent rounded"
          />
          <span class="text-text text-[12px]">Element screenshots</span>
        </label>
        <span class="text-text-faint text-[10.5px] leading-snug">
          Captures a highlighted screenshot of each picked element and attaches it
          to the issue. Costs a beat on huge pages — with this off, picking is
          instant (pure react-grab speed).
        </span>
      </Section>

      {/* ── 1. LINEAR ─────────────────────────────────────────────────────────── */}
      <Section title="Linear">
        <Show
          when={connected()}
          fallback={
            <div class="flex flex-col gap-3">
              {/* Personal API key */}
              <Field
                label="Personal API key"
                hint="Create one at linear.app → Settings → API — fastest path."
              >
                <div class="flex gap-1.5">
                  <Input
                    type="password"
                    placeholder="lin_api_…"
                    value={apiKeyDraft()}
                    onInput={(e) => setApiKeyDraft(e.currentTarget.value)}
                    on:keydown={(e) => { if (e.key === 'Enter') void connectWithKey(); }}
                  />
                  <Button
                    variant="primary"
                    loading={connectingKey()}
                    disabled={!apiKeyDraft().trim()}
                    onClick={() => void connectWithKey()}
                    class="shrink-0"
                  >
                    Connect
                  </Button>
                </div>
                <Show when={keyError()}>
                  <ErrorNote message={keyError()} />
                </Show>
              </Field>

              {/* OAuth — extension-only: chrome.identity has no page/Safari equivalent */}
              <Show when={isExtensionContext}>
                <p class="text-text-faint text-center text-[10.5px]">or</p>

                <Field label="OAuth client ID">
                  <div class="flex gap-1.5">
                    <Input
                      placeholder="your-client-id"
                      value={oauthClientIdDraft() || s().linearOauthClientId || ''}
                      onInput={(e) => setOauthClientIdDraft(e.currentTarget.value)}
                    />
                    <Button
                      variant="ghost"
                      loading={connectingOauth()}
                      onClick={() => void connectWithOauth()}
                      class="shrink-0 whitespace-nowrap"
                    >
                      Connect with OAuth
                    </Button>
                  </div>
                  <Show when={oauthError()}>
                    <ErrorNote message={oauthError()} />
                  </Show>
                  <span class="text-text-faint text-[10.5px] leading-snug">
                    Register this callback URL in your Linear OAuth app config:
                    <br />
                    <span class="font-mono text-[10.5px] break-all">{redirectUrl}</span>
                  </span>
                </Field>
              </Show>
            </div>
          }
        >
          {/* Connected card */}
          <div class="bg-surface border-border flex items-center justify-between rounded-lg border p-2.5">
            <span class="text-text text-[12px]">
              <Show
                when={!viewerQ.isLoading}
                fallback={<span class="text-text-dim">Connected — verifying…</span>}
              >
                <Show
                  when={viewerQ.data}
                  fallback={
                    <Show
                      when={viewerQ.isError}
                      fallback={<span class="text-text-dim">Connected — verifying…</span>}
                    >
                      <ErrorNote message="Key rejected — reconnect" />
                    </Show>
                  }
                >
                  <span class="text-text">
                    Connected as{' '}
                    <span class="font-medium">{viewerQ.data!.name}</span>
                    {' · '}
                    <span class="text-text-dim">{viewerQ.data!.email}</span>
                  </span>
                </Show>
              </Show>
            </span>
            <Button
              variant="ghost"
              loading={disconnecting()}
              onClick={() => void handleDisconnect()}
              class="ml-2 shrink-0"
            >
              Disconnect
            </Button>
          </div>
        </Show>
      </Section>

      {/* ── 2. WORKSPACE ──────────────────────────────────────────────────────── */}
      <Show when={connected()}>
        <Section title="Workspace">
          {/* Default team */}
          <Field label="Default team">
            <Select
              value={s().defaultTeamId ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                void update({ defaultTeamId: v || undefined });
              }}
              disabled={teamsQ.isLoading}
            >
              <option value="">Select a team…</option>
              <Show when={teamsQ.data}>
                <For each={teamsQ.data!}>
                  {(team) => (
                    // selected attr required: options arrive async, the Select's
                    // value prop won't re-apply once they render (looked "not saved").
                    <option value={team.id} selected={team.id === s().defaultTeamId}>
                      {team.name} ({team.key})
                    </option>
                  )}
                </For>
              </Show>
            </Select>
          </Field>

          {/* Default project + labels — issues land organized, not floating */}
          <Field
            label="Default project"
            hint="Every issue created from the panel is filed into this project."
          >
            <Select
              value={s().defaultProjectId ?? ''}
              onChange={(e) => void update({ defaultProjectId: e.currentTarget.value || undefined })}
              disabled={projectsQ.isLoading}
            >
              <option value="" selected={!s().defaultProjectId}>
                No project
              </option>
              <For each={projectsQ.data ?? []}>
                {(pr) => (
                  <option value={pr.id} selected={pr.id === s().defaultProjectId}>
                    {pr.name}
                  </option>
                )}
              </For>
            </Select>
          </Field>
          <Field label="Default labels" hint="Applied to every issue created from the panel.">
            <div class="flex flex-wrap gap-1">
              <For each={labelsQ.data ?? []}>
                {(lb) => {
                  const active = () => (s().defaultLabelIds ?? []).includes(lb.id);
                  return (
                    <button
                      type="button"
                      class={`h-6 cursor-pointer rounded-full border px-2.5 text-[11px] font-medium transition-colors ${
                        active()
                          ? 'bg-accent-soft text-accent border-accent/40'
                          : 'bg-surface-2 text-text-dim border-border hover:bg-surface-3'
                      }`}
                      onClick={() => {
                        const cur = s().defaultLabelIds ?? [];
                        void update({
                          defaultLabelIds: active()
                            ? cur.filter((id) => id !== lb.id)
                            : [...cur, lb.id],
                        });
                      }}
                    >
                      <span
                        class="mr-1 inline-block size-2 rounded-full align-middle"
                        style={{ background: lb.color }}
                      />
                      {lb.name}
                    </button>
                  );
                }}
              </For>
            </div>
          </Field>

          <label class="flex items-start gap-2">
            <input
              type="checkbox"
              class="accent-accent mt-0.5"
              checked={!!s().shareLinearKey}
              onChange={(e) => void update({ shareLinearKey: e.currentTarget.checked })}
            />
            <span class="flex flex-col gap-0.5">
              <span class="text-[12px]">Let agents close out Linear themselves</span>
              <span class="text-text-faint text-[10.5px] leading-snug">
                Embeds your Linear API key + raw GraphQL closeout recipes in every
                issue's Agent instructions — cloud agent VMs have no authenticated
                Linear MCP, so without this they can't comment, attach media, or
                move the issue. The key is visible to anyone who can read the issue.
              </span>
            </span>
          </label>

          {/* Cursor agent */}
          <Field
            label="Cursor agent"
            hint="App users in your workspace. Pick Cursor — requires the Cursor integration installed in Linear (workspace admin) with usage-based pricing enabled in Cursor."
          >
            <Show
              when={agentsQ.data && agentsQ.data.length === 0}
              fallback={
                <Select
                  value={s().cursorAgentId ?? ''}
                  onChange={(e) => {
                    const id = e.currentTarget.value;
                    if (!id) {
                      void update({ cursorAgentId: undefined, cursorAgentName: undefined, cursorAgentUrl: undefined });
                      return;
                    }
                    const user = agentsQ.data?.find((u) => u.id === id);
                    if (user) {
                      void update({
                        cursorAgentId: user.id,
                        cursorAgentName: user.displayName,
                        cursorAgentUrl: user.url ?? undefined,
                      });
                    }
                  }}
                  disabled={agentsQ.isLoading}
                >
                  <option value="">Select the agent…</option>
                  <Show when={agentsQ.data}>
                    <For each={agentsQ.data!}>
                      {(agent) => (
                        <option value={agent.id} selected={agent.id === s().cursorAgentId}>
                          {agent.displayName}
                        </option>
                      )}
                    </For>
                  </Show>
                </Select>
              }
            >
              <p class="text-text-dim text-[11px]">
                No agents found — install the Cursor integration in Linear first.
              </p>
            </Show>
          </Field>

          {/* Default repository */}
          <Field
            label="Default repository"
            hint="Appended to delegated issues as [repo=…] so Cursor picks the right repo."
          >
            <Input
              placeholder="owner/repository"
              value={s().defaultRepo ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ defaultRepo: v || undefined });
              }}
            />
          </Field>

          {/* Cursor cloud agent model */}
          <Field
            label="Cursor cloud model"
            hint="Appended as [model=…] — e.g. claude-opus-4-8, gpt-5.2, composer. Empty = Cursor's default."
          >
            <Input
              placeholder="Cursor's default"
              value={s().cursorModel ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ cursorModel: v || undefined });
              }}
            />
          </Field>

          {/* Standing agent instructions */}
          <Field
            label="Agent instructions"
            hint="Appended to every issue as '### Agent instructions' and given to the AI draft. Add demo credentials (username/password) so the agent can log in, test, and record its video. Careful: credentials become visible to everyone who can read the issue."
          >
            <Textarea
              rows={5}
              placeholder={DEFAULT_AGENT_INSTRUCTIONS}
              value={s().issueTemplate ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ issueTemplate: v || undefined });
              }}
            />
            <span class="text-text-faint text-[10.5px] leading-snug">
              Empty = the default above (computer-use testing, video demo, PR + review babysitting).
            </span>
          </Field>

          {/* Dev server logs */}
          <Field
            label="Dev server log URL"
            hint={'Tail of your dev-server log attached to issues (and fed to AI drafts). Serve the log over HTTP: "dev:http": "next dev 2>&1 | tee public/dev-server.log" (gitignore it), then use /dev-server.log here. Empty = disabled.'}
          >
            <Input
              placeholder="/dev-server.log"
              value={s().logUrl ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ logUrl: v || undefined });
              }}
            />
          </Field>
          <Field label="Log lines to attach" hint="Trailing lines included in the issue (10–500).">
            <Input
              type="number"
              min="10"
              max="500"
              placeholder="100"
              value={s().logLines ?? ''}
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                void update({ logLines: Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(10, Math.round(n))) : undefined });
              }}
            />
          </Field>

          {/* Skills & memory pointers for the agent */}
          <Field
            label="Skills & memory paths"
            hint="One path per line. The cloud agent works in a full repo checkout, so committed paths (e.g. .claude/skills/apple-hig-design-principles) are readable directly — every issue gets a MANDATORY-reading section pointing at them. Repo-relative for cloud agents; absolute paths also work when you paste the issue into a local Claude Code session. Per project: these settings live per dev origin."
          >
            <Textarea
              rows={4}
              placeholder={'.claude/skills/apple-hig-design-principles\n.claude/CLAUDE.md\ndocs/design-tokens.md'}
              value={s().skillPaths ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ skillPaths: v || undefined });
              }}
            />
          </Field>

          {/* Test account for the agent's in-app testing */}
          <Field
            label="Test account"
            hint="The cloud agent logs into the app with this while testing and recording its demo. Added to every issue's Agent instructions. Use a throwaway account — it's visible to everyone who can read the issue."
          >
            <div class="flex flex-col gap-1.5">
              <Input
                placeholder="Username or email (e.g. demo@yourapp.com)"
                value={s().testUsername ?? ''}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  void update({ testUsername: v || undefined });
                }}
              />
              <Input
                type="password"
                placeholder="Password"
                value={s().testPassword ?? ''}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  void update({ testPassword: v || undefined });
                }}
              />
            </div>
          </Field>
        </Section>
      </Show>

      {/* ── PANEL (page mode only) ────────────────────────────────────────────── */}
      <Show when={!isExtensionContext}>
        <Section title="Panel">
          <div class="flex flex-col gap-1">
            <span class="text-text-dim text-[11px] font-medium">Mode</span>
            <div class="bg-surface-2 border-border flex rounded-md border p-0.5">
              <For each={[{ id: 'overlay', label: 'Overlay' }, { id: 'pinned', label: 'Beside page' }] as const}>
                {(mode) => (
                  <button
                    class={`flex-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                      (s().panelMode ?? 'overlay') === mode.id
                        ? 'bg-surface-3 text-text'
                        : 'text-text-dim hover:text-text cursor-pointer'
                    }`}
                    onClick={() => void update({ panelMode: mode.id, panelPos: undefined })}
                  >
                    {mode.label}
                  </button>
                )}
              </For>
            </div>
            <span class="text-text-faint text-[10.5px] leading-snug">
              Beside page squeezes the app next to the panel, DevTools-style — nothing gets covered. Also toggleable from the dock icon in the panel header.
            </span>
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-text-dim text-[11px] font-medium">Dock side</span>
            <div class="bg-surface-2 border-border flex rounded-md border p-0.5">
              <For each={['left', 'right'] as const}>
                {(side) => (
                  <button
                    class={`flex-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                      (s().panelSide ?? 'right') === side
                        ? 'bg-surface-3 text-text'
                        : 'text-text-dim hover:text-text cursor-pointer'
                    }`}
                    onClick={() => void update({ panelSide: side })}
                  >
                    {side === 'left' ? 'Left' : 'Right'}
                  </button>
                )}
              </For>
            </div>
            <span class="text-text-faint text-[10.5px] leading-snug">
              The launcher pill is draggable — park it anywhere it doesn't cover your app.
            </span>
          </div>
        </Section>
      </Show>

      {/* ── 2.4 LOCAL CLAUDE CODE BRIDGE ─────────────────────────────────────── */}
      <Section title="Local Claude Code">
        <Field
          label="Bridge URL"
          hint={'Run `npx linear-grab-bridge` in your repo\'s terminal (binds localhost only). Enables "Delegate to → Local Claude Code" in Draft, the Local tab, and relays blocked uploads to Linear storage.'}
        >
          <Input
            placeholder="http://localhost:4577"
            value={s().bridgeUrl ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ bridgeUrl: v || undefined });
            }}
          />
        </Field>
      </Section>

      {/* ── 2.5 ASSET UPLOADS FALLBACK ────────────────────────────────────────── */}
      <Section title="Asset uploads">
        <Field
          label="GitHub token"
          hint="Linear's storage blocks browser uploads in some browsers (Safari). With this set, GIFs/screenshots upload to your GitHub repo instead and embed automatically. Fine-grained PAT with Contents read/write on the assets repo."
        >
          <Input
            type="password"
            placeholder="github_pat_…"
            value={s().githubToken ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ githubToken: v || undefined });
            }}
          />
        </Field>
        <Field
          label="Assets repository"
          hint="owner/repo — must be PUBLIC so Linear (and agents) can render the images. Files land under linear-grab/."
        >
          <Input
            placeholder="ahmedbanihanibh/linear-grab-assets"
            value={s().githubAssetsRepo ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ githubAssetsRepo: v || undefined });
            }}
          />
        </Field>
      </Section>

      {/* ── 2.7 NOTIFICATIONS ─────────────────────────────────────────────────── */}
      <Section title="Notifications">
        <Field
          label="Slack bot token"
          hint="Bot token (xoxb-…) with chat:write + channels:read + files:write. New issues get announced with links + demo, and the AGENT receives the token to post its finished demo video itself."
        >
          <Input
            type="password"
            placeholder="xoxb-…"
            value={s().slackToken ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ slackToken: v || undefined });
            }}
          />
        </Field>
        <Show when={s().slackToken}>
          <Field label="Slack channel">
            <Show
              when={!slackChannelsQ.isError}
              fallback={<ErrorNote message="Couldn't list channels — check the token scopes (channels:read)." />}
            >
              <Select
                value={s().slackChannelId ?? ''}
                disabled={slackChannelsQ.isLoading}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  const ch = slackChannelsQ.data?.find((c) => c.id === id);
                  void update({
                    slackChannelId: id || undefined,
                    slackChannelName: ch?.name,
                  });
                }}
              >
                <option value="">Select a channel…</option>
                <For each={slackChannelsQ.data ?? []}>
                  {(ch) => (
                    <option value={ch.id} selected={ch.id === s().slackChannelId}>
                      #{ch.name}
                    </option>
                  )}
                </For>
              </Select>
            </Show>
          </Field>
        </Show>

        <Field
          label="Telegram bot token"
          hint="From @BotFather. The agent also receives it to send the demo video (sendVideo)."
        >
          <Input
            type="password"
            placeholder="123456:ABC-…"
            value={s().telegramToken ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ telegramToken: v || undefined });
            }}
          />
        </Field>
        <Show when={s().telegramToken}>
          <Field
            label="Telegram chat ID"
            hint="Add the bot to your group/channel, send a message, then read the chat id from api.telegram.org/bot<token>/getUpdates."
          >
            <Input
              placeholder="-1001234567890"
              value={s().telegramChatId ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                void update({ telegramChatId: v || undefined });
              }}
            />
          </Field>
        </Show>

        <label class="flex cursor-pointer items-center gap-2 select-none">
          <input
            type="checkbox"
            checked={s().notifyOnCreate !== false}
            onChange={(e) => void update({ notifyOnCreate: e.currentTarget.checked ? undefined : false })}
            class="accent-accent rounded"
          />
          <span class="text-text text-[12px]">Announce new issues on create</span>
        </label>
        <span class="text-text-faint text-[10.5px] leading-snug">
          ⚠️ Tokens are embedded in issue Agent-instructions so agents can post the
          finished demo — everyone who can read the issue can read them. Use
          single-channel-scoped bots.
        </span>
      </Section>

      {/* ── 3. AI PROVIDERS ───────────────────────────────────────────────────── */}
      <Section title="AI providers">
        {/* OpenAI key */}
        <Field label="OpenAI API key">
          <Input
            type="password"
            placeholder="sk-…"
            value={s().openaiKey ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ openaiKey: v || undefined });
            }}
          />
        </Field>

        {/* Anthropic key */}
        <Field label="Anthropic API key">
          <Input
            type="password"
            placeholder="sk-ant-…"
            value={s().anthropicKey ?? ''}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              void update({ anthropicKey: v || undefined });
            }}
          />
        </Field>

        {/* Provider preference segmented control */}
        <div class="flex flex-col gap-1">
          <span class="text-text-dim text-[11px] font-medium">Provider preference</span>
          <div class="bg-surface-2 border-border flex rounded-md border p-0.5">
            {/* Auto */}
            <button
              class={`flex-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                s().preferredProvider === undefined
                  ? 'bg-surface-3 text-text'
                  : 'text-text-dim hover:text-text cursor-pointer'
              }`}
              onClick={() => void update({ preferredProvider: undefined })}
            >
              Auto
            </button>
            {/* OpenAI */}
            <button
              class={`flex-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed ${
                s().preferredProvider === 'openai'
                  ? 'bg-surface-3 text-text'
                  : 'text-text-dim hover:text-text cursor-pointer disabled:text-text-faint'
              }`}
              disabled={!s().openaiKey}
              onClick={() => void update({ preferredProvider: 'openai' })}
            >
              OpenAI
            </button>
            {/* Anthropic */}
            <button
              class={`flex-1 rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed ${
                s().preferredProvider === 'anthropic'
                  ? 'bg-surface-3 text-text'
                  : 'text-text-dim hover:text-text cursor-pointer disabled:text-text-faint'
              }`}
              disabled={!s().anthropicKey}
              onClick={() => void update({ preferredProvider: 'anthropic' })}
            >
              Anthropic
            </button>
          </div>
        </div>

        {/* Live provider summary — min-h-[2lh] to prevent layout shift on toggle */}
        <div class="min-h-[2lh]">
          <Show
            when={providerSummary()}
            fallback={
              <p class="text-text-dim text-[11px]">
                No key set — AI drafting disabled, manual drafting still works.
              </p>
            }
          >
            <p class="text-text-dim text-[11px]">{providerSummary()}</p>
          </Show>
        </div>
      </Section>

      {/* ── 4. HOW IT WORKS ───────────────────────────────────────────────────── */}
      <Section title="How it works">
        <ol class="text-text-faint flex list-decimal flex-col gap-1 pl-4 text-[11px] leading-relaxed">
          <li>Pick an element on your running dev app.</li>
          <li>Draft the issue (AI optional).</li>
          <li>
            Create + delegate — Cursor's cloud agent fixes it and opens a PR.
          </li>
          <li>Track and steer it from Activity.</li>
        </ol>
      </Section>
    </div>
  );
}
