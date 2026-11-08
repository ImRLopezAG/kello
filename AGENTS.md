# Orchestration

<!-- Orchestration -->

Use T3 Code to orchestrate the agents the new orchestrator V2 allows you to orchestrate multiple models for working together and the multiple providers of codex and claude, I have some recommendations for model selection and orchestration:

## Models

| Provider | Heavy       | Medium      | Light                  |
| -------- | ----------- | ----------- | ---------------------- |
| OpenAI   | gpt-6-astra | gpt-6.1-sol | gpt-6-luna             |
| Claude   | fable-5.1   | opus-5.5    | sonnet-5.5 / haiku-5.5 |

`Haiku` and `Luna` are very special models for short tasks such as research file reader and those tasks that wont consume more than 100K tokens.

`Opus`, `Fable` and sonnet are very good models for medium UI stuff cause they are good at understanding the context and design of the UI and the code.

## Workflow

I have a workflow for implementing features and working which contains some skills within the process they don't fallow an order but depending how deep we are on context we use it but those skills are:

- **ce-explain**: This I used it to verify if the AI is aligned with the user's intent, then got a back and forth conversation with the user to explain the feature and the context of the feature including research on the libraries internet and packages.
- **ce-plan**: This I used it to plan the feature implementation.
- **ce-work**: This I used it to work on the feature implementation.

These are goated skills that are used to implement features and work on them, but the real workflow for implementation itself is:

| Planners    | workers     | low workers | researcher             | reviewers   |
| ----------- | ----------- | ----------- | ---------------------- | ----------- |
| gpt-6-astra | gpt-6.1-sol | gpt-6-luna  | gpt-6-luna             | gpt-6-astra |
| fable-5.1   | opus-5.5    | sonnet-5.5  | sonnet-5.5 / haiku-5.5 | N/A         |

Invoke **reviewers** for code review, implementation review, and security review on changed code. Use **gpt-6-astra** at **Low** effort for that role.

After the planning and research session I sent the `ce-work` message to the main thread with the fallowing context:
"Work on this feature into a goal with multiple agents and make sure you test every phase. And you do a code review and an implementation review as well. Make sure every phase is tested before go to the other one And commit it as well. Make a security review to make sure everything is working correctly. Use a browser or any test you need to make sure you cover the needed and everything is working correctly."

with the fallowing effort:

| Model       | Recommended Effort                |
| ----------- | --------------------------------- |
| gpt-6-astra | Medium / Low worker; Low reviewer |
| fable-5.1   | low                               |
| opus-5.5    | low                               |
| gpt-6-luna  | low(fast)                         |
| gpt-6.1-sol | medium(fast)                      |
| sonnet-5.5  | medium                            |

<!-- Orchestration -->
<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
