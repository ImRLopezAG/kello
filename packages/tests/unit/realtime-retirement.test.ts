import { expect, test } from "vite-plus/test";
import { frameworkMigrations } from "../../../apps/kello/src/tooling/migrations/bootstrap";

test("framework appends retirement without rewriting its published prefix", () => {
  const migrations = frameworkMigrations("loom_meta");
  expect(migrations.slice(0, 28).map(({ version, hash }) => ({ version, hash }))).toEqual(publishedPrefix);
  expect(migrations[28]?.version).toBe(29);
  const sql = migrations[28]?.statements.join("\n") ?? "";
  expect(sql).toContain("pg_trigger");
  expect(sql).toContain("tgfoid");
  expect(sql).toContain("loom_table_revision");
  expect(sql).toContain('DROP TABLE IF EXISTS "loom_meta".table_revisions');
  expect(sql).toContain('DROP TABLE IF EXISTS "loom_meta".connection_tickets');
  expect(sql).not.toContain("CASCADE");
});

const publishedPrefix = [
  {
    version: 1,
    hash: "98b6fce6abcae280c3bcb4825d72fdc3ccdb4d04014f9f472b2d0031a3a0dad0",
  },
  {
    version: 2,
    hash: "cc76c3213515362ca5289326a263ba3b6ce6d5d527c30fd1aa421878c2a243c8",
  },
  {
    version: 3,
    hash: "8598e916de2e74c496723ae10b5b44580c263b4be17ec7cddebb667ee4fd6fdf",
  },
  {
    version: 4,
    hash: "af74afa3cd5355f0c65233f4f73f96898dd6396b748b49875d0cf3ebb77ea829",
  },
  {
    version: 5,
    hash: "a9db42ee821c00009af456971d599919c79da312130b6b5409c3303c5c91eb7e",
  },
  {
    version: 6,
    hash: "d8428591f6675014ae401bfbc0beff41bfec7cffb0313bf9359c199848527975",
  },
  {
    version: 7,
    hash: "bf30990a701fdc1e688ab267c6efbcc6f5e0993ff4eb488bb17d2e975ebc2be4",
  },
  {
    version: 8,
    hash: "a73ae15c4f9f83242998a8d7771b5f49f2eadc591edaf00853564af2943ded7f",
  },
  {
    version: 9,
    hash: "18eb5125a73ef667d68a2e7a5cd85e33664f5b95fd79a0dcb96b534861d081a3",
  },
  {
    version: 10,
    hash: "485f64c2c6af93dd6dce737f09165b7e93a9607511dad881e0c4f3c55ba7b4bf",
  },
  {
    version: 11,
    hash: "744ecc83909e80681bdf5f208d098c6ea63a4548aa468a3c7f9b1593a1b245c0",
  },
  {
    version: 12,
    hash: "13b0cda76c18293eab507b65563fb5e54370026ea769f18daddf34366032745b",
  },
  {
    version: 13,
    hash: "d350ce168bd2fb6e6cb96384e9ef1ccfbb01c8a1d3e6791cb9d895470213ab9d",
  },
  {
    version: 14,
    hash: "a3f11b75d43fe7fa7154c1d3fded0eb1112fc40497c5abfb8bf49f1a4ce9ba0e",
  },
  {
    version: 15,
    hash: "e56185a95702a672b7385c3a89aad13c66f3cff4b6ac75dd00fec00ff9332de1",
  },
  {
    version: 16,
    hash: "f92a42da7eba824586b16e754f6d2089d03d384c2e405030ee539f2bc33866b6",
  },
  {
    version: 17,
    hash: "085340ebcd263b7a4bcc40b45a5980d504a02b80a68dab379b1b94de27f638f4",
  },
  {
    version: 18,
    hash: "19e0a872a56d6316326c3e0ce6c930af959f09dfd02ad22ad9c3d05ec1e554c1",
  },
  {
    version: 19,
    hash: "81b8450223fef7822bc630a8c9d75c2fe2ad60f35afb87aed866e26a06958149",
  },
  {
    version: 20,
    hash: "5e54fe90cc62a743d7d9aaaafb3f287e2052b820e587df96a44489b84841774e",
  },
  {
    version: 21,
    hash: "c04e4d4217fd61dd52cb6216586826efa4f28bed6338faef4655a8a3116870de",
  },
  {
    version: 22,
    hash: "20863e23e2c32398de54bcf183c9332d195aec5251b927715f694b57d7fa1704",
  },
  {
    version: 23,
    hash: "31785428170b4e272a7fd22de48ff7b70f208f038d4f94522e72d2993f48d726",
  },
  {
    version: 24,
    hash: "4b17082d891614609ae26b058171b6ae3b9ac84b0c46094143088ca4426c5423",
  },
  {
    version: 25,
    hash: "f0095bf7de3b698678f4dc68a93bfe377fee1fcda3a1b272771accca09ac9128",
  },
  {
    version: 26,
    hash: "a64e1b464f71e9b5577cfbee4c8ee632946651b1a2728d3994aa8db289506411",
  },
  {
    version: 27,
    hash: "f50a24458564feb24a4db10d1bebd0414c583f6b7d1f4cfc689623bf675bc9f3",
  },
  {
    version: 28,
    hash: "1cb0b393af92b460868267fb6c3ba66f098236aeb35f784f40772c106ea19713",
  },
];
