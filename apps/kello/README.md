# Kello

A contract-first reactive TypeScript backend framework for Neon and PostgreSQL.

Kello combines typed functions, schemas, authorization, generated clients, React bindings, and explicitly declared Neon live queries. Applications provide their own trusted login-session resolver for authenticated HTTP live queries.

This package is in development. Alpha releases are experimental. Live queries support explicitly declared flat projections with validated scalar decoding; confirmation means installed transaction progress, and a timeout or disconnect leaves confirmation unknown. Trusted-login propagation through tickets and WebSocket RPC is not supported.

See the [repository](https://github.com/ImRLopezAG/kello), [examples](https://github.com/ImRLopezAG/kello/tree/main/packages/examples), and [current limitations](https://github.com/ImRLopezAG/kello/blob/main/apps/docs/content/docs/operations/limits.mdx).

Licensed under MIT. Bundled dependency notices and patches are included in `dist/third-party`.
