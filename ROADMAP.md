Each item is a chunk that reaches green before the next. An item keeps its number for life: a closed
item leaves this file and its number is never reused, so a commit message citing an item by number
stays true.

- **1.** After the shared standing-proof observation mechanism lands in `@orkestrel/test`, adopt its explicit case evaluator for `buildWorkflowContractCases` in `tests/setup.ts` and `tests/src/core/contracts.test.ts`. Keep authored-only cases, owned restoration, timer and concurrency bounds, and destruction lifecycle proofs local; require no generator or general guard loop.
