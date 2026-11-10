#!/usr/bin/env python3
"""Find saved-time GraphQL queries in a signed Instagram Android APK.

The operation ID is derived from the APK's client registry; it is never an
input. The Pando response tree must independently select ``saved_time``.
Requires Java and an apksig JAR for signature verification.
"""

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REGISTRY = "assets/ig4a-instagram-schema_client_persist_ids.json"
PANDO = "assets/ig4a-instagram-schema_pando_flatbuffer_data.bin"
ASSET_LINKS = "https://www.instagram.com/.well-known/assetlinks.json"


def default_java() -> str:
    for path in (
        Path("/opt/homebrew/opt/openjdk@21/bin/java"),
        Path("/opt/homebrew/opt/openjdk/bin/java"),
    ):
        if path.is_file():
            return str(path)
    return shutil.which("java") or "java"


def apk_path(source: Path, temp: Path) -> Path:
    if source.suffix.lower() == ".apk":
        return source
    if source.suffix.lower() != ".xapk":
        raise ValueError("input must be an APK or XAPK")
    with zipfile.ZipFile(source) as archive:
        names = [name for name in archive.namelist() if name.endswith(".apk")]
        names.sort(key=lambda name: (Path(name).name not in ("base.apk", "instagram-base.apk"), name))
        for name in names:
            with archive.open(name) as candidate:
                with zipfile.ZipFile(candidate) as nested:
                    if REGISTRY not in nested.namelist() or PANDO not in nested.namelist():
                        continue
            target = temp / "instagram-base.apk"
            with archive.open(name) as candidate, target.open("wb") as output:
                while chunk := candidate.read(1024 * 1024):
                    output.write(chunk)
            return target
    raise ValueError("XAPK has no base APK with Instagram's query registry")


def trusted_fingerprints(source: str) -> set[str]:
    if source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=20) as response:
            links = json.load(response)
    else:
        links = json.loads(Path(source).read_text())
    fingerprints = set()
    for statement in links:
        target = statement.get("target", {})
        if target.get("package_name") == "com.instagram.android":
            fingerprints.update(
                value.replace(":", "").lower()
                for value in target.get("sha256_cert_fingerprints", [])
            )
    if not fingerprints:
        raise ValueError("asset links contain no Instagram Android signing certificate")
    return fingerprints


def verify(apk: Path, jar: Path, source: str, java: str) -> dict:
    if not jar.is_file():
        raise ValueError(f"apksig JAR missing: {jar}")
    java_source = Path(__file__).with_name("VerifyInstagramApk.java")
    result = subprocess.run(
        [java, "-cp", str(jar), str(java_source), str(apk)],
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise ValueError(f"APK verification failed: {result.stderr.strip() or result.stdout.strip()}")
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    cert = fields.get("CERT_SHA256", "").lower()
    if fields.get("VERIFIED") != "true" or fields.get("package") != "com.instagram.android":
        raise ValueError("APK signature or package verification failed")
    if cert not in trusted_fingerprints(source):
        raise ValueError("APK signer does not match Instagram's asset links")
    return {"version": fields.get("versionName"), "version_code": fields.get("versionCode"), "signer_sha256": cert}


class Pando:
    def __init__(self, data: bytes):
        self.data = data
        self.strings = {}
        for pos in range(0, len(data) - 8, 4):
            length = self.u32(pos)
            if not 1 <= length <= 1024 or pos + 4 + length >= len(data) or data[pos + 4 + length] != 0:
                continue
            try:
                value = data[pos + 4:pos + 4 + length].decode("utf-8")
            except UnicodeDecodeError:
                continue
            if value.isprintable():
                self.strings[pos] = value

    def u32(self, pos: int) -> int:
        return struct.unpack_from("<I", self.data, pos)[0]

    def table(self, pos: int) -> dict:
        try:
            vtable = pos - struct.unpack_from("<i", self.data, pos)[0]
            count, size = struct.unpack_from("<HH", self.data, vtable)
            if vtable < 0 or not 4 <= count <= 150 or count % 2 or not 4 <= size <= 1024 or pos + size > len(self.data):
                return {}
            fields = {}
            for slot in range((count - 4) // 2):
                offset = struct.unpack_from("<H", self.data, vtable + 4 + slot * 2)[0]
                if offset >= size:
                    return {}
                if offset:
                    field = pos + offset
                    target = field + self.u32(field)
                    fields[slot] = {"position": field, "target": target, "u32": self.u32(field), "string": self.strings.get(target)}
            return fields
        except (struct.error, OverflowError):
            return {}

    def vector(self, pos: int) -> list[int]:
        count = self.u32(pos)
        if count > 50000:
            raise ValueError("invalid Pando vector")
        return [pos + 4 + 4 * index + self.u32(pos + 4 + 4 * index) for index in range(count)]

    def find_tables(self, value: int, slot: int = 0) -> list[int]:
        needle = struct.pack("<I", value)
        result = set()
        offset = 0
        while (hit := self.data.find(needle, offset)) >= 0:
            offset = hit + 1
            for pos in range(max(0, hit - 64), hit + 1, 4):
                if self.table(pos).get(slot, {}).get("position") == hit:
                    result.add(pos)
        return sorted(result)

    def fields_and_paths(self, pos: int, prefix: str = "", active: frozenset[int] = frozenset()) -> list[dict]:
        if pos in active:
            return []
        fields = self.table(pos)
        if 2 not in fields:
            return []
        result = []
        for field_pos in self.vector(fields[2]["target"]):
            field = self.table(field_pos)
            if 2 not in field or not field[2]["string"]:
                continue
            name = field[2]["string"]
            path = f"{prefix}.{name}" if prefix else name
            result.append({"path": path, "parent_type": fields.get(4, {}).get("string"), "args": field.get(1, {}).get("string")})
            child = field.get(4, {}).get("target")
            if child is not None and self.table(child).get(4, {}).get("string"):
                result.extend(self.fields_and_paths(child, path, active | {pos}))
        return result

    def operation(self, entry: dict) -> dict:
        operation_tables = self.find_tables(int(entry["operation_name_hash"]), 3)
        if len(operation_tables) != 1:
            raise ValueError(f"ambiguous operation metadata for {entry['operation_name']}")
        operation = self.table(operation_tables[0])
        variables = []
        if 2 in operation:
            for pos in self.vector(operation[2]["target"]):
                field = self.table(pos)
                variables.append({"name": field.get(0, {}).get("string"), "client_default_literal": field.get(1, {}).get("string")})
        roots = [pos for pos in self.find_tables(operation[0]["u32"]) if self.table(pos).get(4, {}).get("string")]
        if len(roots) != 1:
            raise ValueError(f"ambiguous response root for {entry['operation_name']}")
        return {"name": entry["operation_name"], "client_doc_id": entry["client_doc_id"], "variables": variables, "fields": self.fields_and_paths(roots[0])}


def discover(apk: Path, inspect_queries: list[str]) -> dict:
    with zipfile.ZipFile(apk) as archive:
        registry = json.loads(archive.read(REGISTRY))
        pando = Pando(archive.read(PANDO))
    matches = []
    for name, entry in registry.items():
        if not re.search("save", name, re.I) or not name.endswith("Query"):
            continue
        operation = pando.operation(entry)
        paths = [field for field in operation.pop("fields") if field["path"].endswith("saved_time")]
        if paths:
            operation["saved_time_paths"] = paths
            matches.append(operation)
    if not matches:
        raise ValueError("no Saved query selects saved_time in this client")
    inspected = []
    for name in inspect_queries:
        if name not in registry:
            raise ValueError(f"query absent from this client: {name}")
        inspected.append(pando.operation(registry[name]))
    return {"registry_count": len(registry), "matches": matches, "inspected": inspected}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path, help="verified Instagram base APK or XAPK")
    parser.add_argument("--apksig-jar", type=Path, required=True, help="Android apksig JAR")
    parser.add_argument("--java", default=default_java(), help="Java runtime executable")
    parser.add_argument("--assetlinks", default=ASSET_LINKS, help="Instagram assetlinks URL or saved JSON file")
    parser.add_argument("--output", type=Path, help="write the discovery result as JSON")
    parser.add_argument("--inspect-query", action="append", default=[], help="also list selected field paths for a named client operation")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="instagram-query-discovery-") as directory:
        apk = apk_path(args.apk, Path(directory))
        signature = verify(apk, args.apksig_jar, args.assetlinks, args.java)
        result = {"apk_sha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "signature": signature, **discover(apk, args.inspect_query)}
    serialized = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(serialized)
    print(serialized, end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"discovery failed: {error}", file=sys.stderr)
        raise SystemExit(1)
