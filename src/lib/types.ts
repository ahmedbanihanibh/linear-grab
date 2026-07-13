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
  content: Record<string, unknown>;
}

export interface LinearAgentSession {
  id: string;
  status: string;
  summary?: string | null;
  updatedAt: string;
  appUser?: { displayName: string } | null;
  activities: LinearAgentActivity[];
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  priority?: number;
  delegateId?: string;
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
}

export type DraftPortClientMessage = { type: 'start'; input: DraftInput };

export type DraftPortServerMessage =
  | { type: 'partial'; draft: Partial<IssueDraft> }
  | { type: 'done'; draft: IssueDraft; provider: AiProvider; modelId: string; fellBack: boolean }
  | { type: 'error'; message: string; code?: 'no-provider' | 'auth' | 'unknown' };
