"use client";

import { createElement, useMemo, useSyncExternalStore } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createAuthClient } from "@neondatabase/auth";
import { createAuthClient as createProxyAuthClient } from "@neondatabase/auth/next";
import type { ReactBetterAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";
import { createKelloReact } from "./provider";
import type { SessionClientOptions, SessionConnection } from "../client/auth-lifecycle";
import type { KelloAuth } from "../client/cookie-session";
import { neonClientToken } from "../client/neon-token";

/** React bindings sharing one native Neon Auth client. The provider connects authenticated Kello state; auth exposes the SDK's sign-in and sign-out methods. */
export interface KelloNeonReact<T extends SessionConnection> {
  readonly auth: ReactBetterAuthClient;
  readonly KelloProvider: (
    props: Omit<ComponentProps<ReturnType<typeof createKelloReact<T>>["KelloProvider"]>, "auth"> & {
      readonly ssrFallback?: ReactNode;
      readonly loadingFallback?: ReactNode;
    },
  ) => ReactNode;
  readonly useKello: () => T;
  readonly useAuth: ReactBetterAuthClient["useSession"];
}

/** Neon owns cookies, refresh, cross-tab state, and all sign-in methods. */
export function createKelloNeonReact<T extends SessionConnection>(
  createClient: (options: SessionClientOptions) => T,
  options:
    | { readonly serviceUrl: string }
    | { readonly authUrl: string }
    | { readonly auth: ReactBetterAuthClient }
    | { readonly proxy: true },
): KelloNeonReact<T> {
  function resolveAuth() {
    if ("auth" in options) return options.auth;
    if ("proxy" in options) return createProxyAuthClient();
    const url = new URL("serviceUrl" in options ? options.serviceUrl : options.authUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Neon Auth requires an HTTPS service URL");
    if ("serviceUrl" in options) url.pathname = `${url.pathname.replace(/\/$/, "")}/api/auth`;
    return createAuthClient(url.href, {
      adapter: BetterAuthReactAdapter({ fetchOptions: { credentials: "include" } }),
    });
  }
  const auth = resolveAuth();
  const bindings = createKelloReact(createClient);
  type ProviderProps = Omit<ComponentProps<typeof bindings.KelloProvider>, "auth"> & {
    readonly ssrFallback?: ReactNode;
    readonly loadingFallback?: ReactNode;
  };
  function KelloProvider(props: ProviderProps) {
    const renderingServer = useSyncExternalStore(subscribeToRendering, clientSnapshot, serverSnapshot);
    const session = auth.useSession();
    const subject = session.data?.user.id;
    const sessionId = session.data?.session.id;
    const loading = session.isPending;
    const adapter = useMemo<KelloAuth>(
      () => ({
        async getToken() {
          if (loading || !subject || !sessionId) return null;
          return neonClientToken(
            auth,
            subject,
            sessionId,
            "serviceUrl" in options
              ? { url: `${options.serviceUrl.replace(/\/$/, "")}/api/auth/token`, credentials: "include" }
              : "proxy" in options
                ? { url: "/api/auth/token", credentials: "same-origin" }
                : false,
          );
        },
      }),
      [subject, sessionId, loading],
    );
    if (loading) return renderingServer ? props.ssrFallback : props.loadingFallback;
    if (!subject) return props.fallback;
    return createElement(bindings.KelloProvider, { ...props, fallback: props.loadingFallback, auth: adapter });
  }
  return Object.freeze({ auth, KelloProvider, useKello: bindings.useKello, useAuth: auth.useSession });
}

const subscribeToRendering = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;
