import assert from "node:assert/strict";
import { isPropertyOptioningIntent } from "./property-optioning-intent";

function testPositiveIntents(): void {
  const positives = [
    "necesito opcionar una propiedad",
    "Quisiera opcionar una propiedas",
    "Quiero opcionar un inmueble",
    "quiero opcionar una casa",
    "voy a conseguir la exclusiva de un departamento",
    "tengo una nueva captación de propiedad",
    "necesito firmar contrato de comisión de una casa",
    "quiero publicar esta propiedad en EasyBroker",
    "haz análisis de comparables para este inmueble",
  ];

  for (const message of positives) {
    assert.equal(
      isPropertyOptioningIntent(message),
      true,
      `expected positive property optioning intent for: ${message}`
    );
  }
}

function testNegativeIntents(): void {
  const negatives = [
    "hola",
    "cuantos leads tuve en abril",
    "agenda una junta mañana",
    "publica el reporte de ventas",
    "quiero comprar una casa para mi",
    "busca propiedades en renta",
  ];

  for (const message of negatives) {
    assert.equal(
      isPropertyOptioningIntent(message),
      false,
      `expected non-property-optioning intent for: ${message}`
    );
  }
}

function main(): void {
  testPositiveIntents();
  testNegativeIntents();
  console.log("skills/property-optioning-intent.selftest: all 2 cases passed");
}

main();
