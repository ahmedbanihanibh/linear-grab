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

  const headers = new Headers({ 'Content-Type': blob.type });
  for (const h of uploadFile.headers ?? []) headers.set(h.key, h.value);

  const res = await fetch(uploadFile.uploadUrl, { method: 'PUT', headers, body: blob });
  if (!res.ok) throw new Error(`Recording upload failed (${res.status}).`);

  return uploadFile.assetUrl;
}
