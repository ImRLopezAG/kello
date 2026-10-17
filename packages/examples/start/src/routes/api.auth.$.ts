import { createFileRoute } from "@tanstack/react-router";
import { authHandler } from "../auth";
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => authHandler(request),
      POST: ({ request }) => authHandler(request),
      PUT: ({ request }) => authHandler(request),
      PATCH: ({ request }) => authHandler(request),
      DELETE: ({ request }) => authHandler(request),
    },
  },
});
