"""CPU tile recognition. One JSON observation on stdin, one proposal on stdout."""
import argparse
import ast
import base64
import hashlib
import io
import json
import sys

MODEL_SHA256 = "4092e8917ee8c2963895d66ba10a97d6ef975c468a95858a8a7bd9e70681b65d"
ALIASES = {
    "bicycle": ["bicycle", "bicycles"], "bridge": ["bridge", "bridges"],
    "bus": ["bus", "buses"], "car": ["car", "cars"],
    "chimney": ["chimney", "chimneys"], "crosswalk": ["crosswalk", "crosswalks"],
    "fire hydrant": ["fire hydrant", "fire hydrants"],
    "motorcycle": ["motorcycle", "motorcycles"], "mountain": ["mountain", "mountains"],
    "palm tree": ["palm tree", "palm trees"], "stairs": ["stairs", "staircase", "staircases"],
    "tractor": ["tractor", "tractors"], "traffic light": ["traffic light", "traffic lights"],
}


def abstain(reason):
    return {"selectedIndices": [], "confidence": 0.0, "abstain": True, "reason": reason}


def recognize(observation, model_path):
    if observation["gridSize"] != 3:
        return abstain("unsupported-grid")
    target = observation["target"].strip().lower()
    canonical = next((label for label, aliases in ALIASES.items() if target in aliases), None)
    if canonical is None:
        return abstain("unsupported-target")
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 4_000_000
    with open(model_path, "rb") as model:
        if hashlib.file_digest(model, "sha256").hexdigest() != MODEL_SHA256:
            raise ValueError("model-integrity")
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    session = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
    metadata = session.get_modelmeta().custom_metadata_map
    names = ast.literal_eval(metadata["names"])
    def normalize(name):
        name = str(name).lower().replace("_", " ").replace("-", " ")
        return {"hydrant": "fire hydrant", "palm": "palm tree", "stair": "stairs"}.get(name, name)
    class_id = next((int(i) for i, name in names.items() if normalize(name) == canonical), None)
    if class_id is None:
        return abstain("unsupported-target")
    size = ast.literal_eval(metadata["imgsz"])
    if size != [640, 640]:
        raise ValueError("model-shape")
    image = Image.open(io.BytesIO(base64.b64decode(observation["image"]["dataBase64"], validate=True))).convert("RGB")
    if image.width < 90 or image.height < 90 or abs(image.width - image.height) > 3:
        raise ValueError("invalid-grid-image")
    eligible = observation.get("changedIndices", list(range(9)))
    batch = []
    for index in eligible:
        x, y = index % 3, index // 3
        tile = image.crop((round(x * image.width / 3), round(y * image.height / 3), round((x + 1) * image.width / 3), round((y + 1) * image.height / 3)))
        # Square RGB tiles use the exported YOLO classifier's 0..1 normalization.
        tile = tile.resize(tuple(size), Image.Resampling.BILINEAR)
        batch.append(np.asarray(tile, dtype=np.float32).transpose(2, 0, 1) / 255.0)
    probabilities = session.run(None, {session.get_inputs()[0].name: np.stack(batch)})[0]
    if probabilities.shape != (len(eligible), 14) or not np.isfinite(probabilities).all() or probabilities.min() < 0 or probabilities.max() > 1 or not np.allclose(probabilities.sum(axis=1), 1, atol=0.01):
        raise ValueError("model-output")
    selected, certainties = [], []
    for index, probs in zip(eligible, probabilities):
        probability = float(probs[class_id])
        positive = probability >= 0.85
        negative = probability <= 0.15 and float(probs.max()) >= 0.85
        if not positive and not negative:
            return abstain("low-confidence")
        if positive:
            selected.append(index)
        certainties.append(probability if positive else 1.0 - probability)
    return {"selectedIndices": selected, "confidence": min(certainties), "abstain": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(12_100_000)
        observation = json.loads(raw)
        print(json.dumps(recognize(observation, args.model), allow_nan=False))
    except Exception:
        # The caller reports a fixed failure code; paths, data and library errors stay private.
        sys.exit(1)
