import { expect, test } from "vite-plus/test";
import { frameworkMigrations } from "../../../apps/kello-cli/src/tooling/migrations/bootstrap";

// Published framework prefix from main before the Kello rename. Existing ledgers retain these hashes.
const originalPrefix = [
  {
    version: 1,
    hash: "bf48f1bb3900097d0515038a6582e2d6de7a0e2a08987dbd43107d3269c5e8d6",
  },
  {
    version: 2,
    hash: "73877450e9966bd708e3f831f225971742660e731e4ae06b2b3ae8c601b9ed66",
  },
  {
    version: 3,
    hash: "d5712d30a4f534ffd4fa2957cb295d82ff5d7663f24a074ab0b0052425a07fb7",
  },
  {
    version: 4,
    hash: "aece3ac903ca08a15ad47647111383fee9787a164efa37e58966601967eef151",
  },
  {
    version: 5,
    hash: "91ec691ef38d8dd7ebee41cfd164b624b6a841731774ee019d2a43b042ca341f",
  },
  {
    version: 6,
    hash: "e7c42a00a62eebe4a9855a7a9447bd7a2e60b1b64f663f00393a808d5711b8cd",
  },
  {
    version: 7,
    hash: "dd34d47a25d27bac48b265e4af52e8d9c9967c0c36e35013c6d521581c479006",
  },
  {
    version: 8,
    hash: "2ca04d9088438930d893eb121879c84348d81f7e56c9755a6db988194df94aec",
  },
  {
    version: 9,
    hash: "4e4fb541d128c399253656bf252f7a0257417eb5e6f69d390452610af08783a8",
  },
  {
    version: 10,
    hash: "033152a491aa68e6ef6ea14710945ee26e56cf6d39e004dfe3bbeb1bebd53102",
  },
  {
    version: 11,
    hash: "24741d3d9e991f59f430432d36453e2b2d1eb2f45c86616a1e26f0fa21089e88",
  },
  {
    version: 12,
    hash: "3938560b9c3e638b0fd198e3cb6121277db8655cc6e2762c9f7cb69091eadb31",
  },
  {
    version: 13,
    hash: "d76bf5ae4eda2d6cb659088d4eee00b04f788ab16f181b87044c78eff05f4516",
  },
  {
    version: 14,
    hash: "4f1a311e8c9cad530d0ef3adfc6115615de3d7881e81a94a38786ca087de4700",
  },
  {
    version: 15,
    hash: "1567cff1bf438e03a54ab6370ff02d9b2db3eb42da305ac4d1103903e7e0dd02",
  },
  {
    version: 16,
    hash: "337d23b55fb3b29d58441482c33ecbca61efbf769378245a490a6953cdedca0e",
  },
  {
    version: 17,
    hash: "46b088b8fb7661544f82b011dedc93be8e713cb32e6728544f9fdb37261debcd",
  },
  {
    version: 18,
    hash: "f45b5c17da66f4d37331983f24c93f70555fdf14af1afd6e873730836d7863e6",
  },
  {
    version: 19,
    hash: "b6a04c88092c41124dc8a9ef342cfe323dcd83b0b8b5439fccc68f639924aa7f",
  },
  {
    version: 20,
    hash: "949d60c2968f9ed4e04fe3f0be4f7b7ab83bcd386d2792b5b0b9d88370ca4a26",
  },
  {
    version: 21,
    hash: "a2a950efe88364293b4c95b344de4f6149f26b6f3301e5763206bf4a0bc80287",
  },
  {
    version: 22,
    hash: "25a18c288c0fd773c0adf381c47dfac6dd2483fc9a7308428117f0330c215556",
  },
  {
    version: 23,
    hash: "d2812ecb78d43b7650b53c29d95a1b6fdf369232999b4fe249913b6adbdd05fc",
  },
  {
    version: 24,
    hash: "8557c995cd423c173015f0b95dfad29413066c34f0c38b8cb510a3fcd10d6446",
  },
  {
    version: 25,
    hash: "5d333800fd6f9083b642ffa87640ea36a660e12ba8b7b51355433783259e89c7",
  },
  {
    version: 26,
    hash: "5785173f61b80bfd5913ca667a54d6ea06d3d6703107588915cf75478415729e",
  },
  {
    version: 27,
    hash: "a89878c709009e5aa2af37c1ffb39c268e9451c4806300787e103afd4461ae8b",
  },
];

test("Kello retains the original framework migration hashes", () => {
  expect(
    frameworkMigrations("loom_history_compat")
      .slice(0, originalPrefix.length)
      .map(({ version, hash }) => ({ version, hash })),
  ).toEqual(originalPrefix);
});
