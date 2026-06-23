import assert from "node:assert/strict";
import {
  __resetMediaGroupBufferForTests,
  bufferMediaGroupFile,
  type MediaGroupFlushPayload,
} from "./telegram-media-group-buffer";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 1) Varios archivos del mismo álbum producen UN solo flush consolidado.
  __resetMediaGroupBufferForTests();
  const flushes: MediaGroupFlushPayload[] = [];
  const onFlush = async (payload: MediaGroupFlushPayload) => {
    flushes.push(payload);
  };
  for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
    bufferMediaGroupFile({
      chatId: 42,
      mediaGroupId: "grp-1",
      caseId: "case-1",
      file: { originalName: name, kind: "ine" },
      markReady: false,
      onFlush,
      windowMs: 40,
    });
    await delay(5);
  }
  await delay(120);
  assert.equal(flushes.length, 1, "debe haber exactamente un flush por álbum");
  assert.equal(flushes[0]!.files.length, 3, "el flush agrupa los 3 archivos");
  assert.equal(flushes[0]!.caseId, "case-1");
  assert.equal(flushes[0]!.markReady, false);

  // 2) markReady se propaga si algún elemento lo trae (p. ej. caption "listo").
  __resetMediaGroupBufferForTests();
  const readyFlushes: MediaGroupFlushPayload[] = [];
  bufferMediaGroupFile({
    chatId: 7,
    mediaGroupId: "grp-2",
    caseId: "case-2",
    file: { originalName: "x.pdf", kind: null },
    markReady: false,
    onFlush: async (p) => {
      readyFlushes.push(p);
    },
    windowMs: 40,
  });
  bufferMediaGroupFile({
    chatId: 7,
    mediaGroupId: "grp-2",
    caseId: "case-2",
    file: { originalName: "y.pdf", kind: null },
    markReady: true,
    onFlush: async (p) => {
      readyFlushes.push(p);
    },
    windowMs: 40,
  });
  await delay(120);
  assert.equal(readyFlushes.length, 1);
  assert.equal(readyFlushes[0]!.markReady, true, "markReady debe propagarse");

  // 3) Álbumes distintos (otro media_group_id) no se mezclan.
  __resetMediaGroupBufferForTests();
  const byGroup: MediaGroupFlushPayload[] = [];
  for (const [grp, name] of [
    ["grp-A", "1.pdf"],
    ["grp-B", "2.pdf"],
  ] as const) {
    bufferMediaGroupFile({
      chatId: 99,
      mediaGroupId: grp,
      caseId: "case-3",
      file: { originalName: name, kind: null },
      markReady: false,
      onFlush: async (p) => {
        byGroup.push(p);
      },
      windowMs: 40,
    });
  }
  await delay(120);
  assert.equal(byGroup.length, 2, "cada media_group_id flushea por separado");

  console.log("telegram-media-group-buffer.selftest: ok");
}

void main();
