import assert from "node:assert/strict";
import type { DbClient } from "@agents/db";
import {
  __gmailToolExecutorInternals,
  executeGmailSendTool,
} from "./tool-executor";

const db = {} as DbClient;
const baseDocument = {
  id: "doc-1",
  user_id: "u1",
  status: "received" as const,
  storage_bucket: "case-documents",
  storage_path: "u1/c1/doc-1.txt",
  original_name: "seguimiento.txt",
  display_name: "Seguimiento",
  content_type: "text/plain",
  file_size_bytes: 4,
};

async function main() {
  let sentAttachments = 0;
  const sent = await executeGmailSendTool(
    {
      db,
      userId: "u1",
      to: "owner@example.com",
      subject: "Seguimiento",
      body: "Hola",
      documents: [baseDocument],
    },
    {
      download: async () => Buffer.from("hola"),
      send: async (input) => {
        sentAttachments = input.attachments?.length ?? 0;
        return {
          ok: true as const,
          status: "sent" as const,
          messageId: "gmail-1",
        };
      },
    }
  );
  assert.equal(sent.ok, true);
  assert.equal(sentAttachments, 1);

  const forbidden = await executeGmailSendTool(
    {
      db,
      userId: "u2",
      to: "owner@example.com",
      subject: "Seguimiento",
      body: "Hola",
      documents: [baseDocument],
    },
    { download: async () => Buffer.from("must-not-run") }
  );
  assert.equal(forbidden.status, "gmail_attachment_forbidden");

  const tooLarge = await executeGmailSendTool(
    {
      db,
      userId: "u1",
      to: "owner@example.com",
      subject: "Seguimiento",
      body: "Hola",
      documents: [
        {
          ...baseDocument,
          file_size_bytes:
            __gmailToolExecutorInternals.MAX_GMAIL_ATTACHMENT_BYTES + 1,
        },
      ],
    },
    { download: async () => Buffer.from("must-not-run") }
  );
  assert.equal(tooLarge.status, "gmail_attachments_too_large");

  console.log("gmail tool-executor.selftest: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
