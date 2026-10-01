/**
 * Starter validator pack, adapted in spirit from awesome-reviewers (Apache-2.0). Each entry
 * is a standalone markdown file (YAML frontmatter + body) in the same format users and repos
 * author validators in.
 */
export interface StarterValidator {
  name: string;
  markdown: string;
}

function v(
  name: string,
  title: string,
  severity: "blocking" | "warning" | "info",
  unit: "hunk" | "file" | "pr",
  violation: string,
  compliant: string,
  notApplicable: string,
  body: string,
  threshold = 0.8,
): StarterValidator {
  const markdown = `---
title: ${title}
severity: ${severity}
unit: ${unit}
threshold: ${threshold}
violation: ${violation}
compliant: ${compliant}
not_applicable: ${notApplicable}
---
${body}
`;
  return { name, markdown };
}

export const STARTER_VALIDATORS: StarterValidator[] = [
  v(
    "authorization-enforced",
    "Authorization is enforced on endpoints",
    "blocking",
    "hunk",
    "A new or changed endpoint/handler performs reads or writes without an authorization check",
    "The endpoint checks the caller's permission before acting, or delegates to middleware that does",
    "The change does not add or modify a request handler",
    "Does this change let a caller act on data without an authorization check?",
  ),
  v(
    "input-validation-at-boundaries",
    "Input is validated at trust boundaries",
    "warning",
    "hunk",
    "Data crossing a trust boundary (request body, query params, env vars, file/CLI input) is used without validating its shape or range",
    "Input is validated or parsed with a schema before use, or the boundary is internal and already trusted",
    "The change does not read data from outside the current trust boundary",
    "Does this change accept external input without validating it before use?",
  ),
  v(
    "no-secrets-committed",
    "Secrets and credentials are not committed or logged",
    "blocking",
    "hunk",
    "A secret, API key, password or token is hardcoded, committed, or written to logs/error messages",
    "Secrets are loaded from environment/config/secret storage and never logged",
    "The change contains no credentials, tokens, or secret-handling code",
    "Does this change commit a secret or credential, or log one?",
  ),
  v(
    "sql-command-injection",
    "No SQL or command injection",
    "blocking",
    "hunk",
    "A SQL query or shell command is built by concatenating or interpolating untrusted input instead of using parameters/escaping",
    "Queries use parameterized statements/ORM APIs and shell commands pass arguments without a shell",
    "The change contains no SQL queries or shell command execution",
    "Does this change build a SQL query or shell command from unsanitized input?",
  ),
  v(
    "error-handling-not-swallowed",
    "Error handling doesn't swallow failures",
    "warning",
    "hunk",
    "An error is caught and silently ignored, discarded, or only logged where the caller needed to know it failed",
    "Errors are propagated, retried, or handled in a way that preserves correctness and visibility",
    "The change contains no error handling",
    "Does this change catch an error and swallow it instead of handling or propagating it?",
  ),
  v(
    "enum-naming-consistent",
    "Enum members are capitalized consistently",
    "info",
    "hunk",
    "New or changed enum/constant members don't follow the repo's existing capitalization convention (e.g. UPPER_CASE)",
    "New enum/constant members match the existing convention used nearby in the file or repo",
    "The change adds no new enum members or constants",
    "Are the enum or constant members in this change capitalized inconsistently with the surrounding code?",
    0.75,
  ),
  v(
    "code-in-right-layer",
    "Code is placed in the right layer or module",
    "warning",
    "hunk",
    "New logic is added to a layer that shouldn't own it (e.g. business logic in a view/controller, I/O in a pure utility)",
    "The code lives in the layer or module that already owns this kind of responsibility",
    "The change is not adding new logic to an existing layered architecture",
    "Is this change placing logic in the wrong architectural layer or module for this codebase?",
    0.75,
  ),
  v(
    "no-debug-leftovers",
    "No debug leftovers",
    "warning",
    "hunk",
    "The change leaves behind debug output, a debugger breakpoint, or a hacky TODO/FIXME meant to be temporary",
    "The change contains no stray console.log/print/debugger statements or leftover debug hacks",
    "The change touches no code that could contain debug statements",
    "Does this change leave in console.log/print/debugger statements or temporary debug hacks?",
  ),
  v(
    "tests-added-for-new-behavior",
    "Tests are added for new behavior",
    "warning",
    "pr",
    "The pull request adds or changes behavior (new logic, bug fix, new endpoint) without adding or updating any tests",
    "The pull request adds or updates tests that cover the new or changed behavior",
    "The pull request contains no behavior changes (docs, formatting, chore, pure refactor with no logic change)",
    "Does this pull request change behavior (see `files_with_stats`, `title`, `body`) without adding or updating tests for it?",
    0.7,
  ),
  v(
    "migrations-backward-compatible",
    "Migrations are backward compatible",
    "blocking",
    "hunk",
    "A database migration drops a column/table or renames something still read by code that must run during a rolling deploy",
    "The migration is additive, or the destructive step is deferred to a later release after code no longer depends on it",
    "The change contains no database migration",
    "Does this migration break backward compatibility with code that may still be running during deploy?",
  ),
  v(
    "public-api-breaking-changes-flagged",
    "Public API breaking changes are flagged",
    "blocking",
    "hunk",
    "A public function signature, exported type, REST/GraphQL field, or CLI flag changes or is removed in a way that breaks existing callers, without being called out",
    "The change is additive/backward compatible, or a breaking change is clearly documented as such",
    "The change touches no public API, exported interface, or external contract",
    "Does this change break a public API or external contract without flagging it as a breaking change?",
  ),
  v(
    "async-errors-handled",
    "Async errors are awaited and handled",
    "warning",
    "hunk",
    "A promise or async call is fired without being awaited, returned, or given a .catch, so a rejection would be silently lost",
    "Promises are awaited (or returned) and rejections are handled",
    "The change contains no asynchronous calls",
    "Does this change fire an async call without awaiting it or handling its rejection?",
  ),
  v(
    "no-n-plus-one-queries",
    "No N+1 queries in loops",
    "warning",
    "hunk",
    "A database or network call is made inside a loop, once per item, where batching or a join would avoid N+1 round trips",
    "Data is fetched in bulk before or instead of looping, or the loop is over an already-small, bounded set",
    "The change contains no loop that performs a database or network call",
    "Does this change perform a database or network call inside a loop, once per item?",
    0.75,
  ),
];
