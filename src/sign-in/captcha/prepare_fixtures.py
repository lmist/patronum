"""Fetch 18 labeled validation tiles by ZIP byte ranges; create offline grids."""
import base64
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

REVISION = "03c5599eba46e993fd3ff79433c03a327d2d43a3"
URL = f"https://huggingface.co/datasets/DannyLuna/recaptcha-57k-images-dataset/resolve/{REVISION}/dataset_cls_full_57k.zip"
OUTPUT = Path("data/captcha/fixtures")


def read_range(start, end):
    data = subprocess.check_output(["curl", "-fsSL", "--max-time", "45", "--max-filesize", str(end - start + 1), "--range", f"{start}-{end}", f"{URL}?range={start}-{end}"])
    if len(data) != end - start + 1:
        raise ValueError("Unexpected range response")
    return data


def main():
    from PIL import Image
    OUTPUT.mkdir(parents=True, exist_ok=True)
    central = read_range(1429303383, 1437468596)
    offset, entries = 0, []
    while central[offset:offset + 4] == b"PK\x01\x02":
        values = struct.unpack("<4s6H3L5H2L", central[offset:offset + 46])
        name = central[offset + 46:offset + 46 + values[10]].decode()
        if "/val/" in name and values[9]:
            entries.append({"name": name, "method": values[4], "crc32": values[7], "compressed": values[8], "size": values[9], "offset": values[16]})
        offset += 46 + values[10] + values[11] + values[12]
    selected = []
    for label in ["Bus", "Bicycle", "Car", "Crosswalk", "Hydrant", "Traffic Light"]:
        selected.extend([entry for entry in entries if f"/val/{label}/" in entry["name"]][:3])

    def download(entry):
        # Local headers may include extra data; first read fixes the payload offset.
        header = read_range(entry["offset"], entry["offset"] + 29)
        values = struct.unpack("<4s5H3L2H", header)
        start = entry["offset"] + 30 + values[9] + values[10]
        compressed = read_range(start, start + entry["compressed"] - 1)
        image = zlib.decompress(compressed, -15) if entry["method"] == 8 else compressed
        if len(image) != entry["size"] or zlib.crc32(image) != entry["crc32"]:
            raise ValueError("Invalid ZIP member")
        label = entry["name"].split("/")[2]
        filename = hashlib.sha256(image).hexdigest() + Path(entry["name"]).suffix.lower()
        (OUTPUT / filename).write_bytes(image)
        return {"label": label, "source": entry["name"], "file": filename, "sha256": hashlib.sha256(image).hexdigest()}

    with ThreadPoolExecutor(max_workers=3) as pool:
        tiles = list(pool.map(download, selected))
    grid_indices = [[0, 3, 6, 9, 1, 12, 15, 2, 4], [3, 0, 6, 9, 4, 12, 15, 5, 1], [0, 3, 6, 9, 1, 12, 15, 4, 7, 10, 13, 16, 2, 5, 8, 11]]
    fixtures = []
    for number, indices in enumerate(grid_indices):
        grid_size = 4 if number == 2 else 3
        grid = Image.new("RGB", (100 * grid_size, 100 * grid_size))
        for index, tile_index in enumerate(indices):
            image = Image.open(OUTPUT / tiles[tile_index]["file"]).convert("RGB").resize((100, 100))
            grid.paste(image, ((index % grid_size) * 100, (index // grid_size) * 100))
        png = io.BytesIO()
        grid.save(png, format="PNG")
        image_file = f"grid-{number + 1}.png"
        (OUTPUT / image_file).write_bytes(png.getvalue())
        target = "bicycles" if number == 1 else "buses"
        target_label = "Bicycle" if number == 1 else "Bus"
        expected = [index for index, tile_index in enumerate(indices) if tiles[tile_index]["label"] == target_label]
        observation = {"id": f"public-validation-{number + 1}", "round": 0, "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "gridSize": grid_size, "kind": "selection", "target": target, "image": {"mimeType": "image/png", "dataBase64": base64.b64encode(png.getvalue()).decode()}}
        observation_file = f"grid-{number + 1}.json"
        (OUTPUT / observation_file).write_text(json.dumps(observation))
        fixtures.append({"observation": observation_file, "image": image_file, "target": target, "expectedIndices": expected, "tiles": indices})
    manifest = {"dataset": "DannyLuna/recaptcha-57k-images-dataset", "revision": REVISION, "license": "MIT per dataset card", "split": "val", "independentHeldOut": False, "limitation": "Public dataset associated with model training; overlap unknown. Tiny deterministic sample, not an independent accuracy benchmark.", "tiles": tiles, "fixtures": fixtures}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"tiles": len(tiles), "fixtures": fixtures}))


if __name__ == "__main__":
    main()
