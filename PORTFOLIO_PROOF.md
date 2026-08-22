# Nova — Portfolio Proof Contract

**Track:** Compiler infrastructure

Nova is complete only when compilation preserves defined semantics, rejects invalid input reliably, produces reproducible artifacts, and demonstrates measurable performance/ergonomic value.

Required proof: parser/semantic/codegen tests; Cannon/Cannon+ conformance as applicable; malformed/adversarial input tests; differential output tests; benchmarks for compile time, output size, runtime, memory, and incremental behavior; deterministic builds where feasible; packaging/install evidence.

**Next proof target:** compile a versioned conformance corpus through Nova and compare semantic results plus compile/runtime metrics against the current baseline/reference path.