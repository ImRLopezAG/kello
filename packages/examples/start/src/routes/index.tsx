import { createFileRoute } from "@tanstack/react-router";
import { NotesPanel } from "../components/notes";

export const Route = createFileRoute("/")({ component: Page });

function Page() {
  return (
    <main>
      <h1>Kello + TanStack Start</h1>
      <NotesPanel />
    </main>
  );
}
