import assert from "node:assert/strict";
import { agentMarkdownToTelegramHtml } from "./send-message";

assert.equal(
  agentMarkdownToTelegramHtml("**En junio tuvimos 255 leads.**"),
  "<b>En junio tuvimos 255 leads.</b>"
);

assert.equal(
  agentMarkdownToTelegramHtml("Usamos horario de México CDMX, no `America/Mexico_City`."),
  "Usamos horario de México CDMX, no <code>America/Mexico_City</code>."
);

assert.equal(
  agentMarkdownToTelegramHtml("A & B <script>"),
  "A &amp; B &lt;script&gt;"
);

console.log("telegram/send-message.selftest: ok");
