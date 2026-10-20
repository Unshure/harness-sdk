import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { Sandbox } from '../../sandbox/base.js'
import { SandboxPathNotFoundError } from '../../sandbox/errors.js'
import type { StateStore } from '../../state-store.js'
import * as path from 'path'
import { Buffer } from 'buffer'

const MB = 1024 * 1024
const SNIPPET_LINES = 4
const DEFAULT_MAX_FILE_SIZE = 1 * MB
const MAX_DIRECTORY_DEPTH = 2
const MAX_FIND_LINE_HITS = 200
const MAX_REPORTED_MATCH_LINES = 10
const DEFAULT_MAX_UNDO_ENTRIES = 16
const DEFAULT_MAX_UNDO_BYTES = 8 * MB
const MAX_REPLACE_ALL_SNIPPETS = 5

// Platform-aware separator regexes: on POSIX, `\` is a legitimate filename
// character and must not be treated as a separator; on Windows both `\` and
// `/` are accepted.
const PATH_SEP_SPLIT_RE = process.platform === 'win32' ? /[\\/]/ : /\//
const TRAIL_SEP_RE = process.platform === 'win32' ? /[\\/]+$/ : /\/+$/

const fileEditorInputSchema = z.object({
  command: z
    .enum(['view', 'create', 'str_replace', 'insert', 'find_line', 'undo_edit'])
    .describe(
      'The operation to perform: `view`, `create`, `str_replace`, `insert`, `find_line`, or `undo_edit`. ' +
        '`undo_edit` restores `path` to the content captured just before the most recent `str_replace` or ' +
        '`insert` on that path in this session — a single-step revert, not a stack, and it does not track ' +
        '`create` or changes made by other tools.'
    ),
  path: z.string().describe('Absolute path to the file or directory.'),
  file_text: z.string().optional().describe('Content for new file (required for create command).'),
  view_range: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Line range to view [start, end]. 1-indexed. End can be -1 for end of file.'),
  old_str: z
    .string()
    .optional()
    .describe(
      'Exact string to find and replace (required for str_replace). Must be unique unless replace_all is true.'
    ),
  new_str: z.string().optional().describe('Replacement string (for str_replace and insert commands).'),
  insert_line: z
    .number()
    .optional()
    .describe('Line number where text should be inserted (0-indexed, required for insert command).'),
  search_text: z.string().optional().describe('Text to search for (required for find_line command).'),
  fuzzy: z.boolean().optional().describe('Enable whitespace-tolerant, case-insensitive matching for find_line.'),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      'For str_replace, allow replacing every occurrence. Defaults to false; a match count > 1 is rejected without this flag to prevent silent broad edits.'
    ),
})

/**
 * File editor tool for viewing, creating, and editing files programmatically.
 *
 * Provides commands for viewing files/directories, creating files, string
 * replacement, line insertion, search, and single-step undo. All I/O routes
 * through the agent's configured sandbox.
 *
 * @example
 * ```typescript
 * import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
 * import { Agent } from '@strands-agents/sdk'
 *
 * const agent = new Agent({
 *   model: new BedrockModel({ region: 'us-east-1' }),
 *   tools: [fileEditor],
 * })
 *
 * await agent.invoke('View the file /tmp/test.txt')
 * await agent.invoke('Create a file /tmp/notes.txt with content "Hello World"')
 * await agent.invoke('Replace "Hello" with "Hi" in /tmp/notes.txt')
 * ```
 */
export const DEFAULT_FILE_EDITOR_DESCRIPTION =
  'Filesystem editor for viewing, creating, and editing files. Supports view (with line ranges), create, str_replace (exact match; ambiguous matches must opt in via replace_all), insert, find_line, and undo_edit. Files must use absolute paths.'

export const DEFAULT_UNDO_STATE_KEY = 'file_editor.undo_history'

/**
 * Single undo snapshot: file content plus its cached UTF-8 byte length.
 *
 * Pairing content with its byte length in one struct keeps size bookkeeping
 * O(1) and prevents the two values from drifting out of sync across edits.
 */
interface UndoEntry {
  content: string
  size: number
}

export interface MakeFileEditorOptions {
  name?: string
  description?: string
  /**
   * Optional absolute directory that confines every operation. Paths are
   * normalized and must sit inside `root`. Confinement is *lexical*: the
   * editor does not follow symlinks itself. Filesystem semantics are
   * governed by the sandbox. The editor verifies `root` exists in the
   * sandbox on every call.
   */
  root?: string
  /**
   * Maximum file size (bytes) accepted by view/edit commands. Defaults to
   * 1 MB. Anything larger is rejected with a clean error rather than being
   * loaded into memory.
   */
  maxFileSize?: number
  /**
   * Maximum number of distinct paths retained in the undo history per calling
   * agent. Oldest entry is evicted on overflow. Set to `0` to disable undo
   * entirely — mutating commands then skip the agent-state write. Defaults
   * to 16.
   */
  maxUndoEntries?: number
  /**
   * Approximate cap on total bytes of file content held in the per-agent undo
   * history (UTF-8). Oldest entries are evicted until the cap is met.
   * Defaults to 8 MB.
   */
  maxUndoBytes?: number
  /**
   * Key under which the undo history is stored in `agent.appState`. Two
   * editors sharing the same key on the same agent will share undo history;
   * use distinct keys to isolate them. Defaults to
   * `'file_editor.undo_history'`.
   */
  undoStateKey?: string
}

/**
 * Create a file editor tool. If a sandbox is passed, it's bound at creation
 * time. Otherwise, the tool reads from `context.agent.sandbox` at call time.
 *
 * Undo history is stored in `context.agent.appState` under `undoStateKey`
 * (default `'file_editor.undo_history'`), so two agents sharing one editor
 * factory cannot see or overwrite each other's snapshots and any configured
 * session manager can persist it across restarts.
 */
export function makeFileEditor(options?: MakeFileEditorOptions): ReturnType<typeof tool>
export function makeFileEditor(sandbox: Sandbox | undefined, options?: MakeFileEditorOptions): ReturnType<typeof tool>
export function makeFileEditor(
  sandboxOrOptions?: Sandbox | MakeFileEditorOptions,
  maybeOptions?: MakeFileEditorOptions
): ReturnType<typeof tool> {
  const boundSandbox = sandboxOrOptions instanceof Sandbox ? sandboxOrOptions : undefined
  const options = sandboxOrOptions instanceof Sandbox || maybeOptions ? (maybeOptions ?? {}) : (sandboxOrOptions ?? {})
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const maxUndoEntries = options.maxUndoEntries ?? DEFAULT_MAX_UNDO_ENTRIES
  const maxUndoBytes = options.maxUndoBytes ?? DEFAULT_MAX_UNDO_BYTES
  const undoStateKey = options.undoStateKey ?? DEFAULT_UNDO_STATE_KEY

  if (options.root !== undefined && !path.isAbsolute(options.root)) {
    throw new Error(`root must be an absolute path, got: ${options.root}`)
  }
  // Platform-native normalization so a Windows-style `root` (e.g.
  // `C:\Users\...\workspace`) survives round-tripping.
  const normalizedRoot: string | undefined =
    options.root === undefined ? undefined : stripTrailingSep(path.normalize(options.root))

  const description =
    options.description === undefined || options.description === DEFAULT_FILE_EDITOR_DESCRIPTION
      ? normalizedRoot !== undefined
        ? `${DEFAULT_FILE_EDITOR_DESCRIPTION} All paths must be absolute and inside ${normalizedRoot}.`
        : DEFAULT_FILE_EDITOR_DESCRIPTION
      : options.description

  return tool({
    name: options.name ?? 'fileEditor',
    description,
    inputSchema: fileEditorInputSchema,
    callback: async (input, context) => {
      if (!context) throw new Error('Tool context is required for fileEditor operations')
      const sandbox = boundSandbox ?? context.agent.sandbox
      await verifyRoot(sandbox, normalizedRoot)
      const filePath = resolvePath(input.path, normalizedRoot)

      if (input.command === 'view') {
        return await handleView(sandbox, filePath, input.view_range, maxFileSize)
      }
      if (input.command === 'find_line') {
        return await handleFindLine(sandbox, filePath, input.search_text!, input.fuzzy === true, maxFileSize)
      }

      const appState = context.agent.appState

      if (input.command === 'create') {
        const result = await handleCreate(sandbox, filePath, input.file_text!, maxFileSize)
        commitUndoUpdate(appState, undoStateKey, filePath, undefined, maxUndoEntries, maxUndoBytes)
        return result
      }
      if (input.command === 'str_replace') {
        const { message, preEditContent } = await handleStrReplace(
          sandbox,
          filePath,
          input.old_str!,
          input.new_str,
          input.replace_all === true,
          maxFileSize
        )
        commitUndoUpdate(appState, undoStateKey, filePath, preEditContent, maxUndoEntries, maxUndoBytes)
        return message
      }
      if (input.command === 'insert') {
        const { message, preEditContent } = await handleInsert(
          sandbox,
          filePath,
          input.insert_line!,
          input.new_str!,
          maxFileSize
        )
        commitUndoUpdate(appState, undoStateKey, filePath, preEditContent, maxUndoEntries, maxUndoBytes)
        return message
      }
      if (input.command === 'undo_edit') {
        if (maxUndoEntries <= 0) {
          throw new Error('Undo is disabled for this editor (maxUndoEntries=0).')
        }
        const rawHistory = (appState.get(undoStateKey) as Record<string, unknown> | undefined) ?? {}
        if (!Object.hasOwn(rawHistory, filePath)) {
          throw new Error(`No undo history available for ${filePath} in this session.`)
        }
        const snapshot = undoEntryFromState(rawHistory[filePath])
        if (snapshot === null) {
          throw new Error(`Undo history for ${filePath} is corrupt; refusing to overwrite the file.`)
        }
        await sandbox.writeText(filePath, snapshot.content)
        commitUndoUpdate(appState, undoStateKey, filePath, undefined, maxUndoEntries, maxUndoBytes)
        return `Reverted ${filePath} to its previous in-memory snapshot.`
      }

      throw new Error(`Unknown command: ${(input as { command: string }).command}`)
    },
  })
}

/**
 * Default file editor tool. Reads the sandbox from the agent's context at call time.
 */
export const fileEditor = makeFileEditor()

// ---- Path resolution and confinement ----

/**
 * Verify `normalizedRoot` exists in the sandbox, throwing a clear
 * configuration error if not.
 *
 * Probed on every call rather than memoized: a root that is deleted after an
 * earlier successful probe must still trip the clear configuration error,
 * not surface as a generic "path does not exist" on whatever child the model
 * tries next.
 */
async function verifyRoot(sandbox: Sandbox, normalizedRoot: string | undefined): Promise<void> {
  if (normalizedRoot === undefined) return
  try {
    await sandbox.listFiles(normalizedRoot)
  } catch (error) {
    if (error instanceof SandboxPathNotFoundError) {
      throw new Error(`Invalid configuration: root ${normalizedRoot} does not exist in the sandbox.`, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Normalize a path and enforce lexical confinement.
 *
 * Rejects non-absolute paths and any `..` segment outright, matching the
 * sandbox path model. When `root` is set the normalized path must also sit
 * inside it. Symlink semantics are the sandbox's responsibility.
 *
 * @throws Error on non-absolute paths, `..` segments, or out-of-root resolution.
 */
function resolvePath(filePath: string, root: string | undefined): string {
  // stripTrailingSep preserves a Windows drive root like `C:\` — a naive
  // trailing-separator strip would collapse it to `C:`, which is not absolute.
  const stripped = stripTrailingSep(filePath)

  if (!path.isAbsolute(stripped)) {
    const suggestedPath = path.resolve(stripped)
    throw new Error(
      `The path ${filePath} is not an absolute path, it should start with \`/\` (or a drive letter on Windows). Maybe you meant ${suggestedPath}?`
    )
  }

  // Reject `..` outright so default (no-root) deployments on host-filesystem
  // sandboxes cannot be coerced out of a parent directory. Split on the
  // platform's path separator(s); on POSIX `\` is a filename character and
  // must not be treated as a boundary.
  if (stripped.split(PATH_SEP_SPLIT_RE).includes('..')) {
    throw new Error('Invalid path: path traversal is not allowed')
  }

  // Platform-native normalization so Windows drive-letter paths survive.
  const normalized = stripTrailingSep(path.normalize(stripped))

  if (root !== undefined && !isInsideRoot(normalized, root)) {
    throw new Error(`Invalid path: ${filePath} is outside the configured root ${root}`)
  }

  return normalized
}

function stripTrailingSep(p: string): string {
  // Preserve drive roots (`C:\`, `/`) but drop a trailing separator otherwise.
  // On POSIX `\` is a filename character, so TRAIL_SEP_RE strips `/` only.
  if (p.length <= 1) return p
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]$/.test(p)) return p
  return p.replace(TRAIL_SEP_RE, '') || p
}

function isInsideRoot(target: string, root: string): boolean {
  const normalizedRoot = stripTrailingSep(root)
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  if (t === r) return true
  // Root can already end in a separator when it is the filesystem root (`/`)
  // or a Windows drive root (`C:\`) — stripTrailingSep preserves those. In
  // that case, concatenating another separator would produce `//` or `C:\\`
  // and every valid in-root path would fail startsWith.
  const rEndsWithSep = r.endsWith('/') || r.endsWith('\\')
  if (rEndsWithSep) return t.startsWith(r)
  // Otherwise, match either separator so a Windows normalized path
  // (`C:\a\b`) matches a root that could be written with either style.
  return t.startsWith(r + path.sep) || t.startsWith(r + '/')
}

/**
 * Slice file content to a 1-indexed `[start, end]` range (end `-1` means end of file).
 */
function applyViewRange(
  fileContent: string,
  viewRange: [number, number] | undefined
): { content: string; initLine: number } {
  if (!viewRange) {
    return { content: fileContent, initLine: 1 }
  }
  const lines = fileContent.split('\n')
  const nLines = lines.length
  const [start, end] = viewRange

  if (start < 1 || start > nLines) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its first element \`${start}\` should be within the range of lines of the file: [1, ${nLines}]`
    )
  }
  if (end !== -1 && end > nLines) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its second element \`${end}\` should be smaller than the number of lines in the file: \`${nLines}\``
    )
  }
  if (end !== -1 && end < start) {
    throw new Error(
      `Invalid \`view_range\`: [${start}, ${end}]. Its second element \`${end}\` should be larger or equal than its first \`${start}\``
    )
  }

  const content = end === -1 ? lines.slice(start - 1).join('\n') : lines.slice(start - 1, end).join('\n')
  return { content, initLine: start }
}

/**
 * Perform a `str_replace` and return `{ newContent, snippet, startLine, count }`.
 *
 * Requires exactly one match unless `replaceAll` is true, and runs a
 * projected-size preflight before allocating the substituted string.
 *
 * @throws Error when `oldStr` does not appear, appears more than once
 *   without `replaceAll`, or the substitution would exceed `maxSize`.
 */
function buildStrReplaceResult(
  originalContent: string,
  oldStr: string,
  newStr: string | undefined,
  filePath: string,
  replaceAll: boolean,
  maxSize: number
): {
  newContent: string
  snippets: Array<{ snippet: string; startLine: number }>
  count: number
  omitted: number
} {
  const newStrValue = newStr ?? ''

  // Empty old_str would make the indexOf walk below never advance; the
  // handleStrReplace caller already rejects this, but keep the invariant local.
  if (oldStr.length === 0) {
    throw new Error('old_str must not be empty')
  }

  // Walk non-overlapping matches once so occurrence count, error-line
  // reporting, and snippet anchoring all come from the same positions.
  const positions: number[] = []
  {
    let cursor = 0
    while (cursor <= originalContent.length) {
      const found = originalContent.indexOf(oldStr, cursor)
      if (found === -1) break
      positions.push(found)
      cursor = found + oldStr.length
    }
  }
  const occurrences = positions.length

  if (occurrences === 0) {
    throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`)
  }
  if (occurrences > 1 && !replaceAll) {
    const reported = positions.slice(0, MAX_REPORTED_MATCH_LINES)
    const lineNumbers = reported.map((pos) => originalContent.slice(0, pos).split('\n').length)
    const ellipsis = occurrences > MAX_REPORTED_MATCH_LINES ? '...' : ''
    throw new Error(
      `No replacement was performed. ${occurrences} occurrences of old_str \`${oldStr}\` on lines ${JSON.stringify(lineNumbers)}${ellipsis}. Pass replace_all=true to replace every occurrence, or make old_str unique.`
    )
  }

  // Project the exact output size before allocating the substituted string so
  // a pathological `replace_all` (many small matches, large replacement)
  // cannot trigger a multi-terabyte buffer. `String.prototype.replace` never
  // re-runs itself, so the arithmetic is exact.
  const count = replaceAll ? occurrences : 1
  const projected =
    Buffer.byteLength(originalContent, 'utf-8') +
    count * (Buffer.byteLength(newStrValue, 'utf-8') - Buffer.byteLength(oldStr, 'utf-8'))
  if (projected > maxSize) {
    throw new Error(
      `The edit would produce a ${projected}-byte file at ${filePath}, exceeding the maximum allowed size of ${maxSize} bytes.`
    )
  }

  // Single replacement uses a replacer function so `$&`/`$1`/`$$` in newStr
  // survive verbatim (String.prototype.replace with a string would interpret
  // them). replace_all is a plain split/join for the same reason.
  const newContent = replaceAll
    ? originalContent.split(oldStr).join(newStrValue)
    : originalContent.replace(oldStr, () => newStrValue)

  const insertedLines = newStrValue.split('\n').length
  const originalLines = oldStr.split('\n').length
  const lineDifference = insertedLines - originalLines

  const newLines = newContent.split('\n')
  // One snippet per replaced site, capped so a many-match file does not flood
  // the model. Each site's line number must account for shifts introduced by
  // earlier replacements, hence the running `k * lineDifference` offset.
  const activePositions = positions.slice(0, count)
  const snippetCap = replaceAll ? MAX_REPLACE_ALL_SNIPPETS : 1
  const snippetsToShow = activePositions.slice(0, snippetCap)
  const snippets = snippetsToShow.map((pos, index) => {
    const replacementLine = originalContent.substring(0, pos).split('\n').length - 1
    const lineInNew = replacementLine + index * lineDifference
    const startLine = Math.max(0, lineInNew - SNIPPET_LINES)
    const endLine = Math.min(newLines.length, lineInNew + SNIPPET_LINES + lineDifference + 1)
    return { snippet: newLines.slice(startLine, endLine).join('\n'), startLine }
  })
  const omitted = count - snippets.length

  return { newContent, snippets, count, omitted }
}

/**
 * Insert text at a 0-indexed line and return `{ newContent, snippet, startLine }`.
 *
 * @throws Error when `insertLine` is out of bounds.
 */
function buildInsertResult(
  originalContent: string,
  insertLine: number,
  newStr: string
): { newContent: string; snippet: string; startLine: number } {
  const fileTextLines = originalContent.split('\n')
  const nLines = fileTextLines.length

  if (insertLine < 0 || insertLine > nLines) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${nLines}]`
    )
  }

  const newStrLines = newStr.split('\n')
  const newFileTextLines =
    originalContent === ''
      ? newStrLines
      : [...fileTextLines.slice(0, insertLine), ...newStrLines, ...fileTextLines.slice(insertLine)]

  const newContent = newFileTextLines.join('\n')
  const snippetStartLine = Math.max(0, insertLine - SNIPPET_LINES)
  const snippetEndLine = Math.min(newFileTextLines.length, insertLine + newStrLines.length + SNIPPET_LINES)
  const snippet = newFileTextLines.slice(snippetStartLine, snippetEndLine).join('\n')

  return { newContent, snippet, startLine: snippetStartLine }
}

/**
 * Format file content with cat-n-style line numbers.
 */
function makeOutput(fileContent: string, fileDescriptor: string, initLine: number = 1): string {
  const expandedContent = fileContent.replace(/\t/g, '        ')

  const numberedLines = expandedContent.split('\n').map((line, index) => {
    const lineNum = index + initLine
    return `${lineNum.toString().padStart(6)}  ${line}`
  })

  return `Here's the result of running \`cat -n\` on ${fileDescriptor}:\n${numberedLines.join('\n')}\n`
}

/**
 * Return every 0-indexed line where `searchText` matches, capped at `cap` hits.
 *
 * When `fuzzy` is true, runs of whitespace in both the search text and each
 * line are collapsed to a single space before a case-insensitive substring
 * match — so `"foo bar"` matches `"foo   bar"` or `"foo\tbar"` but not
 * `"foo xyz bar"`.
 */
function findLineNumbers(content: string, searchText: string, fuzzy: boolean, cap: number): number[] {
  const lines = content.split('\n')
  const hits: number[] = []
  // Empty search text would make the plain substring branch match every line
  // (`''.includes(..)` is always true); align the fuzzy branch to the same rule.
  if (searchText === '') return hits
  if (fuzzy) {
    const needle = collapseWhitespace(searchText).toLowerCase()
    if (needle === '') return hits
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line === undefined) continue
      if (collapseWhitespace(line).toLowerCase().includes(needle)) {
        hits.push(index)
        if (hits.length >= cap) break
      }
    }
  } else {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line !== undefined && line.includes(searchText)) {
        hits.push(index)
        if (hits.length >= cap) break
      }
    }
  }
  return hits
}

function collapseWhitespace(text: string): string {
  return text.trim().split(/\s+/).join(' ')
}

// ---- Undo history bookkeeping ----

/**
 * Rebuild an `UndoEntry` from a serialized `appState` entry, or `null` when the
 * entry is missing or structurally invalid. Returning `null` for malformed
 * state keeps `undo_edit` from silently writing an empty string to the file.
 */
function undoEntryFromState(raw: unknown): UndoEntry | null {
  if (raw !== null && typeof raw === 'object' && 'content' in raw) {
    const content = (raw as { content: unknown }).content
    const size = (raw as { size?: unknown }).size
    if (typeof content !== 'string') return null
    return {
      content,
      size: typeof size === 'number' ? size : Buffer.byteLength(content, 'utf-8'),
    }
  }
  if (typeof raw === 'string') {
    return { content: raw, size: Buffer.byteLength(raw, 'utf-8') }
  }
  return null
}

/**
 * Apply an undo-history update to `appState` with no await between read and write.
 *
 * `snapshot === undefined` clears any entry for `filePath` (`create` and
 * `undo_edit`); a string stores it as the pre-edit snapshot. The read of
 * `appState.get` and the matching `appState.set` run back-to-back without an
 * `await` in between, so two concurrent `fileEditor` calls serialize on the
 * event loop at the state write and cannot drop each other's snapshots.
 *
 * Callers must invoke this only *after* the corresponding sandbox write has
 * succeeded so a failed write does not overwrite a still-valid earlier entry.
 */
function commitUndoUpdate(
  appState: StateStore,
  stateKey: string,
  filePath: string,
  snapshot: string | undefined,
  maxEntries: number,
  maxBytes: number
): void {
  if (maxEntries <= 0) return
  const rawHistory = (appState.get(stateKey) as Record<string, unknown> | undefined) ?? {}
  // Null-prototype object defends against a `__proto__` key sneaking in as an
  // edit target; state round-trips plain objects, so re-wrap on load. Skip
  // keys that would land on `Object.prototype` (`__proto__`, `constructor`,
  // `hasOwnProperty`, …) rather than carrying them forward.
  const undoHistory = Object.create(null) as Record<string, UndoEntry>
  for (const key of Object.keys(rawHistory)) {
    if (key === '__proto__') continue
    const entry = undoEntryFromState(rawHistory[key])
    if (entry !== null) undoHistory[key] = entry
  }

  if (snapshot === undefined) {
    if (!Object.hasOwn(undoHistory, filePath)) return
    delete undoHistory[filePath]
  } else {
    // Delete-then-set so a repeat path moves to the end of insertion order.
    // Path keys are absolute (start with `/` or a drive letter), so no
    // integer-key reordering applies and iteration order equals insertion order.
    if (Object.hasOwn(undoHistory, filePath)) delete undoHistory[filePath]
    const size = Buffer.byteLength(snapshot, 'utf-8')
    undoHistory[filePath] = { content: snapshot, size }
    let totalBytes = 0
    for (const entry of Object.values(undoHistory)) totalBytes += entry.size
    const keys = Object.keys(undoHistory)
    // Preserve the just-inserted entry: an edit whose snapshot alone exceeds
    // `maxBytes` would otherwise evict every older entry and then itself,
    // leaving the user with no undo for a write we already reported as
    // successful. The byte cap is best-effort when a single snapshot is
    // larger than the whole budget.
    let index = 0
    let remaining = keys.length
    while (remaining > 1 && (remaining > maxEntries || totalBytes > maxBytes)) {
      const oldestKey = keys[index]!
      totalBytes -= undoHistory[oldestKey]?.size ?? 0
      delete undoHistory[oldestKey]
      index++
      remaining--
    }
  }

  // Null-prototype on the written-out object too: a plain `{}` would route
  // assignment of a `__proto__` key through `Object.prototype`'s setter and
  // corrupt the prototype chain instead of storing an own property.
  const serialized = Object.create(null) as Record<string, { content: string; size: number }>
  for (const key of Object.keys(undoHistory)) {
    const entry = undoHistory[key]!
    serialized[key] = { content: entry.content, size: entry.size }
  }
  appState.set(stateKey, serialized)
}

// ---- Sandbox-routed I/O helpers ----

/**
 * Return `{ exists, isDir }` for a path by listing its parent through the sandbox.
 *
 * A missing parent or entry becomes `{ exists: false }`; other listing
 * errors (permission, transport) propagate so they are not disguised as
 * non-existence.
 */
async function probeSandboxPath(sandbox: Sandbox, filePath: string): Promise<{ exists: boolean; isDir: boolean }> {
  // Split on the platform's path separator(s): on Windows both `\` and `/`;
  // on POSIX only `/`, because `\` is a legitimate filename character there.
  const segments = filePath.split(PATH_SEP_SPLIT_RE)
  const name = segments.pop() ?? ''
  const parent = segments.join('/') || '/'
  try {
    const entry = (await sandbox.listFiles(parent)).find((e) => e.name === name)
    if (!entry) {
      return { exists: false, isDir: false }
    }
    return { exists: true, isDir: entry.isDir ?? false }
  } catch (err) {
    if (err instanceof SandboxPathNotFoundError) {
      return { exists: false, isDir: false }
    }
    throw err
  }
}

/**
 * Read text through the sandbox, rejecting binary files and oversize inputs.
 *
 * Reads raw bytes first so the size cap and encoding detection run before
 * UTF-8 decoding — a corrupted UTF-8 error is worse than a clean rejection.
 * UTF-16 BOMs are detected up front so a valid UTF-16 file is reported as an
 * unsupported encoding rather than misclassified as binary. Otherwise the
 * classic NUL-in-first-8-KB heuristic identifies binary content.
 */
async function readTextOrRejectBinary(sandbox: Sandbox, filePath: string, maxSize: number): Promise<string> {
  const raw = await sandbox.readFile(filePath)
  if (raw.byteLength > maxSize) {
    throw new Error(`File size (${raw.byteLength} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
  }
  if (raw.byteLength >= 2 && ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) {
    throw new Error(`Refusing to read non-UTF-8 file (detected UTF-16 BOM): ${filePath}`)
  }
  const scanLen = Math.min(raw.byteLength, 8192)
  for (let index = 0; index < scanLen; index++) {
    if (raw[index] === 0) {
      throw new Error(`Refusing to read binary file: ${filePath}`)
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(raw)
  } catch (error) {
    throw new Error(`Refusing to read non-UTF-8 file: ${filePath}`, { cause: error })
  }
}

/**
 * List directory contents up to 2 levels deep through the sandbox, excluding hidden files.
 */
async function listDirectory(sandbox: Sandbox, dirPath: string): Promise<string> {
  const items: string[] = []

  async function walk(currentPath: string, prefix: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await sandbox.listFiles(currentPath)
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      items.push(relativePath)

      if (entry.isDir && depth < MAX_DIRECTORY_DEPTH) {
        await walk(`${currentPath}/${entry.name}`, relativePath, depth + 1)
      }
    }
  }

  await walk(dirPath, '', 0)

  const result = items.sort().join('\n')
  return `Here's the files and directories up to 2 levels deep in ${dirPath}, excluding hidden items:\n${result}\n`
}

// ---- Sandbox-path handlers ----

async function handleView(
  sandbox: Sandbox,
  filePath: string,
  viewRange: [number, number] | undefined,
  maxSize: number
): Promise<string> {
  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }

  if (isDir) {
    if (viewRange) {
      throw new Error('The `view_range` parameter is not allowed when `path` points to a directory.')
    }
    return listDirectory(sandbox, filePath)
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)
  const { content, initLine } = applyViewRange(fileContent, viewRange)
  return makeOutput(content, filePath, initLine)
}

/**
 * Reject a replacement payload whose UTF-8 length would exceed `maxSize`.
 * Mirrors the read-side cap on the write side so a model cannot ship an
 * unbounded `new_str` or `file_text` through the tool.
 */
function rejectOversizeReplacement(text: string | undefined, maxSize: number, label = 'new_str'): void {
  if (text === undefined) return
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes > maxSize) {
    throw new Error(`${label} (${bytes} bytes) exceeds maximum allowed size (${maxSize} bytes)`)
  }
}

/**
 * Handle the `create` command: write a new file, refusing to overwrite.
 *
 * `create` is intentionally not snapshotted for undo: rolling back a create
 * means deleting the file, which is a different operation from "restore
 * prior content" and is easy for the caller to do themselves. The caller
 * clears any stale snapshot for `filePath` after this returns.
 */
async function handleCreate(sandbox: Sandbox, filePath: string, fileText: string, maxSize: number): Promise<string> {
  if (fileText === undefined) {
    throw new Error('Parameter `file_text` is required for command: create')
  }
  rejectOversizeReplacement(fileText, maxSize, 'file_text')

  const { exists } = await probeSandboxPath(sandbox, filePath)
  if (exists) {
    throw new Error(`File already exists at: ${filePath}. Cannot overwrite files using command \`create\`.`)
  }

  await sandbox.writeText(filePath, fileText)
  return `File created successfully at: ${filePath}`
}

/**
 * Handle the `str_replace` command: replace `oldStr` (unique unless `replaceAll`).
 *
 * Returns `{ message, preEditContent }` so the caller can snapshot the
 * original content into the undo history after this coroutine's final await.
 */
async function handleStrReplace(
  sandbox: Sandbox,
  filePath: string,
  oldStr: string,
  newStr: string | undefined,
  replaceAll: boolean,
  maxSize: number
): Promise<{ message: string; preEditContent: string }> {
  if (oldStr === undefined) {
    throw new Error('Parameter `old_str` is required for command: str_replace')
  }
  if (oldStr === '') {
    throw new Error('Parameter `old_str` must not be empty for command: str_replace')
  }
  if (newStr !== undefined) rejectOversizeReplacement(newStr, maxSize, 'new_str')

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  const { newContent, snippets, count, omitted } = buildStrReplaceResult(
    fileContent,
    oldStr,
    newStr,
    filePath,
    replaceAll,
    maxSize
  )

  await sandbox.writeText(filePath, newContent)

  const suffix = replaceAll && count > 1 ? ` (${count} occurrences replaced)` : ''
  const snippetSections = snippets
    .map(({ snippet, startLine }) => makeOutput(snippet, `a snippet of ${filePath}`, startLine + 1))
    .join('')
  const omittedNote = omitted > 0 ? `(${omitted} additional replacement site(s) not shown.)\n` : ''
  const message = `The file ${filePath} has been edited.${suffix} ${snippetSections}${omittedNote}Review the changes and make sure they are as expected. Edit the file again if necessary.`
  return { message, preEditContent: fileContent }
}

/**
 * Handle the `insert` command: insert text at a 0-indexed line.
 *
 * Returns `{ message, preEditContent }` so the caller can snapshot the
 * original content into the undo history after this coroutine's final await.
 */
async function handleInsert(
  sandbox: Sandbox,
  filePath: string,
  insertLine: number,
  newStr: string,
  maxSize: number
): Promise<{ message: string; preEditContent: string }> {
  if (insertLine === undefined || newStr === undefined) {
    throw new Error('Parameters `insert_line` and `new_str` are required for command: insert')
  }
  rejectOversizeReplacement(newStr, maxSize, 'new_str')

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileText = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  // Project the UTF-8 output size before building the string so an insert
  // that would blow past `maxSize` is rejected without allocating it. One
  // extra newline joins the inserted block to the surrounding content; no
  // separator is added when the file was empty — `buildInsertResult` replaces
  // the content outright in that case.
  const separator = fileText === '' ? 0 : 1
  const projected = Buffer.byteLength(fileText, 'utf-8') + Buffer.byteLength(newStr, 'utf-8') + separator
  if (projected > maxSize) {
    throw new Error(
      `The edit would produce a ${projected}-byte file at ${filePath}, exceeding the maximum allowed size of ${maxSize} bytes.`
    )
  }

  const { newContent, snippet, startLine } = buildInsertResult(fileText, insertLine, newStr)

  await sandbox.writeText(filePath, newContent)

  const message = `The file ${filePath} has been edited. ${makeOutput(snippet, 'a snippet of the edited file', startLine + 1)}Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.`
  return { message, preEditContent: fileText }
}

async function handleFindLine(
  sandbox: Sandbox,
  filePath: string,
  searchText: string,
  fuzzy: boolean,
  maxSize: number
): Promise<string> {
  if (searchText === undefined) {
    throw new Error('Parameter `search_text` is required for command: find_line')
  }

  const { exists, isDir } = await probeSandboxPath(sandbox, filePath)
  if (!exists) {
    throw new Error(`The path ${filePath} does not exist. Please provide a valid path.`)
  }
  if (isDir) {
    throw new Error(`The path ${filePath} is a directory and only the \`view\` command can be used on directories`)
  }

  const fileContent = await readTextOrRejectBinary(sandbox, filePath, maxSize)

  // Scan one past the cap so the handler can distinguish "exactly cap matches"
  // (not truncated) from "cap or more matches" (truncated).
  const rawHits = findLineNumbers(fileContent, searchText, fuzzy, MAX_FIND_LINE_HITS + 1)
  if (rawHits.length === 0) {
    return `No matches for \`${searchText}\` in ${filePath}.`
  }

  const truncated = rawHits.length > MAX_FIND_LINE_HITS
  const hits = truncated ? rawHits.slice(0, MAX_FIND_LINE_HITS) : rawHits
  const lineNumbers = hits.map((index) => index + 1)
  const truncatedNote = truncated ? ` (truncated to first ${MAX_FIND_LINE_HITS} hits)` : ''

  const first = hits[0]!
  const lines = fileContent.split('\n')
  const startLine = Math.max(0, first - SNIPPET_LINES)
  const endLine = Math.min(lines.length, first + SNIPPET_LINES + 1)
  const snippet = lines.slice(startLine, endLine).join('\n')
  return `Found \`${searchText}\` at line(s) ${JSON.stringify(lineNumbers)}${truncatedNote} of ${filePath}.\n${makeOutput(snippet, `a snippet around line ${first + 1} of ${filePath}`, startLine + 1)}`
}
