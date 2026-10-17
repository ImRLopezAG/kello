import assert from "node:assert/strict";
import { cp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A tarball consumer: every backend import resolves the installed public package. */
export async function prepareCloudComponents(root: string) {
  const source = fileURLToPath(new URL("../../examples/components/", import.meta.url));
  await cp(join(source, "kello"), join(root, "kello"), {
    recursive: true,
    // This fixture authors different mounts and generates its own initial history.
    filter: (path) => path !== join(source, "kello/migrations") && !["_generated", ".loom"].includes(basename(path)),
  });
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--filename", join(root, "kello.tgz"), "--ignore-scripts"], {
    cwd: fileURLToPath(new URL("../../../apps/kello/", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(packed.exitCode, 0, "Kello package archive creation failed");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        kello: "file:./kello.tgz",
        valibot: "1.5.0",
        zod: "4.6.5",
        effect: "4.0.0",
        "drizzle-orm": "1.0.0-rc.4",
      },
      devDependencies: { "vite-plus": "1.0.0" },
    }),
  );
  const installed = Bun.spawnSync(["bun", "install", "--linker", "isolated", "--ignore-scripts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(installed.exitCode, 0, `Packed consumer installation failed: ${installed.stderr.toString()}`);
  await writeFile(
    join(root, "kello/auth.config.ts"),
    `import { defineRpcAuth } from "kello/server";
export default defineRpcAuth({ authorize: ({identity,path}) => {
  // This private procedure is reached only through a verified webhook or an authenticated parent.
  if (!identity && path.join("/") !== "entries/insert") throw new Error("Authentication required");
} });`,
  );
  await writeFile(
    join(root, "kello/components/journal/setup.ts"),
    `import { defineComponent } from "./_generated/setup";
import { readComponentEnvironment } from "kello/server";
import { Effect } from "effect";
import * as v from "valibot";
import { createHmac, timingSafeEqual } from "node:crypto";
const component = defineComponent({ name: "journal", env: { PREFIX: v.string(), SIGNING_SECRET: v.string() },
 services: ({env}) => Effect.succeed({ format: (text: string) => env.PREFIX + text }),
 http: [{ method: "POST", path: "/event", access: { kind: "signed-webhook", verify: ({request,body}): void => {
 const expected = createHmac("sha256", readComponentEnvironment(component).SIGNING_SECRET).update(body).digest();
 const actual = Buffer.from(request.headers.get("signature") ?? "", "hex");
 if(actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid signature");
 } }, handle: async ({request,context}) => {
 const input = v.safeParse(v.strictObject({text:v.pipe(v.string(),v.minLength(1),v.maxLength(200))}), await request.json());
 if(!input.success) return new Response(null,{status:400});
 await context.internal.entries.insert(input.output); return new Response(null,{status:204});
 } }],
});
export default component;`,
  );
  // This fixture verifies ordinary component RPC and HTTP streaming. The public
  // example's Neon .live() declaration has separate provider acceptance coverage.
  await writeFile(
    join(root, "kello/components/journal/contracts/entries.ts"),
    `import { defineContract, oc } from "../_generated/contract";
import { z } from "zod";
const entry=z.object({_id:z.uuid(),text:z.string()});
const base=oc.errors({UNAUTHORIZED:{},REJECTED:{message:"Could not save entry"}});
export default defineContract({
 list:base.output(z.array(entry)),
 add:base.input(z.object({text:z.string().trim().min(1).max(200)})).output(entry),
});`,
  );
  await writeFile(
    join(root, "kello/components/journal/functions/entries.ts"),
    `import { os } from "../_generated/rpc";
import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
export default os.entries.router({
 list:os.entries.list.handler(({context,errors})=>{
  if(!context.identity) throw errors.UNAUTHORIZED();
  const {entries}=context.tables;
  return context.db.select({_id:entries._id,text:entries.text}).from(entries)
   .where(and(eq(entries.owner,context.identity.subject),eq(entries.issuer,context.identity.issuer)))
   .orderBy(desc(entries._createdAt),desc(entries._id)).limit(50);
 }),
 add:os.entries.add.effect(function*({context,input}){
  return yield* Effect.promise(()=>context.internal.entries.insert(input));
 }),
});`,
  );
  const privatePath = join(root, "kello/components/journal/internal/entries.ts");
  await writeFile(
    privatePath,
    `import { os } from "../_generated/rpc";
export default os.internal.entries.router({
  insert: os.internal.entries.insert.handler(async ({input,context,errors}) => {
    const [entry] = await context.db.insert(context.tables.entries).values({
      text: context.services.format(input.text),
      owner: context.identity?.subject ?? "webhook",
      issuer: context.identity?.issuer ?? "webhook",
    }).returning({_id:context.tables.entries._id,text:context.tables.entries.text});
    if (!entry) throw errors.REJECTED();
    return entry;
  }),
});`,
  );
  await writeFile(
    join(root, "kello/contracts/journal.ts"),
    `import { defineContract, oc, eventIterator } from "kello/contract";
import * as v from "valibot";
const entry=v.object({_id:v.string(),text:v.string()}); const target=v.picklist(["left","right"]);
export default defineContract({
 list:oc.input(v.object({target})).output(v.array(entry)),
 add:oc.input(v.object({target,text:v.pipe(v.string(),v.minLength(1),v.maxLength(200))})).output(entry),
 watch:oc.input(v.object({target})).output(eventIterator(v.array(entry))),
});`,
  );
  await writeFile(
    join(root, "kello/functions/journal.ts"),
    `import { os } from "../_generated/rpc";
export default os.journal.router({
 list:os.journal.list.handler(({context,input})=>context.components[input.target].rpc.entries.list()),
 add:os.journal.add.handler(({context,input})=>context.components[input.target].rpc.entries.add({text:input.text})),
 watch:os.journal.watch.handler(async function*({context,input}){yield await context.components[input.target].rpc.entries.list();}),
});`,
  );
  await configureCloudComponents(root, "v1:");
}

export async function configureCloudComponents(root: string, prefix: string) {
  await writeFile(
    join(root, "kello/app.config.ts"),
    `import { defineApplication } from "kello/server";
import * as v from "valibot";
import journal from "./components/journal/setup";
const app=defineApplication({env:{SIGNING_SECRET:v.string(),LEFT_PREFIX:v.optional(v.string(),${JSON.stringify(prefix)}),RIGHT_PREFIX:v.optional(v.string(),"right:")},rpc:({os})=>({os})});
app.use(journal,{name:"left",public:"left",env:{PREFIX:app.env.LEFT_PREFIX,SIGNING_SECRET:app.env.SIGNING_SECRET}});
app.use(journal,{name:"right",public:"right",env:{PREFIX:app.env.RIGHT_PREFIX,SIGNING_SECRET:app.env.SIGNING_SECRET}});
export default app;`,
  );
}
