# Workflow Studio

Documentación canónica de la autoría NL, resolución de capacidades y composición
de patrones para todas las formas de trabajo de Gu OS.

## Documentos

- [`capabilities-and-solution-patterns.md`](capabilities-and-solution-patterns.md):
  flujo de discovery, catálogo de proveedores, Pattern Composition Kernel,
  materialización y Gmail gobernado.
- [`pattern-coverage-matrix.md`](pattern-coverage-matrix.md): inventario y
  destino de aprendizajes de runtime, doctrina y pruebas que alimentan el
  kernel.

## Fronteras

- Los contratos ejecutables viven en
  `packages/workflows/src/compiler/solution-patterns.ts` y en los catálogos
  tipados correspondientes.
- Los documentos de este directorio explican arquitectura, provenance y
  cobertura; no sustituyen código, validadores ni pruebas.
- La arquitectura particular de casos multi-día permanece en
  [`../operational-cases/`](../operational-cases/).
- El modelo futuro de conocimiento y mejora de plataforma se documenta en
  [`../brain/business-and-platform-brain-boundary.md`](../brain/business-and-platform-brain-boundary.md).
