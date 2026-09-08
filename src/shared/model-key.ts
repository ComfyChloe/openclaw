/** Join provider and model into the canonical provider/model key. */
export function modelKey(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return `${providerId}/${modelId}`;
}
