export const ONSITE_FILE_ACCEPT = '.zip,.tar.gz,.tgz,.gz,.png,.jpg,.jpeg,.gif,.webp';

const SUPPORTED_SUFFIXES = ['.tar.gz', '.zip', '.tgz', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

export function isSupportedOnsiteFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function filterSupportedOnsiteFiles(files: File[]): { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) (isSupportedOnsiteFileName(file.name) ? accepted : rejected).push(file);
  return { accepted, rejected };
}
