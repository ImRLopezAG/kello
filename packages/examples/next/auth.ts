import { createKelloNeonNext } from "kello/next/server";
import { createServerClient } from "./kello/_generated/api";
const server = createKelloNeonNext(createServerClient);
export const withSession = server.withSession;
export const authHandlers = server.handler();
export const rpcHandler = server.rpc;
