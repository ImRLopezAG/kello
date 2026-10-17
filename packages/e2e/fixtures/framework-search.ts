import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Adds a real route and generated search contract to each isolated framework consumer. */
export async function writeFrameworkSearch(root: string, framework: "next" | "start") {
  await writeFile(
    join(root, "kello/relations.ts"),
    'import { defineRelations } from "drizzle-orm"; import schema from "./schema"; export default defineRelations(schema.tables);',
  );
  await writeFile(
    join(root, "kello/contracts/search.ts"),
    `import { defineContract, oc, searchErrors } from "kello/contract";
import { and, eq } from "drizzle-orm";
import type { SearchPolicy } from "kello/server";
import relations from "../relations";
export default defineContract(({ validators }) => {
 const policy = { scope: { name: "owner", version: "1", where: ({ table, identity }) => and(eq(table.owner, identity?.subject ?? ""), eq(table.issuer, identity?.issuer ?? ""))! }, columns: ["_id", "text"], filter: ["text"], order: ["text"] } as const satisfies SearchPolicy<typeof relations, typeof relations.notes>;
 const finite = validators.tables.notes.search(policy);
 return { page: oc.errors({ ...searchErrors, UNAUTHORIZED: {} }).input(finite.input).output(finite.output) };
});`,
  );
  await writeFile(
    join(root, "kello/functions/search.ts"),
    `import { os } from "../_generated/rpc";
export default os.search.router({ page: os.search.page.handler(({ context, input }) => context.search.notes.paginate(input)) });`,
  );
  const directory = framework === "next" ? "components" : "src/components";
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, directory, "search.tsx"),
    `"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useKello } from "../lib/kello";
import type { Id } from "kello/server";
type CursorPage = { cursor: string | null };
export function SearchPanel() {
 const { rpc } = useKello();
 const firstPage: CursorPage = { cursor: null };
 const result = useInfiniteQuery(rpc.search.page.infiniteOptions({ input: (cursor: string | null) => ({ columns: { _id: true, text: true }, cursor, limit: 20 }), initialPageParam: firstPage.cursor, getNextPageParam: page => page.nextCursor }));
 return <><ul>{result.data?.pages.flatMap(page => page.rows.map(note => { const id: Id<"notes"> = note._id; return <li key={id}>{note.text}</li>; }))}</ul><button disabled={!result.hasNextPage || result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>Load more</button></>;
}`,
  );
  if (framework === "next") {
    await mkdir(join(root, "app/search"), { recursive: true });
    await writeFile(
      join(root, "app/search/page.tsx"),
      '"use client"; import dynamic from "next/dynamic"; const SearchPanel = dynamic(() => import("../../components/search").then(module => module.SearchPanel), { ssr: false }); export default function Page() { return <main><h1>Search</h1><SearchPanel /></main>; }',
    );
  } else {
    await writeFile(
      join(root, "src/routes/search.tsx"),
      'import { createFileRoute } from "@tanstack/react-router"; import { SearchPanel } from "../components/search"; export const Route = createFileRoute("/search")({ ssr: false, component: SearchPanel });',
    );
  }
}
