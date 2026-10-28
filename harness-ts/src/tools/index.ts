/**
 * Harness-authored tools.
 *
 * Thin, self-contained tools that fill gaps in the SDK's vended set. The `read`, `write`, and `edit`
 * filesystem tools are re-exported from `@strands-agents/sdk/vended-tools` so consumers can import
 * them either from the SDK directly or from this sub-package.
 */

export { edit, makeEdit } from '@strands-agents/sdk/vended-tools/edit'
export type { MakeEditOptions } from '@strands-agents/sdk/vended-tools/edit'
export { makeRead, read } from '@strands-agents/sdk/vended-tools/read'
export type { MakeReadOptions } from '@strands-agents/sdk/vended-tools/read'
export { makeWrite, write } from '@strands-agents/sdk/vended-tools/write'
export type { MakeWriteOptions } from '@strands-agents/sdk/vended-tools/write'
export {
  DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
  makeProgrammaticToolCaller,
  programmaticToolCaller,
} from './programmatic-tool-caller.js'
export type { MakeProgrammaticToolCallerOptions } from './programmatic-tool-caller.js'
export { makeWebFetch } from './web-fetch.js'
export type { MakeWebFetchOptions } from './web-fetch.js'
export { exaWebSearch, makeExaWebSearch } from './web-search.js'
export { AgentSpec, Choice, Fixed, Inherit, makeSubagent, Open, Option, Preset } from './subagent.js'
export type {
  AgentBuilder,
  ContextAxis,
  ContextMode,
  InstructionsMode,
  MakeSubagentOptions,
  ModelMode,
  PresetOptions,
  ToolsMode,
} from './subagent.js'
