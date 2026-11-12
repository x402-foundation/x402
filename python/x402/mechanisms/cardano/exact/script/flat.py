"""Apply data arguments without changing embedded FLAT constants.

FLAT byte strings are aligned to byte boundaries. Prepending application tags
therefore requires rewriting alignment, while preserving the original data CBOR.
The iterative walk also handles large validators without changing Python's global
recursion limit.
"""

from typing import TypeAlias, cast

from pycardano.cbor import cbor2

from ...limits import MAX_CARDANO_SCRIPT_BYTES
from ...utils import decode_cbor

_ConstantType: TypeAlias = "int | tuple[_ConstantType, _ConstantType]"


class _FlatWriter:
    def __init__(self, data: bytes):
        self.bits = "".join(f"{byte:08b}" for byte in data)
        self.position = 0
        self.output: list[str] = []
        self.length = 0

    def read(self, count: int) -> str:
        if self.position + count > len(self.bits):
            raise ValueError("Truncated FLAT script")
        result = self.bits[self.position : self.position + count]
        self.position += count
        return result

    def write(self, bits: str) -> None:
        self.output.append(bits)
        self.length += len(bits)

    def copy(self, count: int) -> int:
        bits = self.read(count)
        self.write(bits)
        return int(bits, 2)

    def integer(self) -> None:
        while self.copy(8) & 128:
            pass

    def align(self) -> None:
        self.write("0" * (7 - self.length % 8) + "1")

    def byte_string(self) -> None:
        if int(self.read(8 - self.position % 8), 2) != 1:
            raise ValueError("Invalid FLAT byte alignment")
        self.align()
        while size := self.copy(8):
            self.write(self.read(size * 8))

    @staticmethod
    def constant_type(tags: list[int]) -> _ConstantType:
        # Parse the prefix type expression without recursive calls.
        stack: list[_ConstantType] = []
        for tag in reversed(tags):
            if tag == 7:
                if len(stack) < 2:
                    raise ValueError("Invalid FLAT constant type")
                function, argument = stack.pop(), stack.pop()
                stack.append((function, argument))
            else:
                stack.append(tag)
        if len(stack) != 1:
            raise ValueError("Invalid FLAT constant type")
        return stack[0]

    def term(self) -> None:
        tasks: list[str | _ConstantType] = ["term"]
        while tasks:
            task = tasks.pop()
            if task == "terms":
                if self.copy(1):
                    tasks.extend(["terms", "term"])
            elif task == "term":
                tag = self.copy(4)
                if tag == 0:
                    self.integer()
                elif tag in (1, 2, 5):
                    tasks.append("term")
                elif tag == 3:
                    tasks.extend(["term", "term"])
                elif tag == 4:
                    tags = []
                    while self.copy(1):
                        tags.append(self.copy(4))
                    tasks.append(self.constant_type(tags))
                elif tag == 6:
                    pass
                elif tag == 7:
                    self.copy(7)
                elif tag == 8:
                    self.integer()
                    tasks.append("terms")
                elif tag == 9:
                    tasks.extend(["terms", "term"])
                else:
                    raise ValueError("Invalid FLAT term tag")
            elif isinstance(task, tuple):
                function, argument = task
                if function == 5:
                    if self.copy(1):
                        tasks.extend([task, argument])
                elif isinstance(function, tuple) and function[0] == 6:
                    tasks.extend([argument, function[1]])
                else:
                    raise ValueError("Invalid FLAT constant type application")
            elif task == 0:
                self.integer()
            elif task in (1, 2, 8):
                self.byte_string()
            elif task == 3:
                pass
            elif task == 4:
                self.copy(1)
            else:
                raise ValueError("Invalid FLAT constant type")

    def parameter(self, data: bytes) -> None:
        self.write("0100110000")  # Constant with type Data.
        self.align()
        for offset in range(0, len(data), 255):
            chunk = data[offset : offset + 255]
            self.write(f"{len(chunk):08b}")
            self.write("".join(f"{byte:08b}" for byte in chunk))
        self.write("00000000")

    def finish(self) -> bytes:
        self.align()
        bits = "".join(self.output)
        return bytes(int(bits[offset : offset + 8], 2) for offset in range(0, len(bits), 8))


def apply_data_parameters(code: bytes, parameters: list[bytes]) -> bytes:
    """Return single-CBOR-wrapped FLAT with ordered Plutus data arguments."""
    if not code or len(code) > MAX_CARDANO_SCRIPT_BYTES:
        raise ValueError("Cardano script exceeds the byte limit")
    # Accept raw, single- and double-CBOR encodings, like the reference SDK.
    for _ in range(2):
        try:
            decoded = decode_cbor(code)
        except ValueError:
            break
        if not isinstance(decoded, bytes):
            break
        code = decoded
    writer = _FlatWriter(code)
    for _ in range(3):
        writer.integer()
    writer.write("0011" * len(parameters))
    writer.term()
    remaining = writer.read(8 - writer.position % 8)
    if int(remaining, 2) != 1 or writer.position != len(writer.bits):
        raise ValueError("Invalid FLAT script padding")
    for parameter in parameters:
        writer.parameter(parameter)
    return cast(bytes, cbor2.dumps(writer.finish()))
