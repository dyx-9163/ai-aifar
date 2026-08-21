import type { ModelProfile, ModelProvider } from '../shared/domain.js';

export function parseManualModelIds(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((id) => id.trim()).filter(Boolean))];
}

export function filterCatalogModels(allIds: readonly string[], query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? allIds.filter((id) => id.toLocaleLowerCase().includes(normalized)) : [...allIds];
}

export function selectAllModels(allIds: readonly string[]): Set<string> {
  return new Set(allIds);
}

export function clearAllModels(): Set<string> {
  return new Set();
}

export function selectFilteredModels(
  allIds: readonly string[],
  selected: ReadonlySet<string>,
  query: string,
): Set<string> {
  const next = new Set(selected);
  for (const id of filterCatalogModels(allIds, query)) next.add(id);
  return next;
}

export function clearFilteredModels(
  allIds: readonly string[],
  selected: ReadonlySet<string>,
  query: string,
): Set<string> {
  const next = new Set(selected);
  for (const id of filterCatalogModels(allIds, query)) next.delete(id);
  return next;
}

export interface ProviderModelGroup {
  provider: ModelProvider;
  models: ModelProfile[];
}

export function groupModelsByProvider(
  providers: readonly ModelProvider[],
  models: readonly ModelProfile[],
): ProviderModelGroup[] {
  return [...providers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((provider) => ({
      provider,
      models: models
        .filter((model) => model.providerId === provider.id)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }));
}
