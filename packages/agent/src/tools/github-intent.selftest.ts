import assert from "node:assert/strict";
import { userWantsNewGithubRepository } from "./github-intent";

const cases: Array<{ msg: string; want: boolean }> = [
  { msg: "crea el repositorio agent-lab10sem4", want: true },
  { msg: "Crea el repositorio agent-lab10sem4", want: true },
  { msg: "crear un repo llamado my-app", want: true },
  { msg: "nuevo repositorio para el curso", want: true },
  { msg: "hazme un repo test-123", want: true },
  { msg: "create a new repository foo-bar", want: true },
  { msg: "create the repo demo", want: true },
  { msg: "crear un issue en janotowers/foo", want: false },
  { msg: "abre un ticket en el repo X", want: false },
  { msg: "lista mis repositorios", want: false },
  { msg: "list issues in owner/name", want: false },
];

for (const { msg, want } of cases) {
  const got = userWantsNewGithubRepository(msg);
  assert.equal(
    got,
    want,
    `userWantsNewGithubRepository(${JSON.stringify(msg)}) => ${got}, expected ${want}`
  );
}

console.log("github-intent.selftest: all", cases.length, "cases passed");
