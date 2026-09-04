# Nova ecosystem role

Nova is the compiler and developer-intelligence engine for Cannon and Cannon+.

## Intent

Nova is the layer that understands programs. It owns parsing integration, semantic analysis, the Infer Engine, source spans, diagnostics, bug provenance, intermediate representation, optimization, backend code generation and machine-readable compiler output.

The design target combines precise diagnostics, ambitious optimization, modular IR and compile-time safety analysis while aiming for faster feedback and clearer explanations.

## Relationships

- Cannon and Cannon+ define the languages Nova understands.
- Scout can carry structured project/tooling configuration without becoming executable language syntax.
- Parallel executes artifacts produced through the Cannon toolchain.
- Sprout can consume compiler-derived dependency information for compile-time-assisted reactivity.
- Plasma provides stable foreign-language/runtime boundaries Nova can target and diagnose.
- Cortex consumes Nova diagnostics, symbols, source spans, provenance and structured compiler output.
- Velocity uses Nova as part of application development/build orchestration.
- Chronos uses reproducible Nova toolchains in remote builds.

## Boundary

Nova is not the runtime, UI framework, backend framework, IDE or deployment cloud. It should expose stable compiler/tooling contracts to those independently versioned systems.

A backend, inference feature or diagnostic is supported only when executable tests prove it.
