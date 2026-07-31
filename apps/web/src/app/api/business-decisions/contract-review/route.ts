import { NextResponse } from "next/server";
import { createServerClient, getOperationalCase } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { businessDecisionHandler } from "@/lib/business-decisions/registry";
import { mirrorCaseAssistantMessageToWebChat } from "@/lib/operational-cases/mirror-case-message-to-web-chat";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    notification_id?: unknown;
    text?: unknown;
    kind?: unknown;
    action?: unknown;
  };
  const notificationId =
    typeof body.notification_id === "string" ? body.notification_id : "";
  const kind =
    body.kind === "contract_owner_signed" ? "contract_owner_signed" : "contract_review";
  const action = typeof body.action === "string" ? body.action : "";
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim()
      : action === "approve_send"
        ? "enviar por email al propietario"
        : action === "request_changes"
          ? "subir contrato corregido y enviar"
          : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const handler = businessDecisionHandler(kind);
  const result = await handler.handle(db, {
    userId: user.id,
    notificationId,
    text,
  });

  // Paridad Telegram (sendTelegramMessage con result.message): acuse en el
  // timeline web, sin crear otro pendiente de inbox.
  if (
    result.ok &&
    kind === "contract_review" &&
    typeof result.message === "string" &&
    result.message.trim() &&
    typeof result.case_id === "string"
  ) {
    try {
      await mirrorCaseAssistantMessageToWebChat({
        db,
        userId: user.id,
        caseId: result.case_id,
        text: result.message.trim(),
        kind: "contract_review_result",
      });
    } catch (ackError) {
      console.warn(
        "[business-decisions/contract-review] web ack mirror failed:",
        ackError
      );
    }
  }

  // Paridad con Telegram / pending-decision-router: tras enviar el contrato
  // por email, pedir fotos si el caso avanzó a photos_requested.
  if (
    result.ok &&
    kind === "contract_review" &&
    (result.status === "approved_send" ||
      result.status === "revision_uploaded_and_sent") &&
    typeof result.case_id === "string"
  ) {
    try {
      const photosCase = await getOperationalCase(db, result.case_id);
      if (photosCase?.current_step === "photos_requested") {
        const { ensurePhotosUploadRequestForCase } = await import(
          "@/lib/operational-cases/ensure-photos-upload-request"
        );
        await ensurePhotosUploadRequestForCase({
          db,
          opCase: photosCase,
          source: "web_contract_review_api",
        });
      }
    } catch (photosError) {
      console.warn(
        "[business-decisions/contract-review] photos upload request failed:",
        photosError
      );
    }
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
