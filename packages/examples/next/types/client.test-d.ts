import { createClient, createServerClient } from "../kello/_generated/api";
import { useKello } from "../lib/kello";
const options = { url: "https://example.test", getToken: async () => "token" };
const browser = createClient(options);
const server = createServerClient(options);
const rpc = browser.rpc;
export function useTypedKello() {
  const { rpc } = useKello();
  // @ts-expect-error Provider preserves the generated contract input.
  rpc.examples.add.mutationOptions({ onSuccess: (data: number) => data });
  return rpc.examples.greeting.queryOptions({ input: { name: "Alice" }, select: (data) => data.message });
}
export const query = rpc.examples.greeting.queryOptions({
  input: { name: "Alice" },
  enabled: false,
  select: (data) => data.message,
});
export const mutation = rpc.examples.add.mutationOptions();
// @ts-expect-error The local contract requires a string.
rpc.examples.greeting.queryOptions({ input: { name: 1 } });
// @ts-expect-error Output types remain inferred.
rpc.examples.notes.queryOptions({ select: (notes) => notes[0]?.text.toFixed() });
// @ts-expect-error Server mutation input is also inferred.
void server.client.examples.add({ text: 42 });

export function useTypedLive() {
  const { api } = useKello();
  const rows: readonly { _id: string; text: string }[] | undefined = api.examples.watch.useLiveQuery().data;
  // @ts-expect-error A live capability must not enter the ordinary query cache.
  rpc.examples.watch.queryOptions();
  return rows;
}
