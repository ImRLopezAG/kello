/** Shared by first-load virtual bindings and the stable schema/services entry point. */
export function serverBindings(typed: boolean): string {
  return `import { createProjectContext, createProjectServices } from "kello/server";
export const { tables, validators } = createProjectContext(schema, relations);
export const { Database, Tables, Validators, Search } = createProjectServices${typed ? "<typeof schema, typeof relations>" : ""}();
`;
}
