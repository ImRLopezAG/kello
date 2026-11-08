# Relational search plan revision review

Date: 2026-09-30.

Reviewed document: [Relational Search and Pagination](../plans/2026-09-29-2003-feat-relational-search-pagination-plan.md).

Scope: update the existing plan with schema/relations-derived validators, the prior typing findings, and pagination verification. Preserve its Product Contract and session-settled decisions. This is a planning review; no implementation, tests, cloud mutations, or commits ran.

## Evidence

- [U1 characterization](../validation/2026-09-29-search-u1-typing-proof.md) establishes the native fixed-output boundary, rather than accepted projection typing.
- [Opus typing review](2026-09-29-search-opus-typing-review.md) contains the corrected declaration sketch and the observed cross-projection placeholder failure. Its model receipt belongs to that earlier review; this revision did not launch another model.
- Current root/component code generation uses `createProjectContext(schema)` and native client/options creation. Runtime context also constructs validators separately. These call sites substantiate the graph-aware context work assigned to the revised units.
- The application RPC definition resides at `apps/kello/src/core/server/application/definition.ts`.

## Confidence check

Before revision, technical decisions, implementation units, and system impact each scored 2: one material gap plus the critical-section bonus. The gaps were the generated typing mechanism, proof coverage for cache reuse, and graph-aware context construction across call sites. Verification also lacked cases for those findings. The revision strengthens their owning decisions and units, retaining all existing scenario IDs. After revision, no section retains two confidence-gap points. Unproven mechanisms remain explicit U1 proof obligations rather than claims of compatibility.

## Coverage

The ce-doc-review lenses ran sequentially in the main session, following the user's AGENTS.md mapping. No independent reviewer context or cross-model pass ran, and no confidence promotion rests on reviewer agreement.

| Lens               | Result                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coherence          | Product Contract preserved; unit dependencies and scenario IDs remain consistent.                                                                                                         |
| Feasibility        | Corrected the application-definition source path. Packed generation and native observer proof are prerequisites for dependent runtime work.                                               |
| Scope              | Shared descriptors and generated declarations serve existing requirements; no new cache, transport, auth integration, or projection-file proliferation is planned.                        |
| Security           | Root/relation authorization, namespace checks, cursor bindings, public graph masking, and response validation before stripping/publication have owning units and scenarios.               |
| Adversarial        | The prior green characterization cannot satisfy acceptance; placeholder reuse and widened inputs are explicit falsification cases.                                                        |
| Product            | Existing schema knowledge and native options remain the agreed surface. Generated versus directly reconstructed upstream utilities are distinguished rather than presented as equivalent. |
| Client interaction | First-event loading, projection switches, pending placeholders, hydration, cancellation, and reconnect have explicit tests. No visual design change is included.                          |

## Resolved findings

1. **Application-definition path was wrong.** Following it would misdirect the component/context integration work. The file inventory confirms the server/application location; the plan now names that existing file. Mechanical correction, confidence 100, applied.

The optional-property compiler setting was also made explicit in the planned U1 proof, carrying forward the prior typing review's verification scope.

No proposed edits or user decisions remain from this document review. The unresolved technical question is whether U1 can prove the proposed generated declarations, including native placeholder/default surfaces. The plan assigns that experiment and its failure handling; it does not authorize weakening the selected-result requirement or introducing a runtime wrapper when proof fails.

## Structural verification

- Product Contract matches the pre-revision document exactly, including R1–R19 and AE1–AE5.
- U1–U8 keep their identifiers and dependency order.
- P001–P130 are unique and consecutive; P001–P107 remain present.
- Relative evidence links resolve, Markdown fences are paired, and document whitespace checks pass.

Document review complete (non-interactive mode): one mechanical correction applied; zero proposed fixes, decisions, or FYI findings remain. Ready to start U1's feasibility proof. U2–U8 require that proof to pass.
