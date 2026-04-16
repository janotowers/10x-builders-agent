import { userMessageIsLocalShellOrFilesystemIntent } from "./local-shell-intent";

const cases: Array<{ msg: string; want: boolean }> = [
  {
    msg: "lista que archivos están en la carpeta actual",
    want: true,
  },
  { msg: "list files in the current directory", want: true },
  { msg: "dame mis repositorios en GitHub", want: false },
  { msg: "lista mis repos", want: false },
  { msg: "muestra los repositorios de github", want: false },
  { msg: "ls -la", want: true },
  { msg: "pwd", want: true },
];

let passed = 0;
for (const c of cases) {
  const got = userMessageIsLocalShellOrFilesystemIntent(c.msg);
  if (got !== c.want) {
    console.error(`FAIL: "${c.msg}" => ${got}, want ${c.want}`);
    process.exit(1);
  }
  passed++;
}
console.log(`local-shell-intent.selftest: all ${passed} cases passed`);
