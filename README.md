<p><img src="brand/mendr-lockup.png" alt="mendr" height="44"></p>

# mendr

**An early project to find and fix what breaks in AI agents when the tools they call change.**

An MCP server is how a product offers itself to AI agents: it publishes a list of named tools, and agents call them by name. An agent that reads the list fresh adapts on its own. A tool name written into a skill file, a prompt or a config does not. When a server removes or renames a tool, those files go stale, and their owners find out when calls are rejected.

The aim is integrations that maintain themselves: mendr is meant to watch those changes, find what they break in your code and your agent instructions, and prepare the fix as a pull request for you to approve.

> **Status: early.** The tool this page describes cannot be installed yet, and none of its code is in this repository. All the code here today is an earlier tool, a CLI and GitHub App that find AI model ids a provider is retiring. It still works: see [MODEL-RETIREMENT.md](MODEL-RETIREMENT.md).

## one case, measured

On November 3, 2026, Sentry replaced two gateway tools on its hosted MCP server, one to search its tools and one to run them, with a direct list of every tool, because agent clients now do that search themselves ([getsentry/toolkit#1868](https://github.com/getsentry/toolkit/pull/1868)). Sentry describes the rollout as temporary. The two old names, `search_sentry_tools` and `execute_sentry_tool`, stopped working.

The next day a Sentry pull request counted what followed ([#1952](https://github.com/getsentry/toolkit/pull/1952)): in 21 hours, clients called the two removed names 8,900 times, and every call was rejected. That counts calls, not clients. Until that pull request, Sentry's own monitoring had recorded the rejected calls as successful. Since then, the rejection tells the caller to call the tools directly.

One possible source of such calls is files that still name the old tools. Another is clients that connected before the change and still hold the old list. A GitHub code search for `execute_sentry_tool` on November 10 found it in about 160 public repositories not owned by Sentry. That is from the first 500 results, and code-search totals shift between runs. In roughly 60 to 70 of them, an agent skill or instruction file names it for the agent to use. A mention in a file is not a call, so this does not say how many of those agents ran.

Sentry did nothing wrong here: these are its tools to change.

## how often tool lists change

Of 28 official MCP server repositories I checked, three keep their whole tool list as one file. The table covers those three. It compares the last version of each day with the last version of the day before, up to the end of November 11, 2026 (UTC).

| Server | Period | Days the tool list changed | Days with a breaking change |
|---|---|---|---|
| Firecrawl | 36 days | 17 | 4 |
| Sentry | 106 days | 33 | 2 |
| Neon | 74 days | 16 | 1 |

- **Files:** `tests/contract-snapshots/tool-definitions.json` in firecrawl/firecrawl-mcp-server, `packages/mcp-core/src/toolDefinitions.json` in getsentry/toolkit, and `mcp/__tests__/__snapshots__/hosted-tools-list.json` in neondatabase/mcp-server-neon.
- **Periods:** Firecrawl's and Neon's are the whole life of the file. Sentry's is its latest 100 commits.
- **Not releases:** a commit is not a release, so some of these changes may never have reached a running server.
- **Breaking:** three kinds of change are counted: a tool removed, a new required parameter, or a parameter removed where the server rejects unknown parameters. The table counts changes to the list. It does not count agents that failed.

## what mendr is meant to do

1. **Watch.** Record each version of the tool lists your agents depend on.
2. **Detect.** When one changes, say which changes break existing calls, and find the files that still use the old names: code, configuration, agent skills and instructions.
3. **Fix.** Prepare the change and run your project's own tests on it.
4. **Approve.** Open a pull request. Nothing merges without a person.

Tool lists are where it starts. The same problem exists for any API that an agent or a program calls.

## what exists today

- A comparison of two versions of a tool list that marks each change as breaking or not, by the rule above. It produced the table.
- A one-off search of public GitHub code for projects whose agent instructions still name a removed tool. It produced the two repository counts above. It is not a tool yet.
- Three fixes so far, each prepared with an AI coding assistant, checked against the server's current tool list, and sent as a small pull request. None is merged yet.

Not built yet: the automatic watching, the testing of a fix in a sandbox, and anything you can install.

## if your agents call someone else's tools

I'm Ajith, and I'm building mendr alone. [Open an issue](https://github.com/ajitheee/mendr/issues/new) naming the MCP servers your agents call. Issues are public, so name nothing private. Where a server keeps its tool-list history in public, I'll compare versions and reply in the issue with what changed.

If you work on a server named above and a number here is wrong, say so in an issue and I'll correct it.

## the earlier tool

All the code in this repository today is mendr's first tool: a CLI and GitHub App that find AI model ids with a provider shutdown date and prepare the swap. Its `watch` command watches model ids, not tool lists. Its documentation is in [MODEL-RETIREMENT.md](MODEL-RETIREMENT.md), and [TRUST.md](TRUST.md) describes what it stores.

## license

MIT
