import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getPendingToolCall,
  updateToolCallStatus,
  decryptToken,
  getGoogleCalendarAccessToken,
  getProfile,
} from "@agents/db";
import {
  githubApi,
  buildEventResource,
  executeCalendarCreateEvent,
  executeCalendarPatchEvent,
  executeCalendarDeleteEvent,
} from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();

    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "toolCallId and action (approve|reject) required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const toolCall = await getPendingToolCall(db, toolCallId);

    if (!toolCall) {
      return NextResponse.json(
        { error: "Tool call not found or already resolved" },
        { status: 404 }
      );
    }

    if (action === "reject") {
      await updateToolCallStatus(db, toolCallId, "rejected");
      return NextResponse.json({
        ok: true,
        message: "Acción cancelada.",
      });
    }

    await updateToolCallStatus(db, toolCallId, "approved");

    const args = toolCall.arguments_json;
    let result: Record<string, unknown>;
    const toolName = toolCall.tool_name;

    if (toolName === "github_create_issue" || toolName === "github_create_repo") {
      const { data: integration } = await supabase
        .from("user_integrations")
        .select("encrypted_tokens")
        .eq("user_id", user.id)
        .eq("provider", "github")
        .eq("status", "active")
        .single();

      if (!integration?.encrypted_tokens) {
        await updateToolCallStatus(db, toolCallId, "failed", {
          error: "GitHub not connected",
        });
        return NextResponse.json(
          { error: "GitHub integration not found" },
          { status: 400 }
        );
      }

      const token = decryptToken(integration.encrypted_tokens as string);

      switch (toolName) {
        case "github_create_issue": {
          const { status, data } = await githubApi(
            token,
            "POST",
            `/repos/${args.owner}/${args.repo}/issues`,
            { title: args.title, body: args.body ?? "" }
          );
          if (status >= 400) {
            result = { error: "GitHub API error", status, details: data };
            await updateToolCallStatus(db, toolCallId, "failed", result);
            return NextResponse.json({ ok: false, result });
          }
          const created = data as Record<string, unknown>;
          result = {
            message: "Issue creado",
            issue_url: created.html_url,
            number: created.number,
          };
          break;
        }
        case "github_create_repo": {
          const isPrivate = !!(args.private ?? args.isPrivate);
          const { status, data } = await githubApi(token, "POST", "/user/repos", {
            name: args.name,
            description: args.description ?? "",
            private: isPrivate,
          });
          if (status >= 400) {
            result = { error: "GitHub API error", status, details: data };
            await updateToolCallStatus(db, toolCallId, "failed", result);
            return NextResponse.json({ ok: false, result });
          }
          const created = data as Record<string, unknown>;
          result = {
            message: "Repositorio creado",
            html_url: created.html_url,
            full_name: created.full_name,
          };
          break;
        }
        default:
          result = { error: `Unknown tool: ${toolName}` };
          await updateToolCallStatus(db, toolCallId, "failed", result);
          return NextResponse.json({ ok: false, result });
      }
    } else if (
      toolName === "calendar_create_event" ||
      toolName === "calendar_update_event" ||
      toolName === "calendar_delete_event"
    ) {
      const accessToken = await getGoogleCalendarAccessToken(db, user.id);
      if (!accessToken) {
        const err = { error: "Google Calendar not connected or token expired" };
        await updateToolCallStatus(db, toolCallId, "failed", err);
        return NextResponse.json(
          { error: "Google Calendar no disponible" },
          { status: 400 }
        );
      }

      const profile = await getProfile(db, user.id);
      const tz = profile.timezone ?? "UTC";
      const calId = String(args.calendar_id ?? "primary");

      switch (toolName) {
        case "calendar_create_event": {
          const body = buildEventResource({
            summary: String(args.summary ?? ""),
            start_datetime: String(args.start_datetime),
            end_datetime: String(args.end_datetime),
            timezone: tz,
            description: String(args.description ?? ""),
          });
          const { status, data } = await executeCalendarCreateEvent(
            accessToken,
            calId,
            body
          );
          if (status >= 400) {
            result = { error: "Calendar API error", status, details: data };
            await updateToolCallStatus(db, toolCallId, "failed", result);
            return NextResponse.json({ ok: false, result });
          }
          const created = data as Record<string, unknown>;
          result = {
            message: "Evento creado",
            htmlLink: created.htmlLink,
            id: created.id,
          };
          break;
        }
        case "calendar_update_event": {
          const patch: Record<string, unknown> = {};
          if (args.summary !== undefined) patch.summary = args.summary;
          if (args.description !== undefined) patch.description = args.description;
          if (args.start_datetime && args.end_datetime) {
            patch.start = {
              dateTime: String(args.start_datetime),
              timeZone: tz,
            };
            patch.end = {
              dateTime: String(args.end_datetime),
              timeZone: tz,
            };
          }
          const { status, data } = await executeCalendarPatchEvent(
            accessToken,
            calId,
            String(args.event_id),
            patch
          );
          if (status >= 400) {
            result = { error: "Calendar API error", status, details: data };
            await updateToolCallStatus(db, toolCallId, "failed", result);
            return NextResponse.json({ ok: false, result });
          }
          const updated = data as Record<string, unknown>;
          result = {
            message: "Evento actualizado",
            htmlLink: updated.htmlLink,
            id: updated.id,
          };
          break;
        }
        case "calendar_delete_event": {
          const { status, data } = await executeCalendarDeleteEvent(
            accessToken,
            calId,
            String(args.event_id)
          );
          if (status >= 400 && status !== 204) {
            result = { error: "Calendar API error", status, details: data };
            await updateToolCallStatus(db, toolCallId, "failed", result);
            return NextResponse.json({ ok: false, result });
          }
          result = { message: "Evento eliminado" };
          break;
        }
        default:
          result = { error: `Unknown tool: ${toolName}` };
          await updateToolCallStatus(db, toolCallId, "failed", result);
          return NextResponse.json({ ok: false, result });
      }
    } else {
      result = { error: `Unknown tool: ${toolName}` };
      await updateToolCallStatus(db, toolCallId, "failed", result);
      return NextResponse.json({ ok: false, result });
    }

    await updateToolCallStatus(db, toolCallId, "executed", result);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
