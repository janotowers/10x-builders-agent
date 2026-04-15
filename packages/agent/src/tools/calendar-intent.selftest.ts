import { userMessageIsCalendarRelated } from "./calendar-intent";

const cases = [
  { msg: "Ok. Avanzar con curso Lab10, 10 am (1.5 hrs). Descripción: Necesito seguir avanzando!", want: true },
  { msg: "crea un evento en mi calendario principal", want: true },
  { msg: "agenda una reunión mañana a las 3pm", want: true },
  { msg: "create an event tomorrow at 10am", want: true },
  { msg: "dame mis calendarios", want: true },
  { msg: "qué eventos tengo hoy", want: true },
  { msg: "crea un repositorio test-hitl", want: false },
  { msg: "lista mis repos de github", want: false },
  { msg: "hola", want: false },
  { msg: "", want: false },
  { msg: "crea un issue en mi repo", want: false },
  { msg: "bloquear 2 horas para clase de yoga el viernes", want: true },
];

let passed = 0;
for (const c of cases) {
  const got = userMessageIsCalendarRelated(c.msg);
  if (got !== c.want) {
    console.error(`FAIL: "${c.msg}" => ${got}, want ${c.want}`);
    process.exit(1);
  }
  passed++;
}
console.log(`calendar-intent.selftest: all ${passed} cases passed`);
