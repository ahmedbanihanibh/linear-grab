import { gql } from './client';
import { getSettings } from '../storage';

interface FileUploadPayload {
  fileUpload: {
    success: boolean;
    uploadFile: {
      uploadUrl: string;
      assetUrl: string;
      headers: Array<{ key: string; value: string }> | null;
    } | null;
  };
}

/**
 * Upload a file to Linear's asset storage: request a signed URL via the
 * `fileUpload` mutation, PUT the bytes, return the `assetUrl` for embedding
 * as markdown (`![…](assetUrl)`) in issues/comments.
 */
export async function uploadFileToLinear(blob: Blob, filename: string): Promise<string> {
  const data = await gql<FileUploadPayload>(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
    { contentType: blob.type, filename, size: blob.size },
  );

  const uploadFile = data.fileUpload.uploadFile;
  if (!data.fileUpload.success || !uploadFile) {
    throw new Error('Linear did not provide an upload URL.');
  }

  // uploads.linear.app requires the SAME Authorization header as the GraphQL
  // API on the PUT (verified: its 401 says so explicitly). Try the full
  // documented set first, then narrower fallbacks — Safari surfaces every
  // flavor of rejection as an opaque "Load failed".
  const { linearApiKey, linearAccessToken } = await getSettings();
  const auth = linearAccessToken ? `Bearer ${linearAccessToken}` : (linearApiKey ?? '');
  const returned = Object.fromEntries((uploadFile.headers ?? []).map((h) => [h.key, h.value]));
  const attempts: Array<Record<string, string>> = [
    { 'Content-Type': blob.type, ...returned, ...(auth ? { Authorization: auth } : {}) },
    { 'Content-Type': blob.type, ...returned },
    { 'Content-Type': blob.type },
  ];

  let lastError: unknown = null;
  for (const headers of attempts) {
    try {
      const res = await fetch(uploadFile.uploadUrl, {
        method: 'PUT',
        mode: 'cors',
        headers,
        body: blob,
      });
      if (res.ok) return uploadFile.assetUrl;
      lastError = new Error(`Upload rejected (${res.status}).`);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Upload to Linear storage failed${lastError instanceof Error ? ` — ${lastError.message}` : ''}. Use "Copy GIF" and paste it into a Linear comment (Linear uploads it itself), or Download.`,
  );
}
