import { uploadFileToLinear } from './linear/upload';
import { getSettings } from './storage';

/**
 * Asset upload with a working fallback chain:
 *  1. Linear storage (native, but its endpoint rejects cross-origin browser
 *     uploads in some browsers — Safari page mode most notably).
 *  2. GitHub Contents API — full browser CORS support. Files land in the
 *     user's assets repo and the returned raw URL embeds fine in Linear.
 */
export async function uploadAsset(blob: Blob, filename: string): Promise<string> {
  try {
    return await uploadFileToLinear(blob, filename);
  } catch (linearErr) {
    const settings = await getSettings();
    if (settings.githubToken && settings.githubAssetsRepo) {
      return uploadToGitHub(blob, filename, settings.githubToken, settings.githubAssetsRepo);
    }
    throw linearErr instanceof Error
      ? new Error(
          `${linearErr.message} Tip: configure the GitHub assets fallback in Settings for automatic uploads in this browser.`,
        )
      : linearErr;
  }
}

async function uploadToGitHub(
  blob: Blob,
  filename: string,
  token: string,
  repo: string,
): Promise<string> {
  const path = `linear-grab/${Date.now()}-${filename.replace(/[^\w.-]/g, '_')}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `chore(linear-grab): asset ${filename}`,
      content: await blobToBase64(blob),
    }),
  });
  const json = (await res.json().catch(() => null)) as {
    content?: { download_url?: string };
    message?: string;
  } | null;
  if (!res.ok || !json?.content?.download_url) {
    throw new Error(`GitHub asset upload failed — ${json?.message ?? `HTTP ${res.status}`}`);
  }
  return json.content.download_url;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
