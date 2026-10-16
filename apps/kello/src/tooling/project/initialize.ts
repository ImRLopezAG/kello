import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "../config/define-config";
import { resolveProjectPath } from "../config/paths";

export function projectTemplates(name: string) {
  defineConfig({ project: name });
  const files = [
    [
      "kello/schema.ts",
      `import { defineSchema, defineTable } from "kello/server";\nexport default defineSchema((s) => ({\n  tasks: defineTable({ title: s.text().notNull() }, { publicFields: ["_id", "title"] }),\n}), { namespace: "app" });\n`,
    ],
    [
      "kello/app.config.ts",
      `import { defineApplication } from "kello/server";\nexport default defineApplication({ rpc: ({ os }) => ({ os }) });\n`,
    ],
    [
      "kello/auth.config.ts",
      `import { defineRpcAuth } from "kello/server";\n// Deny requests until you configure the application's authorization policy.\nexport default defineRpcAuth();\n`,
    ],
    [
      "kello/contracts/tasks.ts",
      `import { defineContract, oc } from "kello/contract";\nimport * as v from "valibot";\nexport default defineContract({ list: oc.output(v.array(v.string())) });\n`,
    ],
    [
      "kello/functions/tasks.ts",
      `import { os } from "../_generated/rpc";\nexport default os.tasks.router({\n  list: os.tasks.list.handler(async ({ context: { db, tables } }) =>\n    (await db.select({ title: tables.tasks.title }).from(tables.tasks).limit(100)).map((row) => row.title),\n  ),\n});\n`,
    ],
    [
      "package.json",
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: { "kello:generate": "kello generate", "kello:dev": "kello dev" },
          dependencies: {
            kello: "0.0.0",
            valibot: "1.5.0",
            "drizzle-orm": "1.0.0-rc.4",
          },
          devDependencies: { typescript: "7.0.2" },
        },
        null,
        2,
      ) + "\n",
    ],
    [
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "Preserve",
            moduleResolution: "Bundler",
            strict: true,

            noEmit: true,
            skipLibCheck: true,
          },
          include: ["kello/**/*.ts", "kello.config.ts"],
        },
        null,
        2,
      ) + "\n",
    ],
    [
      ".gitignore",
      "node_modules/\n.loom/\nkello/_generated/*\n!kello/_generated/migrations/\n.env\n.env.*\n!.env.example\n",
    ],
  ] as const;
  return files;
}

export async function initializeProject(root: string, name: string): Promise<readonly string[]> {
  const files = projectTemplates(name);
  await mkdir(root, { recursive: true });
  await mkdir(await resolveProjectPath(root, "kello/functions"), { recursive: true });
  await mkdir(await resolveProjectPath(root, "kello/contracts"), { recursive: true });
  const created: string[] = [];
  try {
    for (const [path, content] of files) {
      await writeFile(await resolveProjectPath(root, path), content, { flag: "wx" });
      created.push(path);
    }
    return created;
  } catch (cause) {
    await Promise.all(created.map((path) => unlink(join(root, path))));
    throw new Error("Initialization refused to overwrite an existing file or could not write the project", { cause });
  }
}
