import { defineRelations } from "drizzle-orm";
import type { BuildQueryResult } from "drizzle-orm";
import { defineSchema, defineTable } from "../../../apps/loom/src/core/server/index";

export const searchSchema = defineSchema(
  (s) => ({
    tasks: defineTable({
      title: s.text().notNull(),
      done: s.boolean().notNull(),
      projectId: s.reference("projects"),
      at: s.timestamp().notNull(),
      count: s.bigint().notNull(),
      amount: s.numeric().notNull(),
    }),
    projects: defineTable({ name: s.text().notNull(), organizationId: s.reference("organizations").notNull() }),
    organizations: defineTable({ name: s.text().notNull() }),
    teams: defineTable({ name: s.text().notNull(), organizationId: s.reference("organizations").notNull() }),
    members: defineTable({ name: s.text().notNull(), teamId: s.reference("teams").notNull() }),
    labels: defineTable({ name: s.text().notNull() }),
    taskLabels: defineTable({ taskId: s.reference("tasks").notNull(), labelId: s.reference("labels").notNull() }),
  }),
  { namespace: "app" },
);

export const searchRelations = defineRelations(searchSchema.tables, (r) => ({
  tasks: {
    project: r.one.projects({ from: r.tasks.projectId, to: r.projects._id }),
    labels: r.many.labels({
      from: r.tasks._id.through(r.taskLabels.taskId),
      to: r.labels._id.through(r.taskLabels.labelId),
    }),
  },
  projects: {
    organization: r.one.organizations({ from: r.projects.organizationId, to: r.organizations._id, optional: false }),
  },
  organizations: { teams: r.many.teams({ from: r.organizations._id, to: r.teams.organizationId }) },
  teams: { members: r.many.members({ from: r.teams._id, to: r.members.teamId }) },
}));

export const titleSelection = { columns: { title: true } } as const;
export const doneSelection = { columns: { done: true } } as const;
export const nestedSelection = {
  columns: { _id: true, at: true, count: true, amount: true },
  with: {
    labels: { columns: { name: true } },
    project: {
      columns: { name: true },
      with: {
        organization: {
          columns: { name: true },
          with: {
            teams: { columns: { name: true }, with: { members: { columns: { name: true } } } },
          },
        },
      },
    },
  },
} as const;

export type SearchRow<Selection extends typeof titleSelection | typeof doneSelection | typeof nestedSelection> =
  BuildQueryResult<typeof searchRelations, (typeof searchRelations)["tasks"], Selection>;
export type SearchPage<Row> = { rows: Row[]; nextCursor: string | null };
export type TitlePage = SearchPage<SearchRow<typeof titleSelection>>;
export type DonePage = SearchPage<SearchRow<typeof doneSelection>>;
export type NestedPage = SearchPage<SearchRow<typeof nestedSelection>>;
