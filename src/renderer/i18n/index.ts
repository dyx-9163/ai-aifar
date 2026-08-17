import type { LanguagePreference } from '../../shared/domain';
import { messages, type I18nKey } from './messages';

export type { I18nKey };

export type Translator = (key: I18nKey) => string;

export function createTranslator(locale: LanguagePreference): (key: I18nKey) => string {
  return (key) => messages[locale][key] ?? messages['en-US'][key] ?? key;
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'zh-CN' || value === 'en-US';
}
