import { createSignal, createMemo, Show, For } from 'solid-js';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { getSettings, saveSettings } from '@/lib/storage';
import { isExtensionContext } from '@/lib/env';
import { fetchViewer, fetchTeams, fetchAgents } from '@/lib/linear/api';
import { oauthLogin, disconnectLinear } from '@/lib/linear/auth';
import { MODELS, resolveProvider } from '@/lib/ai/providers';
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

  // ── AI provider ──────────────────────────────────────────────────────────────
  const activeProvider = createMemo(() => resolveProvider(s()));

  const providerSummary = createMemo(() => {
    const p = activeProvider();
    if (!p) return null;
    return `Drafting with ${p} — ${MODELS[p].fast} (fast) / ${MODELS[p].best} (best)`;
  });

  return (
    <div class="flex h-full flex-col gap-5 overflow-y-auto pt-3 pb-6 pl-3 pr-4">
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
                    onKeyDown={(e) => { if (e.key === 'Enter') void connectWithKey(); }}
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
