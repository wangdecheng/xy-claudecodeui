import type { UploadResult } from '@shared/onsite-types';

interface UploadResponseBody {
  results?: UploadResult[];
  error?: string;
  message?: string;
}

export interface OnsiteUploadRequestOptions {
  token?: string | null;
  onProgress?: (progress: number) => void;
  onRefreshedToken?: (token: string) => void;
}

function parseResponse(xhr: XMLHttpRequest): UploadResponseBody {
  if (!xhr.responseText) return {};
  try {
    return JSON.parse(xhr.responseText) as UploadResponseBody;
  } catch {
    throw new Error(`上传服务返回了无法解析的响应 (HTTP ${xhr.status})`);
  }
}

/**
 * Upload onsite logs with progress reporting.
 *
 * Kept outside the React store so transport failures have one clear contract:
 * all HTTP/network/abort failures reject, while every 2xx response (including
 * 207 Multi-Status) resolves to its per-file result list.
 */
export function requestOnsiteUpload(
  problemId: string,
  files: File[],
  options: OnsiteUploadRequestOptions = {},
): Promise<UploadResult[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  return new Promise<UploadResult[]>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/onsite/problems/${encodeURIComponent(problemId)}/files`, true);

    if (options.token) {
      xhr.setRequestHeader('Authorization', `Bearer ${options.token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      // Reserve 100% for the server-side unpacking and database write.
      options.onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      const refreshedToken = xhr.getResponseHeader('X-Refreshed-Token');
      if (refreshedToken) options.onRefreshedToken?.(refreshedToken);

      let body: UploadResponseBody;
      try {
        body = parseResponse(xhr);
      } catch (error: unknown) {
        reject(error);
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        if (!Array.isArray(body.results)) {
          reject(new Error('上传服务未返回文件处理结果'));
          return;
        }
        resolve(body.results);
        return;
      }

      reject(new Error(body.message || body.error || `上传失败 (HTTP ${xhr.status})`));
    };

    xhr.onerror = () => reject(new Error('上传失败，请检查网络连接后重试'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(formData);
  });
}
