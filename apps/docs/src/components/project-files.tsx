import { File, Files, Folder } from "fumadocs-ui/components/files";

/** Hydrate the whole tree so nested folders share Fumadocs' React context. */
export function ProjectFiles() {
  return (
    <Files>
      <File name="kello.config.ts (optional operational overrides)" />
      <Folder name="kello" defaultOpen>
        <File name="app.config.ts (environment and component mounts)" />
        <File name="auth.config.ts (token trust and authorization)" />
        <File name="schema.ts" />
        <File name="relations.ts" />
        <File name="storage.ts (bucket policy)" />
        <Folder name="contracts" defaultOpen>
          <File name="tasks.ts (public contracts)" />
          <Folder name="internal">
            <File name="jobs.ts (private contracts)" />
          </Folder>
        </Folder>
        <Folder name="functions">
          <File name="tasks.ts (public implementations)" />
        </Folder>
        <Folder name="internal">
          <File name="jobs.ts (private implementations)" />
        </Folder>
        <Folder name="components">
          <Folder name="catalog">
            <File name="setup.ts (explicitly mounted)" />
          </Folder>
        </Folder>
        <Folder name="_generated" defaultOpen>
          <File name="api.js + api.d.ts (client runtime and types)" />
          <File name="rpc.ts (typed builders)" />
          <File name="server.ts (schema and Effect services)" />
          <Folder name="migrations">
            <File name="reviewed SQL and snapshots (commit these)" />
          </Folder>
        </Folder>
      </Folder>
      <Folder name=".kello">
        <File name="local links, runtime artifacts, release receipts" />
      </Folder>
    </Files>
  );
}
