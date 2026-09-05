# Nova Vision

## Product identity

Nova is the compiler and developer-intelligence engine for Cannon and Cannon+.

Nova exists to understand Cannon programs deeply enough to provide precise analysis, excellent diagnostics, stable intermediate representations, optimization, backend generation, source provenance, and machine-readable intelligence for the rest of the ecosystem.

## Primary comparison set

Nova is our answer to lessons drawn from:

- LLVM
- GCC
- Clang
- rustc

The objective is not to clone any one compiler stack. Nova should preserve their strongest architectural lessons while designing specifically for Cannon/Cannon+ and for a tightly integrated modern developer ecosystem.

## Strengths to preserve

- Clang-class precision in diagnostics and source locations.
- LLVM-style modularity and reusable intermediate representations.
- GCC-class optimization ambition.
- rustc-style compile-time safety analysis where applicable.
- Strong inference and semantic analysis.
- Stable machine-readable compiler output.
- Source spans and bug provenance.
- Multiple backend paths where benchmarks and product needs justify them.

## Weaknesses to eliminate

Nova should avoid recurring compiler/toolchain problems:

- opaque diagnostics;
- duplicated semantic understanding across tools;
- unstable internal representations that break downstream integrations;
- slow feedback caused by unnecessary whole-program work;
- target/backend claims that are not executable and tested;
- compiler architecture that becomes impossible to evolve because every subsystem depends on undocumented internals.

## Independent ceiling

Nova must become a technically strong compiler and developer-intelligence product in its own right. Ecosystem consumers may reuse Nova's knowledge, but Nova does not exist merely as a metadata service for Cortex, Velocity, Sprout, or any other sibling.

## Ecosystem role

Nova owns compiler-facing truth: semantic analysis, inference, source spans, diagnostics, provenance, IR, optimization, and code generation. Sprout may consume compiler-known dependency information; Cortex may consume diagnostics/symbols/provenance; Parallel consumes executable/runtime contracts; Plasma consumes interop-aware compilation data; Velocity and Chronos consume build-relevant compiler outputs.

## Architectural invariant

**Nova must remain the compiler and developer-intelligence engine. Shared semantic graphs, IRs, and contracts must strengthen compiler quality first and ecosystem integration second; they must not turn Nova into a generic ecosystem control plane.**
