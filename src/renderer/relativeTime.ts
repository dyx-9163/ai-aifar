import type { LanguagePreference } from '../shared/domain';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Renders a compact relative timestamp for sidebar rows: just now, minutes,
 * hours, days, then falls back to the localized calendar date.
 */
export function formatRelativeTime(iso: string, language: LanguagePreference, now: () => Date = () => new Date()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  const reference = now().getTime();
  const delta = Math.max(0, reference - timestamp);
  const zh = language === 'zh-CN';

  if (delta < MINUTE_MS) {
    return zh ? '刚刚' : 'Just now';
  }
  if (delta < HOUR_MS) {
    const minutes = Math.floor(delta / MINUTE_MS);
    return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    return zh ? `${hours} 小时前` : `${hours}h ago`;
  }
  if (delta < 30 * DAY_MS) {
    const days = Math.floor(delta / DAY_MS);
    return zh ? `${days} 天前` : `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}
