import { createKelloNeonStart } from "kello/start/server";
import { createServerClient } from "../kello/_generated/api";
const server = createKelloNeonStart(createServerClient);
export const withSession = server.withSession;
export const authHandler = server.handler;
export const rpcHandler = server.rpc;
