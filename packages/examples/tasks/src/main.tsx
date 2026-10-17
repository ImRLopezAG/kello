import { SignIn } from "./sign-in";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createKelloNeonReact } from "kello/react/neon";
import { useMutation } from "@tanstack/react-query";
import * as v from "valibot";
import type { Id } from "kello/server";
import { configuration } from "../kello/_generated/api";
import { createClient } from "../kello/_generated/react";
import "./style.css";

const serviceUrl = import.meta.env.VITE_LOOM_URL ?? configuration.serviceUrl;
const kello = serviceUrl ? createKelloNeonReact(createClient, { serviceUrl }) : undefined;

function AddForm({
  label,
  button,
  submit,
}: {
  label: string;
  button: string;
  submit: (value: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const value = new FormData(form).get("title");
        if (!v.is(v.string(), value) || !value.trim() || pending) return;
        setPending(true);
        setError("");
        try {
          await submit(value);
          form.reset();
        } catch {
          setError("Could not save. Check your connection and try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label>
        {label}
        <input
          name="title"
          maxLength={200}
          required
          placeholder={label === "Task title" ? "What needs to get done?" : "Name your project"}
        />
      </label>
      <button disabled={pending} type="submit">
        {pending ? "Saving…" : button}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

type Api = ReturnType<typeof createClient>["rpc"];
type Live = ReturnType<typeof createClient>["api"];

function Tasks({ projectId, name, api, live }: { projectId: Id<"projects">; name: string; api: Api; live: Live }) {
  const tasks = live.tasks.list.useLiveQuery({ projectId });
  const add = useMutation(api.tasks.create.mutationOptions());
  const setDone = useMutation(api.tasks.setDone.mutationOptions());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <section className="tasks" aria-label="Project tasks">
      <header>
        <h2>{name}</h2>
        <p>Keep the next step in sight.</p>
      </header>
      <AddForm
        label="Task title"
        button="Add task"
        submit={async (title) => {
          await add.mutateAsync({ projectId, title });
        }}
      />
      {error && <p role="alert">{error}</p>}
      {tasks.data !== undefined ? (
        <>
          <p className="count">
            {tasks.data.filter((task) => task.done).length} of {tasks.data.length} completed
          </p>
          {tasks.data.length === 0 && <p className="empty">Add a task to start this project.</p>}
          <ul className="task-list">
            {tasks.data.map((task) => (
              <li key={task._id}>
                <label className={task.done ? "done" : ""}>
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={pending}
                    onChange={async (event) => {
                      const done = event.currentTarget.checked;
                      setPending(true);
                      setError("");
                      try {
                        await setDone.mutateAsync({ id: task._id, done });
                      } catch {
                        setError("Could not update this task. Try again.");
                      } finally {
                        setPending(false);
                      }
                    }}
                  />
                  <span>{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status">
          {tasks.status === "error" ? "Cannot load tasks. Sign in again to retry." : "Connecting to your tasks…"}
        </p>
      )}
    </section>
  );
}

function Workspace({ name, signOut, api, live }: { name: string; signOut: () => void; api: Api; live: Live }) {
  const projects = live.projects.list.useLiveQuery({});
  const create = useMutation(api.projects.create.mutationOptions());
  const [selected, setSelected] = useState<Id<"projects"> | null>(null);
  const active =
    projects.data !== undefined
      ? (projects.data.find((project) => project._id === selected) ?? projects.data[0])
      : undefined;
  return (
    <>
      <header className="topbar">
        <a href="/" aria-label="Kello tasks home">
          <span className="mark" aria-hidden="true">
            L
          </span>{" "}
          Kello tasks
        </a>
        <div>
          <span>{name}'s workspace</span>
          <button onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="workspace">
        <aside aria-label="Projects">
          <h1>Projects</h1>
          {projects.data !== undefined ? (
            <nav aria-label="Project selection">
              {projects.data.map((project) => (
                <button
                  key={project._id}
                  aria-current={active?._id === project._id ? "page" : undefined}
                  onClick={() => setSelected(project._id)}
                >
                  {project.name}
                </button>
              ))}
            </nav>
          ) : (
            <p role="status">
              {projects.status === "error" ? "Cannot load projects. Sign in again to retry." : "Connecting…"}
            </p>
          )}
          <AddForm
            label="Project name"
            button="Create project"
            submit={async (title) => {
              const project = await create.mutateAsync({ name: title });
              setSelected(project._id);
            }}
          />
        </aside>
        {active ? (
          <Tasks api={api} live={live} key={active._id} projectId={active._id} name={active.name} />
        ) : (
          <section className="welcome">
            {projects.data !== undefined && (
              <>
                <h2>Create your first project</h2>
                <p>A place for the work you want to finish. Name a project, then add its next steps.</p>
              </>
            )}
          </section>
        )}
      </main>
    </>
  );
}

function ConnectedWorkspace({ bindings }: { bindings: NonNullable<typeof kello> }) {
  const { rpc, api } = bindings.useKello();
  const session = bindings.useAuth();
  const [error, setError] = useState("");
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <Workspace
        api={rpc}
        live={api}
        name={session.data?.user.name ?? "Your workspace"}
        signOut={async () => {
          setError("");
          const result = await bindings.auth.signOut();
          if (result.error) setError("Could not sign out. Try again.");
        }}
      />
    </>
  );
}
function App() {
  if (!kello || !serviceUrl)
    return (
      <main className="sign-in">
        <h1>Connect your Neon application</h1>
        <p>Run kello link and deploy, then provide VITE_LOOM_URL.</p>
      </main>
    );
  return (
    <kello.KelloProvider url={serviceUrl} fallback={<SignIn auth={kello.auth} />}>
      <ConnectedWorkspace bindings={kello} />
    </kello.KelloProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
