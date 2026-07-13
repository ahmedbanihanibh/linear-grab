import { saveSettings } from '../storage';

/** RFC 7636 base64url without padding. */
function b64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * OAuth 2.0 + PKCE (S256) against Linear as a public client — no server, no secret.
 * Requires an OAuth app registered in the Linear workspace with the extension's
 * `https://<ext-id>.chromiumapp.org/` callback URL.
 */
export async function oauthLogin(clientId: string): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(challengeBytes));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = chrome.identity.getRedirectURL();

  const authorize = new URL('https://linear.app/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'read,write');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authorize.toString(),
    interactive: true,
  });
  if (!resultUrl) throw new Error('OAuth flow was cancelled');

  const params = new URL(resultUrl).searchParams;
  if (params.get('state') !== state) throw new Error('OAuth state mismatch');
  const code = params.get('code');
  if (!code) throw new Error(params.get('error_description') ?? 'No authorization code returned');

  const tokenRes = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!tokenRes.ok || !token?.access_token) {
    throw new Error('Token exchange failed — check the OAuth app callback URL and client id');
  }

  await saveSettings({ linearAccessToken: token.access_token, linearOauthClientId: clientId });
}

export async function disconnectLinear(): Promise<void> {
  await saveSettings({ linearAccessToken: undefined, linearApiKey: undefined });
}
