import { packedFullTextFiles } from "./packed-search-full-text";

// Reuse only authored declarations, never the accepted 50-command runner.
// Node's ESM loader needs explicit extensions. These copies retain the exact
// accepted schema/policy; they are independent public descriptor construction,
// not execution of the generated TS registry or a native database handler.
export const packedFullTextNodeFiles = {
  ...packedFullTextFiles,
  "schema.mjs": packedFullTextFiles["app/kello/schema.ts"],
  "relations.mjs": packedFullTextFiles["app/kello/relations.ts"].replace('from "./schema"', 'from "./schema.mjs"'),
  "tasks-contract.mjs": packedFullTextFiles["app/kello/contracts/tasks.ts"].replace("} as const;", "};"),
} as const;

export const packedFullTextNodeInitialize = `import { initializeProject, saveResolvedProject } from "kello/tooling";
await initializeProject("./app", "packed-full-text-node");
await saveResolvedProject("./app", { format: 1, projectId: "fixture", branchId: "br-fixture", branchName: "dev", protected: false, isDefault: false, databaseName: "neondb", migrationRole: "neondb_owner", public: { serviceUrl: "https://packed-full-text-node.example.test" } });
`;

export const packedFullTextNodePreflight = `import assert from "node:assert/strict";
assert.equal(process.versions.bun, undefined);
assert.match(process.version, /^v24\\./);
console.info(JSON.stringify({ proof: "packed-full-text-node-runtime", phase: "preflight", execPath: process.execPath, version: process.version, node: process.versions.node }));
`;

// This exact .mjs is executed by the resolved Node executable. No transpiler,
// loader, Bun runtime, private package entry, cast, or source alias is used.
export const packedFullTextNodeConsumer = `import assert from "node:assert/strict";
import { realpath, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute } from "node:path";
assert.equal(process.versions.bun, undefined);
assert.match(process.version, /^v24\\./);
const runtime = { execPath: process.execPath, version: process.version, node: process.versions.node };
const identity = JSON.parse(await readFile(new URL("./identity.json", import.meta.url), "utf8"));
assert.equal(await realpath(process.execPath), identity.nodeExecutable);
function contained(parent, child) {
  const path = relative(parent, child);
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith("../");
}
const resolutions = {};
for (const entry of ["kello/server", "kello/client", "kello/contract"]) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(entry)));
  assert.ok(contained(identity.installedPackage, resolved), entry + ": installed public export required");
  resolutions[entry] = resolved;
}
assert.equal(await realpath(fileURLToPath(new URL("./app/kello/_generated/current", import.meta.url))), identity.currentGeneration);
assert.equal(await realpath(fileURLToPath(new URL("./app/kello/_generated/current/api.js", import.meta.url))), identity.currentGeneration + "/api.js");
const { createProjectContext, searchPublicNode } = await import("kello/server");
const { resolveContract } = await import("kello/contract");
const { createSearchDataGuard } = await import("kello/client");
const { default: schema } = await import("./schema.mjs");
const { default: relations } = await import("./relations.mjs");
const { default: declaration } = await import("./tasks-contract.mjs");
const contract = resolveContract(declaration, createProjectContext(schema, relations));
const { createClient, version } = await import("./app/kello/_generated/api.js");
assert.equal(version, identity.generationVersion);
const selected = { fullText: { document: "content", query: "database" }, columns: { title: true } };
const outputCases = [
  ["selected-title", { title: "safe" }, true],
  ["eligible-body", { title: "safe", body: "unselected" }, true],
  ["rank", { title: "safe", rank: 1 }, false],
  ["private-rank", { title: "safe", _kello_rank: 1 }, false],
  ["vector", { title: "safe", vector: "private" }, false],
  ["secret", { title: "safe", secret: "private" }, false],
  ["wrong-title", { title: 42 }, false],
];
const cacheCases = [
  ["selected-title", { title: "safe" }, true],
  ["compatible-extra", { title: "safe", extra: "compatible" }, true],
  ["granted-body", { title: "safe", body: "unselected" }, true],
  ["missing-title", {}, false],
  ["wrong-title", { title: 42 }, false],
];
const inputNegatives = [
  ["ungranted-document", { fullText: { document: "hidden", query: "database" } }],
  ["config", { fullText: { document: "content", query: "database", config: "pg_catalog.simple" } }],
  ["rank", { fullText: { document: "content", query: "database", rank: 1 } }],
  ["text-length", { fullText: { document: "content", query: "x".repeat(97) } }],
  ["utf8-bytes", { fullText: { document: "content", query: "界".repeat(65) } }],
];
const cases = [];
function record(name) { assert.equal(cases.includes(name), false); cases.push(name); }
function data(name, row) {
  return { ...(name === "list" ? { rows: [row] } : { pages: [[row]] }), nextCursor: null, previousCursor: null };
}
const forbidden = /pg_catalog|packed-content-v1|packed-hidden-v1|fts_packed_private_marker|ts_rank|to_tsvector|plainto_tsquery|representation|weights?|taskLabels|secret|"(?:rank|_kello_rank|config|vector)"/;
for (const name of ["list", "watch"]) {
  const input = contract[name]["~orpc"].inputSchemas[0];
  const output = contract[name]["~orpc"].outputSchemas[0];
  const node = searchPublicNode(input);
  assert.ok(node);
  assert.ok(output);
  assert.deepEqual(Object.keys(node.fullText), ["content"]);
  assert.deepEqual(Object.keys(node.fullText.content), ["semantics"]);
  assert.match(node.fullText.content.semantics, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(node), forbidden);
  record(name + ":masked-descriptor");
  const guard = createSearchDataGuard(["tasks", name], node);
  for (const [label, row, expected] of cacheCases) {
    assert.equal(guard.accepts({ input: selected, data: data(name, row) }), expected, label);
    record(name + ":cache:" + label);
  }
  // Strict output policy eligibility is independent of request projection.
  // Missing selected title is a cache negative, not a descriptor negative.
  for (const [label, row, expected] of outputCases) {
    const value = data(name, row);
    if (name === "list") {
      const checked = await output["~standard"].validate(value);
      assert.equal(checked.issues === undefined, expected, label);
      if (expected) assert.deepEqual(checked.value, value);
    } else {
      let finalized = false;
      async function* event() { try { yield value; } finally { finalized = true; } }
      const checked = await output["~standard"].validate(event());
      assert.equal(checked.issues, undefined, "validation is lazy until next()");
      const iterator = checked.value;
      const errors = [];
      try {
        if (expected) {
          assert.deepEqual(await iterator.next(), { done: false, value });
          assert.equal((await iterator.next()).done, true);
        } else {
          await assert.rejects(() => iterator.next(), { code: "ASYNC_ITERATOR_OBJECT_VALIDATION_FAILED" });
        }
      } catch (cause) { errors.push(cause); }
      finally {
        try { await iterator.return(); } catch (cause) { errors.push(cause); }
        if (!finalized) errors.push(new Error("source iterator finally did not run"));
      }
      if (errors.length) throw new AggregateError(errors, "live validation/return failed");
    }
    record(name + ":output:" + label);
  }
  assert.equal((await input["~standard"].validate(selected)).issues, undefined);
  record(name + ":input:legal");
  for (const [label, value] of inputNegatives) {
    assert.ok((await input["~standard"].validate(value)).issues, label);
    record(name + ":input:" + label);
  }
}

// Construction only: no call, fetch, queryFn invocation, DB or live subscription.
const connection = createClient({ getToken: async () => { throw new Error("construction must not request credentials"); } });
const errors = [];
try {
  const { rpc } = connection;
  const builders = [
    ["query", row => rpc.tasks.list.queryOptions({ input: selected, initialData: data("list", row), placeholderData: () => data("list", row) })],
    ["infinite", row => rpc.tasks.list.infiniteOptions({ input: cursor => ({ ...selected, cursor }), initialPageParam: null,
      getNextPageParam: page => page.nextCursor, getPreviousPageParam: page => page.previousCursor,
      initialData: { pages: [data("list", row)], pageParams: [null] },
      placeholderData: () => ({ pages: [data("list", row)], pageParams: [null] }) })],
    ["live", row => rpc.tasks.watch.liveOptions({ input: selected, initialData: data("watch", row), placeholderData: () => data("watch", row) })],
  ];
  for (const [kind, build] of builders) {
    for (const [label, row, expected] of cacheCases) {
      if (expected) {
        const options = build(row);
        assert.ok(Array.isArray(options.queryKey));
        assert.equal(typeof options.queryFn, "function");
        const value = kind === "infinite" ? { pages: [data("list", row)], pageParams: [null] } : data(kind === "live" ? "watch" : "list", row);
        assert.deepEqual(options.initialData(), value);
        assert.deepEqual(options.placeholderData(), value);
      } else {
        assert.throws(() => build(row), /Search initialData does not match the selected projection/);
      }
      record(kind + ":options:" + label);
    }
  }
  const placeholderBuilders = [
    ["query", value => rpc.tasks.list.queryOptions({ input: selected, placeholderData: () => value })],
    ["infinite", value => rpc.tasks.list.infiniteOptions({ input: cursor => ({ ...selected, cursor }), initialPageParam: null,
      getNextPageParam: page => page.nextCursor, placeholderData: () => value })],
    ["live", value => rpc.tasks.watch.liveOptions({ input: selected, placeholderData: () => value })],
  ];
  for (const [kind, build] of placeholderBuilders) {
    for (const [label, row] of cacheCases.filter(item => !item[2])) {
      const value = kind === "infinite" ? { pages: [data("list", row)], pageParams: [null] } : data(kind === "live" ? "watch" : "list", row);
      const options = build(value);
      assert.equal(options.initialData(), undefined);
      assert.equal(options.placeholderData(), undefined);
      record(kind + ":placeholder:" + label);
    }
  }
  assert.notDeepEqual(rpc.tasks.list.queryOptions({ input: selected }).queryKey,
    rpc.tasks.list.queryOptions({ input: { ...selected, fullText: { document: "content", query: "different" } } }).queryKey);
  record("query:distinct-keys");
} catch (cause) { errors.push(cause); }
finally {
  try { connection.dispose(); } catch (cause) { errors.push(cause); }
}
if (errors.length) throw new AggregateError(errors, "options/transport cleanup failed");
assert.equal(cases.length, 60);
console.info(JSON.stringify({ proof: "packed-full-text-node-consumer", runtime, resolutions,
  currentGeneration: identity.currentGeneration, generationVersion: version,
  descriptorConstruction: "public authored mjs declarations; generated TS registry not executed",
  descriptors: 2, finiteOutputCases: 7, liveOutputCases: 7, cacheCases: 10,
  inputCases: 12, maskedDescriptorCases: 2, nativeOptionCases: 15, placeholderCases: 6, distinctKeyCases: 1,
  cases, caseCount: cases.length, databaseExecution: false }));
`;
