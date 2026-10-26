# Kello CLI

Install `kello` for runtime code and `kello-cli` as a development dependency for configuration, generation, migrations and deployment.

```sh
bun add kello
bun add --dev kello-cli vite-plus
bunx kello generate
```

Import `defineConfig` and deployment APIs from `kello-cli`. The executable remains `kello`. Both packages use the same release version. The CLI uses the official Neon SDK and authenticated Neon CLI profile; keep these tools off application production dependency lists.

The tooling source lives under `apps/kello-cli/src`; published artifacts contain all required JavaScript and declarations, with runtime APIs externalized to `kello`.
