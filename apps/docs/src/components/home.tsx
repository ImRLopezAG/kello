import { navigate } from "astro:transitions/client";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { RootProvider } from "fumadocs-ui/provider/astro";
import type { ReactNode } from "react";
import { Brand } from "./brand";
import { DocumentationSearch } from "./search";

export function Home({ pathname, children }: { pathname: string; children: ReactNode }) {
  return (
    <RootProvider
      pathname={pathname}
      navigate={navigate}
      theme={{ defaultTheme: "system", enableSystem: true }}
      search={{ SearchDialog: DocumentationSearch }}
    >
      <HomeLayout
        nav={{ title: <Brand />, url: "/" }}
        links={[
          { text: "Documentation", url: "/overview" },
          { text: "Examples", url: "https://github.com/ImRLopezAG/kello/tree/main/packages/examples", external: true },
        ]}
        githubUrl="https://github.com/ImRLopezAG/kello"
        themeSwitch={{ enabled: true }}
      >
        {children}
      </HomeLayout>
    </RootProvider>
  );
}
