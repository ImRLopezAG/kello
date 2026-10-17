"use client";
import { createKelloNeonReact } from "kello/react/neon";
import { createClient } from "../../kello/_generated/react";
export const serviceUrl =
  typeof window === "undefined" ? import.meta.env.VITE_LOOM_SERVICE_URL! : window.location.origin;
export const { KelloProvider, useKello, auth } = createKelloNeonReact(createClient, { proxy: true });
export type Notes = Awaited<ReturnType<ReturnType<typeof createClient>["client"]["examples"]["notes"]>>;
