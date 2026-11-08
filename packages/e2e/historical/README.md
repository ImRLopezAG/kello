# Historical acceptance runtime

`run.ts` archives commit `b8ddb6a9d7bb398f8e2993ae6cafe7710ba1dafc`, installs its frozen dependencies and builds its original framework. It overlays only the three acceptance fixtures in this directory and the current public-key issuer fixture. The historical framework source is never patched.

The fixture files have a `.fixture` suffix because they compile against the historical public API, not the current workspace. They are retained to reproduce the polling comparison and to populate a genuine metadata-version-21 branch before native upgrade acceptance. They are not shipped in framework packages.

The initial recorded fixture hashes (SHA-256):

- `baseline-live.test.ts.fixture`: `dd863883291030bf9005a94087bffe2bac1592555d50757b85165ae9cfb2e20c`
- `cloud-baseline-browser.ts.fixture`: `4e10c062fa618a5bbf20757cd033fbd36c44270711bf8a64f7245bf97dd02d86`
- `cloud-live-services.ts.fixture`: `099bab6bec8a71d43e73f1ed4a993726bd25bee93a0858518615090b78f39a79`

A full benchmark uses 30 seconds of warmup and 600 seconds of measured writes. Upgrade preparation uses the same populated fixture with a one-second measurement after warmup; that preparation is not a performance result. Test receipts distinguish those workloads.

Run cloud acceptance only on an explicitly selected, unprotected `kello-acceptance-` child branch. `KELLO_CLOUD_SUITE=upgrade bun run test:cloud` prepares this historical fixture when no `KELLO_CLOUD_PREVIOUS_VERSION` is supplied. Retain complete Git history so the pinned commit is available. The owner of the acceptance branch is responsible for deleting it after all evidence is collected; CI does so in an `always()` cleanup step and verifies deletion.
