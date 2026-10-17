import { createFileRoute } from "@tanstack/react-router";
import { rpcHandler } from "../auth";
export const Route = createFileRoute("/api/kello/$")({
  server: { handlers: { POST: ({ request }) => rpcHandler(request) } },
});
