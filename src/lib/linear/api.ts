import { gql } from './client';
import type {
  CreatedIssue,
  CreateIssueInput,
  LinearAgentSession,
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
  const data = await gql<{ issues: { nodes: LinearIssueSummary[] } }>(
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
        }
      }
    }`,
  );
  return data.issues.nodes;
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
          nodes { id body createdAt user { id name displayName app } }
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
              activities(first: 50) { nodes { id createdAt content } }
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

export async function createComment(issueId: string, body: string): Promise<void> {
  const data = await gql<{ commentCreate: { success: boolean } }>(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body } },
  );
  if (!data.commentCreate.success) throw new Error('Linear rejected the comment');
}

/**
 * Steering comment for a running agent. Mentions the agent via profile-URL markdown
 * (Linear resolves user-URL links to real mentions); falls back to a plain @Name.
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
