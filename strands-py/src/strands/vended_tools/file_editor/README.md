# File Editor Tool

A filesystem editor for viewing, creating, and editing files. All I/O routes through the agent's configured `Sandbox`, so isolation is a property of the sandbox rather than the tool.

The tool exposes six commands: `view` (file contents with line numbers, or a two-level directory listing), `create` (refuses to overwrite), `str_replace` (exact-match; ambiguous matches require `replace_all=True`), `insert` (0-indexed line insertion), `find_line` (returns every matching line, up to a cap, with optional whitespace-tolerant `fuzzy` matching), and `undo_edit` (single-step, in-memory revert of the most recent edit for a path). Paths must be absolute and free of `..` segments. Binary files and files above the size cap are rejected with a clean error.

Undo history is per calling agent — two agents sharing one editor instance never see each other's snapshots. The pre-edit snapshot is captured only after the write to disk succeeds, so a transient write failure leaves the previous undo entry retryable.

## Usage

```python
from strands import Agent
from strands.vended_tools import file_editor

agent = Agent(tools=[file_editor])
agent("Create a file at /tmp/notes.txt with the contents '# My Notes'")
```

## Customization

`make_file_editor` accepts:

- `root` (`str`, optional): confines every operation to an absolute directory. Confinement is *lexical*: paths are normalized (so `..` segments collapse before the containment check) and must sit inside `root`. The editor does not follow symlinks itself — whether a symlink inside `root` can escape it is governed by the sandbox. On first use, the editor verifies `root` exists in the sandbox via `Sandbox.list_files`; if it does not, the call fails.
- `max_file_size` (`int`, optional): byte cap on files that can be read or written, and on the projected byte size of any edit's output. Defaults to 1 MB.
- `max_undo_entries` (`int`, optional): maximum distinct paths retained in the per-agent in-memory undo history. Defaults to 32.
- `max_undo_bytes` (`int`, optional): approximate byte cap on the per-agent undo history. Defaults to 32 MB.
- `name`, `description`: override the tool's registered name and description.

```python
from strands.vended_tools.file_editor import make_file_editor

editor = make_file_editor(root="/workspace", max_file_size=5 * 1024 * 1024)
```
