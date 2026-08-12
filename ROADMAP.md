# Nova Roadmap

Nova is the compiler and developer-intelligence engine for Cannon and Cannon+.

## Product contract

Nova owns parsing integration, semantic analysis, the Infer Engine, source spans, diagnostics, bug provenance, IR, optimization, backend code generation, and machine-readable compiler output. Nova must never claim a backend, inference capability, or diagnostic it cannot prove with executable tests.

## Design sources

Nova takes Clang's precise diagnostics, GCC's optimization ambition, LLVM's modular IR architecture, and rustc's compile-time safety analysis while explicitly targeting faster feedback and clearer explanations.

## Implementation order

1. Source-location model and diagnostic renderer.
2. Infer Engine for literals, bindings, functions, collections, nullability, effects, and async boundaries.
3. Semantic graph and provenance tracking.
4. Stable Cannon IR.
5. JavaScript backend migration from Cannon.
6. WASM backend.
7. Native backend.
8. Debug metadata and structured diagnostics for Cortex and AI tooling.

## Proof gates

A feature is supported only when tests prove successful compilation plus expected failures and source locations. Backends require executable output tests. Diagnostics require exact source-span tests.

## Commercial boundary

Nova core remains adoption infrastructure. Revenue belongs primarily in Cortex Pro/Enterprise, Chronos, certified toolchains, private build infrastructure, enterprise support, and safety/verification tooling built on Nova.
