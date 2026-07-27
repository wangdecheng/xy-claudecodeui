import { authenticatedFetch } from './api';

/** Request a protected onsite artifact download. */
export function requestOnsiteDownload(problemId: string, filePath: string): Promise<Response> {
  return authenticatedFetch(
    `/api/onsite/problems/${encodeURIComponent(problemId)}/download?path=${encodeURIComponent(filePath)}`,
  );
}
