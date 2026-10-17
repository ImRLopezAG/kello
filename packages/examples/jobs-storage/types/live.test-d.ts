import type { Id } from "kello/server";
import { createClient } from "../kello/_generated/react";

declare const connection: ReturnType<typeof createClient>;
export function useTypedFiles() {
  const rows = connection.api.files.list.useLiveQuery({}).data;
  if (rows?.[0]) {
    const fileId: Id<"files"> = rows[0]._id;
    // @ts-expect-error Live output preserves the file table brand.
    const wrongTable: Id<"fileIntents"> = rows[0]._id;
    void fileId;
    void wrongTable;
  }
  return rows;
}
