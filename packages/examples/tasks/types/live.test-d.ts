import type { Id } from "kello/server";
import { createClient } from "../kello/_generated/react";
declare const connection: ReturnType<typeof createClient>;
declare const projectId: Id<"projects">;
export function useTypedTasks() {
  const rows = connection.api.tasks.list.useLiveQuery({ projectId }).data;
  if (rows?.[0]) {
    const taskId: Id<"tasks"> = rows[0]._id;
    const ownerProject: Id<"projects"> = rows[0].projectId;
    // @ts-expect-error Live output preserves distinct table brands.
    const wrongTable: Id<"projects"> = rows[0]._id;
    void taskId;
    void ownerProject;
    void wrongTable;
  }
  // @ts-expect-error Live input retains the declared UUID string type.
  connection.api.tasks.list.useLiveQuery({ projectId: 42 });
  return rows;
}
