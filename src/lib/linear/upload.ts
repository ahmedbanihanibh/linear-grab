import { gql } from './client';

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

  // Signed-URL uploads are picky: a header not in the signature (or a missing
  // signed one) fails the request. Try the documented set first, then narrower
  // fallbacks — Safari surfaces all of these as an opaque "Load failed".
  const attempts: Array<Record<string, string>> = [
    {
      'Content-Type': blob.type,
      ...Object.fromEntries((uploadFile.headers ?? []).map((h) => [h.key, h.value])),
    },
    { 'Content-Type': blob.type },
    {},
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
    `Upload to Linear storage failed${lastError instanceof Error ? ` — ${lastError.message}` : ''}. If this keeps happening in this browser, use Download and drag the file into Linear.`,
  );
}
