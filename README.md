# Nova

Nova is the compiler and developer-intelligence engine for Cannon and Cannon+.

It is the layer that understands programs: parsing integration, semantic analysis, inference, source spans, diagnostics, bug provenance, intermediate representation, optimization, backend code generation, and machine-readable compiler output.

## Role in the Cannon developer ecosystem

```text
Cannon / Cannon+
       │
       ▼
      Nova
       │
       ├── diagnostics / symbols / provenance ──► Cortex
       ├── compiled artifacts / runtime contracts ──► Parallel
       ├── interop-aware compilation ──► Plasma
       ├── dependency information ──► Sprout
       ├── application workflow ──► Velocity
       └── reproducible toolchains ──► Chronos
```

Nova is not the runtime, UI framework, backend framework, IDE, or deployment cloud. Those remain independently versioned systems with explicit contracts.

## Design direction

Nova takes inspiration from:

- Clang's precise diagnostics;
- GCC's optimization ambition;
- LLVM's modular IR architecture;
- Rust's compile-time safety analysis.

The target is faster feedback, clearer explanations, strong inference, stable IR, and verifiable code generation without overstating unsupported backends or analyses.

## Planned implementation sequence

1. Source-location model and diagnostic renderer.
2. Infer Engine for literals, bindings, functions, collections, nullability, effects, and async boundaries.
3. Semantic graph and provenance tracking.
4. Stable Cannon IR.
5. JavaScript backend migration from Cannon.
6. WASM backend.
7. Native backend.
8. Debug metadata and structured diagnostics for Cortex and AI tooling.

## Proof standard

A compiler feature is supported only when executable tests prove successful compilation, expected failures, and correct source locations. Backends require executable output tests. Diagnostics require exact source-span tests.

## Ecosystem

See [ECOSYSTEM.md](./ECOSYSTEM.md) for ownership boundaries and first-party integrations, and [ROADMAP.md](./ROADMAP.md) for implementation direction.
