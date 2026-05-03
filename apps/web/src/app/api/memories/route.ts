import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, listMemories } from "@agents/db";
import type { MemoryType } from "@agents/db";

const ALLOWED_TYPES: ReadonlyArray<MemoryType> = [
  "episodic",
  "semantic",
  "procedural",
];

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
    const statusParam = url.searchParams.get("status") ?? "active";
    const status =
      statusParam === "archived" || statusParam === "all"
        ? statusParam
        : "active";
    const typeParam = url.searchParams.get("type");
    const type = ALLOWED_TYPES.includes(typeParam as MemoryType)
      ? (typeParam as MemoryType)
      : undefined;
    const q = url.searchParams.get("q") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const offsetRaw = Number(url.searchParams.get("offset"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const sortByParam = url.searchParams.get("sort_by");
    const sortBy =
      sortByParam === "archived_at" || sortByParam === "created_at"
        ? sortByParam
        : "created_at";
    const sortDirParam = url.searchParams.get("sort_dir");
    const sortDir: "asc" | "desc" =
      sortDirParam === "asc" || sortDirParam === "desc"
        ? sortDirParam
        : "desc";

    const db = createServerClient();
    const result = await listMemories(db, {
      userId: user.id,
      status,
      type,
      q,
      limit,
      offset,
      sortBy,
      sortDir,
    });

    return NextResponse.json({
      rows: result.rows,
      total: result.total,
      limit,
      offset,
      status,
      type: type ?? null,
      q: q ?? null,
      sort_by: sortBy,
      sort_dir: sortDir,
    });
  } catch (err) {
    console.error("[GET /api/memories] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
