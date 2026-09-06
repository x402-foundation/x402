import fnmatch
import re
from typing import Union


def path_is_match(path: Union[str, list[str]], request_path: str) -> bool:
    """
    Check if request path matches the specified path pattern(s).

    Supports:
    - Exact matching: "/api/users"
    - Glob patterns: "/api/users/*", "/api/*/profile"
    - Regex patterns (prefix with 'regex:'): "regex:^/api/users/\\d+$"
    - List of any of the above

    Args:
        path: Path pattern(s) to match against. Can be a string or list of strings.
        request_path: The actual request path to check.

    Returns:
        bool: True if the request path matches any of the patterns, False otherwise.
    """

    def single_path_match(pattern: str) -> bool:
        # Regex pattern
        if pattern.startswith("regex:"):
            regex_pattern = pattern[6:]  # Remove 'regex:' prefix
            return bool(re.match(regex_pattern, request_path))

        # Glob pattern (contains * or ?)
        elif "*" in pattern or "?" in pattern:
            return fnmatch.fnmatch(request_path, pattern)

        # Exact match
        else:
            return pattern == request_path

    if isinstance(path, str):
        return single_path_match(path)
    elif isinstance(path, list):
        return any(single_path_match(p) for p in path)

    return False
