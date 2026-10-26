"""Sandbox-routed read tool.

Reads a file through a :class:`~strands.sandbox.base.Sandbox`: either one bound
at creation (as the built-in Docker/SSH sandboxes do when vending tools) or the
agent's configured sandbox read from ``tool_context.agent.sandbox`` at call
time. Text files return ``cat -n`` style numbered lines so the model can cite
``path:line``; images (png/jpg/jpeg/gif/webp) and binary documents
(pdf/doc/docx/xls/xlsx) return as media content blocks when ``media`` is on.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...tools.decorator import tool
from ...types.tools import ToolContext, ToolResult
from .._paths import validate_absolute_path

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_READ_DEFAULT_LIMIT = 2000

# Media formats the SDK accepts in tool results, selected by file extension because the sandbox seam
# exposes no MIME metadata. Text-representable document formats (csv, html, txt, md) stay on the
# numbered-lines path, which supports citing and paging. Video is omitted: the SDK's tool results do
# not accept video content.
_IMAGE_EXTENSIONS = ("png", "jpg", "jpeg", "gif", "webp")
_DOCUMENT_FORMATS = ("pdf", "doc", "docx", "xls", "xlsx")

# For images the extension only selects the media path; the signature decides the format. A non-image or
# mislabeled file sent as a success image block poisons history (every later request fails on it).
_IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)

DEFAULT_READ_DESCRIPTION = (
    "Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`; "
    "images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media "
    "you can view directly. Files must use absolute paths."
)


def make_read(
    *,
    media: bool = True,
    sandbox: Sandbox | None = None,
    name: str = "read",
    description: str = DEFAULT_READ_DESCRIPTION,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed ``read`` tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        media: Return images and binary documents as viewable media. Set to
            ``False`` for a model that rejects media blocks, and ``read``
            describes those files in text instead.
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"read"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that reads files through the sandbox.
    """

    @tool(name=name, description=description, context="tool_context")
    async def read_tool(
        path: str,
        tool_context: ToolContext,
        offset: int | None = None,
        limit: int | None = None,
    ) -> str | ToolResult:
        """Read a file. Text returns ``cat -n`` style numbered lines so you can cite ``path:line``.

        Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you
        can view directly.

        Args:
            path: Absolute path to the file.
            tool_context: Injected by the framework. Not user-facing.
            offset: 1-indexed line to start from. Defaults to the first line. Text files only.
            limit: Maximum number of lines to return. Defaults to 2000. Text files only.
        """
        validate_absolute_path(path)
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        extension = _extension(path)

        if extension in _IMAGE_EXTENSIONS:
            data = await active.read_file(path)
            image_format = _sniff_image_format(data)
            if image_format is None:
                raise ValueError(
                    f"{path} has a .{extension} extension but its {len(data)} bytes are not a png, jpeg, gif, "
                    f"or webp image. Identify it with `file`; if it is text, read it with `cat`."
                )
            if not media:
                return _media_placeholder(path, "Image", image_format, len(data))
            return {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"image": {"format": image_format, "source": {"bytes": data}}}],
            }

        if extension in _DOCUMENT_FORMATS:
            data = await active.read_file(path)
            if not media:
                return _media_placeholder(path, "Document", extension, len(data))
            return {
                "toolUseId": tool_context.tool_use["toolUseId"],
                "status": "success",
                "content": [
                    {"document": {"format": extension, "name": _document_name(path), "source": {"bytes": data}}}
                ],
            }

        content = await active.read_text(path)

        lines = content.split("\n")
        start = max(0, (offset - 1) if offset else 0)
        count = limit if limit is not None else _READ_DEFAULT_LIMIT
        window = lines[start : start + count]
        if not window:
            return f"[File has {len(lines)} lines; offset {offset} is past the end.]"

        numbered = _number_lines("\n".join(window), start + 1)
        if start > 0 or start + count < len(lines):
            shown_end = start + len(window)
            numbered += f"\n[Showing lines {start + 1}-{shown_end} of {len(lines)}. Use offset/limit to read more.]"
        return numbered

    return read_tool


read = make_read()
"""Default sandbox-routed ``read`` tool. Reads the sandbox from the agent's context at call time."""


def _number_lines(content: str, start: int) -> str:
    return "\n".join(f"{index + start:>6}\t{line}" for index, line in enumerate(content.split("\n")))


def _extension(path: str) -> str:
    name = re.split(r"[/\\]", path)[-1]
    return name.rpartition(".")[2].lower() if "." in name else ""


def _document_name(path: str) -> str:
    """Sanitize a filename into a model-safe document name.

    Bedrock accepts only alphanumerics, whitespace, hyphens, parentheses, and square brackets
    in document names, with no consecutive whitespace.
    """
    name = re.split(r"[/\\]", path)[-1]
    name = re.sub(r"[^a-zA-Z0-9\s\-()\[\]]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name or "document"


def _sniff_image_format(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return next((fmt for signature, fmt in _IMAGE_SIGNATURES if data.startswith(signature)), None)


def _media_placeholder(path: str, kind: str, media_format: str, size: int) -> str:
    return (
        f"[{kind} file: {path} ({media_format}, {size} bytes). This model cannot view "
        f"{kind.lower()} files, so its contents are not shown. Use shell tools if the file has a "
        f"text-extractable form.]"
    )
