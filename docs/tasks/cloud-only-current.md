# Neon cloud-only implementation

Plan: [Neon cloud-only runtime and live queries](../plans/2026-10-16-1919-refactor-neon-cloud-only-plan.md).

- [x] U1: explicit Realtime status/enable, agreed target bindings, explicit origins, ready-only public URL persistence.
- [ ] U2: generated HTTP client and Neon-native `.live()` functions; deployment readiness and protected signing-secret injection.
- [ ] U3: cloud preview development instead of local backend serving.
- [ ] U4: remove legacy live/WS engine and retire owned revision objects through forward migration.
- [ ] U5: prune package, exports, dependencies, examples and docs.
- [ ] U6: current cloud/browser integration, package and release checks.

U1 verification: four reproduced review regressions fixed; main rerun 24 tests/121 assertions green (Bun 1.4.3); app three-tsconfig and e2e typechecks green. Worker build/lint/format green. Astra-low affected code/implementation/security review approved the bounded phase with no findings. Status avoids loader-owned persistent writes; authored configuration remains executable code, not a sandbox.

Real provider enablement and cloud/browser acceptance remain U6. Saved public URLs are discovery information, not fresh readiness evidence. Earlier bundler/local-job removal work remains preserved for the later units. No release acceptance is claimed.
