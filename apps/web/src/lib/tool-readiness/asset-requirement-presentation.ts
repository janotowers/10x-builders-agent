type RequirementLike = {
  asset_key: string;
  accept?: string[];
  collection?: boolean;
  max_count?: number;
};

export type AssetRequirementKind =
  | "property_document"
  | "listing_photo"
  | "docx_template"
  | "watermark_image"
  | "image"
  | "generic_file";

export type AssetRequirementPresentation = {
  kind: AssetRequirementKind;
  addButtonLabel: string;
  replaceButtonLabel: string;
  currentPrefix: string;
  showDocumentKindSelector: boolean;
  defaultCollectionItemLabel: string;
  collectionCountLabel: string;
  collectionReadyLabel: string;
};

const TEST_PROPERTY_DOCUMENT_ASSET_KEY = "test_property_document";
const TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY = "test_property_listing_photos";
const COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY = "commission_contract_template";
const LISTING_PHOTO_WATERMARK_ASSET_KEY = "listing_photo_watermark";

function isCollectionRequirement(requirement: RequirementLike): boolean {
  if (requirement.collection === true) return true;
  if (typeof requirement.max_count === "number" && requirement.max_count > 1) return true;
  return false;
}

function acceptsImages(requirement: RequirementLike): boolean {
  const accept = requirement.accept ?? [];
  return accept.some((value) => value.startsWith("image/") || value === ".png" || value === ".jpg");
}

export function resolveAssetRequirementPresentation(
  requirement: RequirementLike
): AssetRequirementPresentation {
  const key = requirement.asset_key;
  const collection = isCollectionRequirement(requirement);
  if (
    key === TEST_PROPERTY_DOCUMENT_ASSET_KEY ||
    key.startsWith(`${TEST_PROPERTY_DOCUMENT_ASSET_KEY}__`)
  ) {
    return {
      kind: "property_document",
      addButtonLabel: "Agregar documento",
      replaceButtonLabel: "Reemplazar documento",
      currentPrefix: "Documento actual",
      showDocumentKindSelector: true,
      defaultCollectionItemLabel: "Documento",
      collectionCountLabel: "documentos",
      collectionReadyLabel: "documentos listos",
    };
  }
  if (
    key === TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY ||
    key.startsWith(`${TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY}__`)
  ) {
    return {
      kind: "listing_photo",
      addButtonLabel: "Agregar fotos",
      replaceButtonLabel: "Reemplazar foto",
      currentPrefix: "Foto actual",
      showDocumentKindSelector: false,
      defaultCollectionItemLabel: "Foto de propiedad",
      collectionCountLabel: "fotos",
      collectionReadyLabel: "fotos listas",
    };
  }
  if (key === COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY) {
    return {
      kind: "docx_template",
      addButtonLabel: "Subir plantilla",
      replaceButtonLabel: "Reemplazar plantilla",
      currentPrefix: "Plantilla actual",
      showDocumentKindSelector: false,
      defaultCollectionItemLabel: "Plantilla",
      collectionCountLabel: "plantillas",
      collectionReadyLabel: "plantillas listas",
    };
  }
  if (key === LISTING_PHOTO_WATERMARK_ASSET_KEY) {
    return {
      kind: "watermark_image",
      addButtonLabel: "Subir watermark",
      replaceButtonLabel: "Reemplazar watermark",
      currentPrefix: "Watermark actual",
      showDocumentKindSelector: false,
      defaultCollectionItemLabel: "Watermark",
      collectionCountLabel: "watermarks",
      collectionReadyLabel: "watermarks listos",
    };
  }
  if (acceptsImages(requirement)) {
    return {
      kind: "image",
      addButtonLabel: collection ? "Agregar imágenes" : "Subir imagen",
      replaceButtonLabel: "Reemplazar imagen",
      currentPrefix: "Imagen actual",
      showDocumentKindSelector: false,
      defaultCollectionItemLabel: "Imagen",
      collectionCountLabel: "imágenes",
      collectionReadyLabel: "imágenes listas",
    };
  }
  return {
    kind: "generic_file",
    addButtonLabel: collection ? "Agregar archivos" : "Subir archivo",
    replaceButtonLabel: "Reemplazar archivo",
    currentPrefix: "Archivo actual",
    showDocumentKindSelector: false,
    defaultCollectionItemLabel: "Archivo",
    collectionCountLabel: "archivos",
    collectionReadyLabel: "archivos listos",
  };
}
