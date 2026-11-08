import { expect, test } from "vite-plus/test";
import { frameworkMigrations } from "../../../apps/kello-cli/src/tooling/migrations/bootstrap";

test("framework appends retirement without rewriting its published prefix", () => {
  const migrations = frameworkMigrations("kello_meta");
  expect(migrations.slice(0, 28).map(({ version, hash }) => ({ version, hash }))).toEqual(publishedPrefix);
  expect(migrations[28]?.version).toBe(29);
  const sql = migrations[28]?.statements.join("\n") ?? "";
  expect(sql).toContain("pg_trigger");
  expect(sql).toContain("tgfoid");
  expect(sql).toContain("kello_table_revision");
  expect(sql).toContain('DROP TABLE IF EXISTS "kello_meta".table_revisions');
  expect(sql).toContain('DROP TABLE IF EXISTS "kello_meta".connection_tickets');
  expect(sql).not.toContain("CASCADE");
});

const publishedPrefix = [
  {
    version: 1,
    hash: "253bd683b4ad4df8f8911f50a37b85aa853f2f4e418bed88e8b4d8e008ddcafb",
  },
  {
    version: 2,
    hash: "d838c8196d9e96699b25f2ed4e0ba0cce0c72b30337f12b42a67075e2af38c6c",
  },
  {
    version: 3,
    hash: "ffef3104c96922f8060c8b1b50891ca18a9bfc2d105ca8a35efe657985b968d1",
  },
  {
    version: 4,
    hash: "77aedfb72c094e01c0e99b9d7fa0fc8cc1c22f75e0725f5d5ee06406e709b895",
  },
  {
    version: 5,
    hash: "323970c307354f224459585f406626842491aa5ca697b8bcf7870bd43a4a4439",
  },
  {
    version: 6,
    hash: "79996aa9fa3fd8b536227ba27b6785b7eeb23dcc30def6962a74d265217e9189",
  },
  {
    version: 7,
    hash: "a8039d3cf161563ac9c89e13a6cdb8fec78e84300fd2946058dd95b65d1a2dc5",
  },
  {
    version: 8,
    hash: "cdadd35ef7767c9e7fc9a9fd0373c27e2586f479f4e90f4fddb6c193c490428b",
  },
  {
    version: 9,
    hash: "2ecff9a097f4cdde159ab02e4597803a26765452b0ecb63ac6a72171b963b6f2",
  },
  {
    version: 10,
    hash: "7d1c6ee0509ecf3a2aa3661a796836649fd0b09835575190ecdbe7f303a5f17e",
  },
  {
    version: 11,
    hash: "ecf32316910303753ec4af59534cd18b9db6108da7bb4d7bcd58cca24845537b",
  },
  {
    version: 12,
    hash: "f29bc7a8c85b38f4afa838d6c4b2a151a10386aa288bc7fd0af7c550af11ab77",
  },
  {
    version: 13,
    hash: "5c211151cab0ce2084596f1bab5c50b8b3328b30f6e10e2105d421e2ffec676a",
  },
  {
    version: 14,
    hash: "3925fbf52a5b6dd095000d653e9f79eafab4a7d65f071e761331abf3c83d0ece",
  },
  {
    version: 15,
    hash: "a4d8b5b5ce9eccf6e31cc3f08958801afe226480ae23fc2ed25e5bfb6e0872be",
  },
  {
    version: 16,
    hash: "0ac35abfa55a1d3495c308e50e44cfb0d95635d1fc78e1bbc9cea8b243f808df",
  },
  {
    version: 17,
    hash: "d5e8c5460d7054a7d92c2a24ee40f2568aee97fb47fea9685cf8392277683d17",
  },
  {
    version: 18,
    hash: "f3d068ef3c29859368f0ea49cdab77dcdf7d5d682a487205233a2e612f91b2de",
  },
  {
    version: 19,
    hash: "b79f243c0f753d1709780fb8ce0d925b85fd72013c94ca41350206f9a794a849",
  },
  {
    version: 20,
    hash: "de3f9fd3877bcc70d57493e0dd5d434e87fa51ff1ecb9655463defaca429e94a",
  },
  {
    version: 21,
    hash: "e1f95502532e5092ff681fef0171eb331ed0d01454f7b9f646a68c051195f99f",
  },
  {
    version: 22,
    hash: "6f722a0a5f36aafc0d65286ef76befce9e2cc308e0180cf86a8b7a42d596736d",
  },
  {
    version: 23,
    hash: "5d05be74a74950de5dd4af47c78482924ec32a0baeae2aa97909972633cd6180",
  },
  {
    version: 24,
    hash: "005efbbacdbeca53eeb9109fbedd0696a88ea64265315c94ff78a36bd662486d",
  },
  {
    version: 25,
    hash: "ab5d76581308653f7d5c4d0fd7a03d3430ab363cdba4dff533cee131a54c109a",
  },
  {
    version: 26,
    hash: "45d16c81c2b88a4458e5e1da9f941aba4d862adb5b9c63b83794835fa6e4dd6f",
  },
  {
    version: 27,
    hash: "85e19f59a5ddcaa398aae62f098cc382fa05748a506c21b8852a3e141bf1d396",
  },
  {
    version: 28,
    hash: "2378118f596b7471866d586ddc063eeee24c2fbd4764b04209722789a581a37d",
  },
];
