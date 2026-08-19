export function normalizeModelBaseUrl(value: string): string {
  const trimmed = value.trim();
  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  return normalizeDashScopeCompatibleUrl(withoutTrailingSlash);
}

function normalizeDashScopeCompatibleUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.hostname.endsWith('.aliyuncs.com') && url.hostname !== 'aliyuncs.com') {
      return value;
    }
    if (url.pathname.replace(/\/$/, '') !== '/compatible-mode') {
      return value;
    }
    url.pathname = '/compatible-mode/v1';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}
