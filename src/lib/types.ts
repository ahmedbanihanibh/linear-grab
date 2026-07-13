/** Source location resolved by react-grab from React fiber debug info (dev builds only). */
export interface GrabbedSource {
  filePath: string;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

/** One element captured by the in-page picker. */
export interface GrabbedElement {
  tagName?: string;
  componentName?: string;
  /** Formatted reference context (HTML snippet + component trace) produced by react-grab. */
  content: string;
  source?: GrabbedSource | null;
  /** Formatted multi-line component owner stack. */
  stackContext?: string;
  /** Highlighted screenshot of the element in its container (data URL, best-effort). */
  screenshotDataUrl?: string;
  pageUrl: string;
  grabbedAt: number;
}

/** The structured draft the AI streams into the form. Mirror of IssueDraftSchema. */
export interface IssueDraft {
  title: string;
  description: string;
  reproSteps: string[];
  expected: string;
  actual: string;
  impact: string;
  /** Markdown bullets — likely root-cause analysis. */
  analysisNotes: string;
  /** Markdown bullets — concrete fix suggestions. */
  suggestedNextSteps: string;
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  suggestedLabels: string[];
}

export type AiProvider = 'openai' | 'anthropic';
export type AiTier = 'fast' | 'best';

export interface Settings {
  /** Personal API key (primary auth path — works instantly). */
  linearApiKey?: string;
  /** OAuth access token (used when present, takes precedence). */
  linearAccessToken?: string;
  /** OAuth client id for the PKCE flow (optional). */
  linearOauthClientId?: string;
  openaiKey?: string;
  anthropicKey?: string;
  /** Explicit provider choice. Absent = auto (OpenAI first, then Anthropic). */
  preferredProvider?: AiProvider;
  defaultTeamId?: string;
  /** Auto-assigned on every created issue. */
  defaultProjectId?: string;
  defaultLabelIds?: string[];
  /** App-user UUID of the Cursor agent in the workspace. */
  cursorAgentId?: string;
  cursorAgentName?: string;
  cursorAgentUrl?: string;
  /** Default `owner/name` appended as [repo=…] to delegated issues. */
  defaultRepo?: string;
  /** Model override for the Cursor cloud agent, appended as [model=…]. */
  cursorModel?: string;
  /** Standing instructions appended to every issue as "### Agent instructions"
      (demo credentials, "record a video", etc.) and fed to the AI draft. */
  issueTemplate?: string;
  /** Test account the cloud agent uses to log into the app while testing. */
  testUsername?: string;
  testPassword?: string;
  /** Newline-separated skill/memory paths (repo-relative for cloud agents,
      absolute also fine for local agents) injected into every issue. */
  skillPaths?: string;
  /** 'cloud' = grab → draft → delegate to Linear/Cursor. 'local' = react-grab
      style: picking an element auto-copies its context for a local agent. */
  workflowMode?: 'cloud' | 'local';
  /** GitHub fallback for asset uploads (Linear storage blocks browser CORS in
      some browsers). PAT with repo contents write; a PUBLIC repo so Linear
      can render the images. */
  githubToken?: string;
  githubAssetsRepo?: string;
  /** Dev-server log tail attached to issues. URL the log is served at (e.g.
      "/dev-server.log" via `next dev 2>&1 | tee public/dev-server.log`). */
  logUrl?: string;
  /** How many trailing log lines to attach (default 100). */
  logLines?: number;
  /** Local Claude Code bridge URL (`npx linear-grab-bridge`, default :4577). */
  bridgeUrl?: string;
  /** Capture a highlighted screenshot per picked element. OFF by default —
      the DOM capture costs a beat on huge pages; picking stays instant without it. */
  captureShots?: boolean;
  /** Slack announcements: bot token (xoxb-…, scopes chat:write + channels:read
      + files:write) and the target channel. */
  slackToken?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  /** Telegram announcements: bot token + chat id. */
  telegramToken?: string;
  telegramChatId?: string;
  /** Announce new issues on create (default true when a service is configured). */
  notifyOnCreate?: boolean;
  /** Page mode: which edge the panel docks to by default. */
  panelSide?: 'left' | 'right';
  /** Page mode: 'overlay' floats over the app; 'pinned' squeezes the page
      beside the panel, DevTools-style. */
  panelMode?: 'overlay' | 'pinned';
  /** Page mode: persisted launcher pill position (viewport px from left/top). */
  launcherPos?: { x: number; y: number };
  /** Page mode: persisted free-floating panel position. */
  panelPos?: { x: number; y: number };
  /** Page mode: persisted panel width (drag-resizable, DevTools-style). */
  panelWidth?: number;
}

// ---- Linear API shapes (thin, only what the UI needs) ----

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearAgentUser {
  id: string;
  name: string;
  displayName: string;
  url?: string | null;
  active?: boolean;
}

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  priority: number;
  state: { name: string; color: string; type: string };
  delegate?: { id: string; name?: string; displayName: string } | null;
  assignee?: { displayName: string } | null;
  attachments?: LinearAttachment[];
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user?: { id: string; name?: string; displayName?: string; app?: boolean } | null;
  /** Present when the comment is a threaded reply. */
  parent?: { id: string } | null;
}

export interface LinearAttachment {
  id: string;
  title: string;
  url: string;
  sourceType?: string | null;
}

export interface LinearIssueDetail extends LinearIssueSummary {
  description?: string | null;
  branchName?: string | null;
  comments: LinearComment[];
  attachments: LinearAttachment[];
}

export interface LinearAgentActivity {
  id: string;
  createdAt: string;
  /** Union: thought/response/error/prompt/elicitation carry body; action carries action+parameter(+result). */
  content: {
    __typename?: string;
    body?: string;
    action?: string;
    parameter?: string;
    result?: string | null;
  };
}

export interface LinearAgentSession {
  id: string;
  status: string;
  summary?: string | null;
  updatedAt: string;
  createdAt?: string;
  appUser?: { displayName: string } | null;
  /** Thread-root comment — threaded replies here steer the RUNNING agent. */
  comment?: { id: string } | null;
  /** Present on the workspace-wide fleet query; absent on per-issue fetches. */
  issue?: {
    id: string;
    identifier: string;
    title: string;
    url: string;
    state: { name: string; color: string; type: string };
  } | null;
  activities: LinearAgentActivity[];
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  priority?: number;
  delegateId?: string;
  projectId?: string;
  labelIds?: string[];
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

// ---- Extension messaging ----

/** window.postMessage envelope between MAIN-world grab script and isolated bridge. */
export interface PageMessage {
  __lineargrab: true;
  type: 'activate' | 'selected';
  elements?: GrabbedElement[];
}

export type RuntimeMessage =
  | { type: 'grab/selected'; payload: GrabbedElement[] }
  | { type: 'grab/updated' }
  | { type: 'grab/activate' };

/** Port protocol for AI drafting (port name: 'ai-draft'). */
export interface DraftInput {
  note: string;
  grabbed: GrabbedElement | null;
  teamName?: string;
  tier: AiTier;
  /** Standing agent instructions (settings.issueTemplate) — context for the AI. */
  template?: string;
  /** Recent dev-server log tail — lets the AI ground its root-cause analysis. */
  logs?: string;
  /** All captured elements when more than one (grabbed stays the primary). */
  grabbedList?: GrabbedElement[];
}

export type DraftPortClientMessage = { type: 'start'; input: DraftInput };

export type DraftPortServerMessage =
  | { type: 'partial'; draft: Partial<IssueDraft> }
  | { type: 'done'; draft: IssueDraft; provider: AiProvider; modelId: string; fellBack: boolean }
  | { type: 'error'; message: string; code?: 'no-provider' | 'auth' | 'unknown' };
