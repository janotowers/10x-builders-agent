import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  deleteAccountAsset,
  listAccountAssets,
  upsertAccountAsset,
} from "@agents/db";

const ACCOUNT_ASSETS_BUCKET = "account-assets";
const DEFAULT_MAX_SIZE_BYTES = 15 * 1024 * 1024;
const COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY = "commission_contract_template";
const DOCX_TEMPLATE_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isCommissionContractTemplateDocx(file: File): boolean {
  const name = file.name.trim().toLowerCase();
  return name.endsWith(".docx") || file.type === DOCX_TEMPLATE_MIME;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function fileExtension(fileName: string) {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "bin";
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const assetKeys = url.searchParams
      .get("asset_keys")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const assetKeyPrefixes = url.searchParams
      .get("asset_key_prefixes")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const db = createServerClient();
    const assets = await listAccountAssets(db, {
      userId: user.id,
      assetKeys,
      assetKeyPrefixes,
    });
    return NextResponse.json({ ok: true, assets });
  } catch (err) {
    console.error("[GET /api/account-assets] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const assetKey = safeSegment(cleanText(url.searchParams.get("asset_key")));
    if (!assetKey) {
      return NextResponse.json({ error: "asset_key required" }, { status: 400 });
    }

    const db = createServerClient();
    const asset = await deleteAccountAsset(db, {
      userId: user.id,
      assetKey,
    });
    if (!asset) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { error: removeError } = await supabase.storage
      .from(asset.storage_bucket)
      .remove([asset.storage_path]);
    if (removeError) {
      console.warn("[DELETE /api/account-assets] storage remove failed:", removeError);
    }

    return NextResponse.json({ ok: true, asset });
  } catch (err) {
    console.error("[DELETE /api/account-assets] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const assetKey = safeSegment(cleanText(formData.get("asset_key")));
    const displayName = cleanText(formData.get("display_name"));
    const description = cleanText(formData.get("description"));
    const sourceToolId = cleanText(formData.get("source_tool_id"));
    const caseTypeId = cleanText(formData.get("case_type_id"));

    if (!assetKey) {
      return NextResponse.json({ error: "asset_key required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size > DEFAULT_MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: "file too large", maxBytes: DEFAULT_MAX_SIZE_BYTES },
        { status: 400 }
      );
    }
    if (
      assetKey === COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY &&
      !isCommissionContractTemplateDocx(file)
    ) {
      return NextResponse.json(
        {
          error:
            "La plantilla de contrato debe ser un archivo .docx (Word). PDF y .doc no son compatibles con la generación del borrador.",
        },
        { status: 400 }
      );
    }

    const path = `${user.id}/${assetKey}/${Date.now()}-${safeSegment(
      file.name.replace(/\.[^.]+$/, "")
    )}.${fileExtension(file.name)}`;
    const { error: uploadError } = await supabase.storage
      .from(ACCOUNT_ASSETS_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const db = createServerClient();
    const asset = await upsertAccountAsset(db, {
      userId: user.id,
      assetKey,
      displayName: displayName || assetKey,
      description: description || null,
      storageBucket: ACCOUNT_ASSETS_BUCKET,
      storagePath: path,
      contentType: file.type || null,
      fileSizeBytes: file.size,
      sourceToolId: sourceToolId || null,
      caseTypeId: caseTypeId || null,
      metadata: {
        original_name: file.name,
        ...(cleanText(formData.get("document_kind"))
          ? { document_kind: cleanText(formData.get("document_kind")) }
          : {}),
      },
    });

    return NextResponse.json({ ok: true, asset });
  } catch (err) {
    console.error("[POST /api/account-assets] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
