import { userMessageIsFileToolsIntent } from "./file-tools-intent";

const cases: Array<{ msg: string; want: boolean }> = [
  // Verdaderos positivos
  { msg: "lee el archivo README.md", want: true },
  { msg: "¿qué contiene docs/plan.md?", want: true },
  { msg: "en el archivo prueba-telegram.txt sustituye HITL por otra cosa", want: true },
  { msg: "crea un archivo tmp/hola.txt con el contenido hola", want: true },
  { msg: "edita packages/agent/package.json y cambia la version", want: true },
  { msg: "sobrescribe el archivo sandbox/nota.txt", want: true },
  { msg: "muestra el contenido de .env.example", want: true },
  { msg: "reemplaza la palabra foo por bar en docs/plan.md", want: true },

  // Negativos por dominio distinto
  { msg: "crea un evento para mañana 10 am", want: false },
  { msg: "dame mis calendarios", want: false },
  { msg: "crea un repo llamado test-hitl", want: false },
  { msg: "lista mis repos en github", want: false },

  // Ambiguos / cortos — no deben disparar intención de archivos
  { msg: "sí", want: false },
  { msg: "ok", want: false },
  { msg: "hola", want: false },
  { msg: "", want: false },

  // No romper con URLs
  { msg: "manda un GET a https://example.com/foo.json", want: false },
];

let passed = 0;
for (const c of cases) {
  const got = userMessageIsFileToolsIntent(c.msg);
  if (got !== c.want) {
    console.error(`FAIL: "${c.msg}" => ${got}, want ${c.want}`);
    process.exit(1);
  }
  passed++;
}
console.log(`file-tools-intent.selftest: all ${passed} cases passed`);
