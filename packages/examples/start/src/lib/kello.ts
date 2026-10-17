"use client";
import { createKelloNeonReact } from "kello/react/neon";
import { createClient } from "../../kello/_generated/react";
export const serviceUrl = import.meta.env.VITE_KELLO_SERVICE_URL!;
export const { KelloProvider, useKello, auth } = createKelloNeonReact(createClient, { serviceUrl });
export type Notes = Awaited<ReturnType<ReturnType<typeof createClient>["client"]["examples"]["notes"]>>;
