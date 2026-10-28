"""Harness-authored tools.

Thin, self-contained tools that fill gaps in the SDK's vended set. The ``read``, ``write``, and
``edit`` filesystem tools are re-exported from ``strands.vended_tools`` so consumers can import them
either from the SDK directly or from this sub-package.
"""

from strands.vended_tools import edit, make_read, make_write, read, write

from strands_harness.tools.programmatic_tool_caller import (
    DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
    make_programmatic_tool_caller,
    programmatic_tool_caller,
)
from strands_harness.tools.subagent import (
    AgentSpec,
    Choice,
    Fixed,
    Inherit,
    Open,
    Option,
    Preset,
    make_subagent,
)
from strands_harness.tools.web_fetch import make_web_fetch
from strands_harness.tools.web_search import exa_web_search, make_exa_web_search

__all__ = [
    "DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION",
    "AgentSpec",
    "Choice",
    "Fixed",
    "Inherit",
    "Open",
    "Option",
    "Preset",
    "edit",
    "exa_web_search",
    "make_exa_web_search",
    "make_programmatic_tool_caller",
    "make_read",
    "make_subagent",
    "make_web_fetch",
    "make_write",
    "programmatic_tool_caller",
    "read",
    "write",
]
