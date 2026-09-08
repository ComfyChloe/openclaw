import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

export type StaticModelIdNormalizer = (provider: string, modelId: string) => string;

/** Catalog metadata belongs to the exact selected identity, including catalog misses. */
export function findStaticModel<T extends { id: string; provider?: string }>(
  models: readonly T[],
  provider: string,
  modelId: string,
): T | undefined {
  const providerId = normalizeProviderId(provider);
  return models.find(
    (model) =>
      model.id.trim() === modelId.trim() &&
      (!model.provider || normalizeProviderId(model.provider) === providerId),
  );
}
