import { expect, test } from "vite-plus/test";
import { frameworkMigrations } from "../../../apps/kello-cli/src/tooling/migrations/bootstrap";

// Framework migration ledger hashes. Append new migrations; never rewrite an existing one.
const originalPrefix = [
  {
    version: 1,
    hash: "3e85a24d34c250e02aba3eb3983992bfbeef7fc8c045e4f7f8744892f842e353",
  },
  {
    version: 2,
    hash: "d57f0522f5c7277fa3798047fb2d48ae4fb8faf8eac2f1451908f452b3ae0aaf",
  },
  {
    version: 3,
    hash: "f8a5e637e5334a5d6f503920ebee3ccb3baaeee00ae2900a0d89d1b9d68d3c23",
  },
  {
    version: 4,
    hash: "6c412c2cd2bf2a8148f3c863bfdfbe3a42504911396cd616ce988bc10e41a12b",
  },
  {
    version: 5,
    hash: "0e3daa9eb0ad8390bd7b26c75655247403f36577ca12fcb65c676e14a11bb69a",
  },
  {
    version: 6,
    hash: "aaee5d48a89bcf97fac81ffca1db9c2172c7486865532e580ed129bd0e88cac3",
  },
  {
    version: 7,
    hash: "09466f4312f94df0a2b9cf082c99ac4eb5dae8374405df46859056d1abf009c5",
  },
  {
    version: 8,
    hash: "4f64abca5a855a1f697358b5824f1c68b8ed59961ec7ce5e6e2f931a3504b2f8",
  },
  {
    version: 9,
    hash: "170f335096dd839b2eef313b68003cb29fa2d39609cd12f0059abe87cea82031",
  },
  {
    version: 10,
    hash: "a3a190bfe5de60c96f5dc0a8283fe882fd378cc95d95f7a80ad33dd42fa6a7a0",
  },
  {
    version: 11,
    hash: "3b0ca9bcfc8eb99b02f9039b4c8787f68032f53149d48ab65a31094761e1500c",
  },
  {
    version: 12,
    hash: "55adadb647f07e131fad8f8cfe605aecc761fef171c6ad49ddd0c0e1266a49ad",
  },
  {
    version: 13,
    hash: "c613d7d2725bb8610e8d655da0edeacaa643d9aff0bf7a4f16ecb605743052cb",
  },
  {
    version: 14,
    hash: "e94878abb46580252228b4f4ae5a22d3ec7171fe53e6f3f89bf9406fb6197491",
  },
  {
    version: 15,
    hash: "a0cecf13c0861868f5bc085dbda891963828e221fe6b6b89fb9d4d0983e4174c",
  },
  {
    version: 16,
    hash: "eb6f80f0433faabc4719a33c8f15243be3c6888d9d5b68a1fea13116c7049a6d",
  },
  {
    version: 17,
    hash: "cc6791bf607f19f9c238202a2487082ee33cfd8acb4f7fd93a891b88f45f85b5",
  },
  {
    version: 18,
    hash: "fd9304ecc9a113b84137afc1e7794f08411bb54ddf8cc2c50c3846d52781a82d",
  },
  {
    version: 19,
    hash: "d0fb76d014d1687409ab3301f3a7e35890612da931ddf0d8ae7167d24a6ca038",
  },
  {
    version: 20,
    hash: "67c97a7a563d01c20e33ef12ab156feddaf22667d6ec7c84151ffbff64351e68",
  },
  {
    version: 21,
    hash: "a6c21d285edbee7d5a32c03b618ccded8655863f30df9d896472851237fe9617",
  },
  {
    version: 22,
    hash: "5daa8a9beca1607897c2afdb6781584d2e563204e6b209479ca94a88f0ada07f",
  },
  {
    version: 23,
    hash: "9958f94613bbf0ae21aa0f3a79aced9a1a9bb71203141eeba4495802744427a1",
  },
  {
    version: 24,
    hash: "2e97d63f35f641cbdd8b3158ca13947fc738b50ef529ce3dfcae6f0dc4ce7fdf",
  },
  {
    version: 25,
    hash: "4f1230cbd287f1901a76c04dcceb47650bf39bfa4a01117d36d5098599ac9953",
  },
  {
    version: 26,
    hash: "a3fe895139cfdd6f0fc979389bb94273432b0877e9ac62bb14bcdd26be219d48",
  },
  {
    version: 27,
    hash: "ce776323c133275a64b759f7bcf4a0950c633cd31d3fdbe33550198b04414a65",
  },
];

test("framework migration hashes stay stable", () => {
  expect(
    frameworkMigrations("kello_history_compat")
      .slice(0, originalPrefix.length)
      .map(({ version, hash }) => ({ version, hash })),
  ).toEqual(originalPrefix);
});
