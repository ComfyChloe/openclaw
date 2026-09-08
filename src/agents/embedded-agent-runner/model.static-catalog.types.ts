import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";

export type BundledStaticCatalogState = {
  plugins: Parameters<typeof planManifestModelCatalogRows>[0]["registry"]["plugins"][number][];
  models: Map<string, ReadonlyMap<string, NormalizedModelCatalogRow>>;
};
