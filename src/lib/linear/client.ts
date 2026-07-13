import { getSettings } from '../storage';

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

export class LinearNotConnectedError extends LinearError {
  constructor() {
    super('Not connected to Linear. Add an API key or connect OAuth in Settings.');
    this.name = 'LinearNotConnectedError';
  }
}

/** Minimal GraphQL client. Personal API keys go raw in Authorization; OAuth tokens as Bearer. */
export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { linearApiKey, linearAccessToken } = await getSettings();
  const auth = linearAccessToken ? `Bearer ${linearAccessToken}` : linearApiKey;
  if (!auth) throw new LinearNotConnectedError();

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: Array<{ message: string }>;
  } | null;

  if (!res.ok) {
    throw new LinearError(json?.errors?.[0]?.message ?? `Linear request failed (${res.status})`, res.status);
  }
  if (json?.errors?.length) throw new LinearError(json.errors[0].message);
  if (!json?.data) throw new LinearError('Empty response from Linear');
  return json.data;
}
