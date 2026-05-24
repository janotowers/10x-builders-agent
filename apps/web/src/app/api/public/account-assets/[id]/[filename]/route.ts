import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, getAccountAssetById } from "@agents/db";

const PUBLIC_ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string; filename: string }> }
) {
  const { id } = await context.params;
  try {
    const db = createServerClient();
    const asset = await getAccountAssetById(db, id);
    if (!asset) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { data, error } = await db.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, PUBLIC_ASSET_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: error?.message ?? "signed_url_failed" },
        { status: 502 }
      );
    }

    return NextResponse.redirect(data.signedUrl, {
      status: 307,
      headers: {
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("[GET /api/public/account-assets/:id/:filename] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
