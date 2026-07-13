import { gql } from './client';
import type {
  CreatedIssue,
  CreateIssueInput,
  LinearAgentSession,
  LinearComment,
  LinearAgentUser,
  LinearIssueDetail,
  LinearIssueSummary,
  LinearTeam,
  LinearViewer,
} from '../types';

export async function fetchViewer(): Promise<LinearViewer> {
  const data = await gql<{ viewer: LinearViewer }>(`query { viewer { id name email } }`);
  return data.viewer;
}

export async function fetchTeams(): Promise<LinearTeam[]> {
  const data = await gql<{ teams: { nodes: LinearTeam[] } }>(
    `query { teams(first: 50) { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

/** App users (agents) in the workspace — Cursor appears here once its Linear integration is installed. */
export async function fetchAgents(): Promise<LinearAgentUser[]> {
  const data = await gql<{ users: { nodes: LinearAgentUser[] } }>(
    `query {
      users(filter: { app: { eq: true } }) {
        nodes { id name displayName url active }
      }
    }`,
  );
  return data.users.nodes.filter((u) => u.active !== false);
}

export async function fetchMyIssues(): Promise<LinearIssueSummary[]> {
  const data = await gql<{
    issues: {
      nodes: Array<
        Omit<LinearIssueSummary, 'attachments'> & {
          attachments: { nodes: NonNullable<LinearIssueSummary['attachments']> };
        }
      >;
    };
  }>(
    `query {
      issues(
        first: 50
        orderBy: updatedAt
        filter: { creator: { isMe: { eq: true } } }
      ) {
        nodes {
          id identifier title url updatedAt priority
          state { name color type }
          delegate { id name displayName }
          assignee { displayName }
          attachments(first: 10) { nodes { id title url sourceType } }
        }
      }
    }`,
  );
  return data.issues.nodes.map((n) => ({ ...n, attachments: n.attachments.nodes }));
}

export async function fetchIssueDetail(id: string): Promise<LinearIssueDetail> {
  const data = await gql<{
    issue: Omit<LinearIssueDetail, 'comments' | 'attachments'> & {
      comments: { nodes: LinearIssueDetail['comments'] };
      attachments: { nodes: LinearIssueDetail['attachments'] };
    };
  }>(
    `query($id: String!) {
      issue(id: $id) {
        id identifier title url updatedAt priority description branchName
        state { name color type }
        delegate { id name displayName }
        assignee { displayName }
        comments(first: 50) {
          nodes { id body createdAt parent { id } user { id name displayName app } }
        }
        attachments(first: 20) {
          nodes { id title url sourceType }
        }
      }
    }`,
    { id },
  );
  const { comments, attachments, ...rest } = data.issue;
  return { ...rest, comments: comments.nodes, attachments: attachments.nodes };
}

/**
 * Agent sessions for an issue. The field is schema-verified but the agent-session API
 * surface is newer than the rest — treat failures as "no sessions" so the detail view
 * never breaks on workspaces/plans where it is unavailable.
 */
export async function fetchAgentSessions(issueId: string): Promise<LinearAgentSession[]> {
  try {
    const data = await gql<{
      issue: {
        agentSessions: {
          nodes: Array<
            Omit<LinearAgentSession, 'activities'> & {
              activities: { nodes: LinearAgentSession['activities'] };
            }
          >;
        };
      };
    }>(
      `query($id: String!) {
        issue(id: $id) {
          agentSessions(first: 10) {
            nodes {
              id status summary updatedAt
              appUser { displayName }
              comment { id }
              activities(first: 50) {
              nodes { id createdAt content {
                    __typename
                    ... on AgentActivityThoughtContent { body }
                    ... on AgentActivityResponseContent { body }
                    ... on AgentActivityErrorContent { body }
                    ... on AgentActivityPromptContent { body }
                    ... on AgentActivityElicitationContent { body }
                    ... on AgentActivityActionContent { action parameter result }
                  } }
            }
            }
          }
        }
      }`,
      { id: issueId },
    );
    return data.issue.agentSessions.nodes.map((s) => ({ ...s, activities: s.activities.nodes }));
  } catch {
    return [];
  }
}

/** Workspace-wide agent sessions — the Cloud tab's fleet view. Newest first. */
export async function fetchAllAgentSessions(): Promise<LinearAgentSession[]> {
  try {
    const data = await gql<{
      agentSessions: {
        nodes: Array<
          Omit<LinearAgentSession, 'activities'> & {
            activities: { nodes: LinearAgentSession['activities'] };
          }
        >;
      };
    }>(
      `query {
        agentSessions(first: 50) {
          nodes {
            id status summary updatedAt createdAt
            appUser { displayName }
            issue { id identifier title url state { name color type } }
            activities(last: 3) {
              nodes { id createdAt content {
                  __typename
                  ... on AgentActivityThoughtContent { body }
                  ... on AgentActivityResponseContent { body }
                  ... on AgentActivityErrorContent { body }
                  ... on AgentActivityPromptContent { body }
                  ... on AgentActivityElicitationContent { body }
                  ... on AgentActivityActionContent { action parameter result }
                } }
            }
          }
        }
      }`,
    );
    return data.agentSessions.nodes
      .map((s) => ({ ...s, activities: s.activities.nodes }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    // last-without-before pagination may be rejected — retry without the
    // activity preview rather than blanking the whole fleet view.
    try {
      const data = await gql<{
        agentSessions: { nodes: Array<Omit<LinearAgentSession, 'activities'>> };
      }>(
        `query {
          agentSessions(first: 50) {
            nodes {
              id status summary updatedAt createdAt
              appUser { displayName }
              issue { id identifier title url state { name color type } }
            }
          }
        }`,
      );
      return data.agentSessions.nodes
        .map((s) => ({ ...s, activities: [] }))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    } catch {
      return [];
    }
  }
}

/** Relevance search for duplicate detection while drafting. Best-effort:
    falls back to empty on schema/permission differences. */
export async function searchIssues(
  term: string,
): Promise<Array<Pick<LinearIssueSummary, 'id' | 'identifier' | 'title' | 'url' | 'state'>>> {
  try {
    const data = await gql<{
      searchIssues: {
        nodes: Array<Pick<LinearIssueSummary, 'id' | 'identifier' | 'title' | 'url' | 'state'>>;
      };
    }>(
      `query($term: String!) {
        searchIssues(term: $term, first: 5) {
          nodes { id identifier title url state { name color type } }
        }
      }`,
      { term },
    );
    return data.searchIssues.nodes;
  } catch {
    return [];
  }
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export async function fetchTeamStates(teamId: string): Promise<LinearWorkflowState[]> {
  const data = await gql<{ team: { states: { nodes: LinearWorkflowState[] } } }>(
    `query($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type position } } }
    }`,
    { teamId },
  );
  return data.team.states.nodes;
}

export async function updateIssueState(issueId: string, stateId: string): Promise<void> {
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId },
  );
  if (!data.issueUpdate.success) throw new Error('Linear rejected the state update');
}

export async function fetchProjects(): Promise<Array<{ id: string; name: string }>> {
  try {
    const data = await gql<{ projects: { nodes: Array<{ id: string; name: string }> } }>(
      `query { projects(first: 100) { nodes { id name } } }`,
    );
    return data.projects.nodes;
  } catch {
    return [];
  }
}

export async function fetchLabels(): Promise<Array<{ id: string; name: string; color: string }>> {
  try {
    const data = await gql<{
      issueLabels: { nodes: Array<{ id: string; name: string; color: string }> };
    }>(`query { issueLabels(first: 100) { nodes { id name color } } }`);
    return data.issueLabels.nodes;
  } catch {
    return [];
  }
}

/** Create an issue; when `delegateId` is the Cursor app user, this triggers its cloud agent. */
export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const data = await gql<{ issueCreate: { success: boolean; issue: CreatedIssue | null } }>(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    { input },
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear rejected the issue create');
  }
  return data.issueCreate.issue;
}

export async function createComment(
  issueId: string,
  body: string,
  parentId?: string,
): Promise<void> {
  const data = await gql<{ commentCreate: { success: boolean } }>(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body, ...(parentId ? { parentId } : {}) } },
  );
  if (!data.commentCreate.success) throw new Error('Linear rejected the comment');
}

/**
 * Trigger a NEW agent run: top-level comment @-mentioning the agent (profile-URL
 * markdown resolves to a real mention; falls back to plain @Name). To steer an
 * already-RUNNING agent, do NOT use this — reply in the session's comment thread
 * via createComment(issueId, body, threadRootId), or a second cloud agent spawns.
 */
export async function createSteeringComment(
  issueId: string,
  body: string,
  agent: { name?: string; displayName: string; url?: string | null },
): Promise<void> {
  const label = `@${agent.displayName || agent.name || 'Cursor'}`;
  const mention = agent.url ? `[${label}](${agent.url})` : label;
  await createComment(issueId, `${mention} ${body}`);
}

/**
 * Root comments of agent-session threads, newest first. Replying with
 * parentId = one of these reaches the RUNNING agent instead of spawning a new
 * one. Heuristic: a thread is an agent thread when its root was authored by an
 * app user OR any reply in it was.
 */
export function findAgentThreadRoots(comments: LinearComment[]): LinearComment[] {
  const roots = comments.filter((c) => !c.parent);
  const appThreadRootIds = new Set<string>();
  for (const c of comments) {
    if (!c.user?.app) continue;
    appThreadRootIds.add(c.parent?.id ?? c.id);
  }
  return roots
    .filter((r) => appThreadRootIds.has(r.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
