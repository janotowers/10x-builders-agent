import path from "node:path";
import { resolveSafePath } from "./fileTools";

const root = path.resolve("/tmp/file-tools-test");

type Case = {
  name: string;
  input: string;
  wantOk: boolean;
};

const cases: Case[] = [
  { name: "simple relative file", input: "a.txt", wantOk: true },
  { name: "nested relative", input: "sub/dir/a.txt", wantOk: true },
  { name: "dot slash", input: "./a.txt", wantOk: true },
  { name: "rejects absolute unix", input: "/etc/passwd", wantOk: false },
  { name: "rejects parent escape", input: "../x.txt", wantOk: false },
  { name: "rejects mid escape", input: "a/../../../y", wantOk: false },
  { name: "rejects null byte", input: "a\0b", wantOk: false },
  { name: "rejects empty", input: "", wantOk: false },
];

if (process.platform === "win32") {
  cases.push({
    name: "rejects absolute windows",
    input: "C:\\windows\\system32",
    wantOk: false,
  });
}

let passed = 0;
for (const c of cases) {
  const got = resolveSafePath(c.input, root);
  if (got.ok !== c.wantOk) {
    console.error(
      `FAIL [${c.name}]: "${c.input}" => ok=${got.ok}, want ok=${c.wantOk}${"message" in got ? ` (${got.message})` : ""}`
    );
    process.exit(1);
  }
  passed++;
}
console.log(`fileTools.selftest: all ${passed} cases passed`);
